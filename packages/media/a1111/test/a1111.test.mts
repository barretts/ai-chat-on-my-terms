import assert from "node:assert/strict";
import test from "node:test";
import { MediaBackendError, type MediaSnapshot } from "@locallab/media-engine";
import {
  A1111Client,
  A1111MediaBackend,
  snapshotParams,
  type A1111GenerationParams,
} from "../src/index.js";

type Init = {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};
type ResponseLike = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};
type FetchLike = (url: string, init?: Init) => Promise<ResponseLike>;

type Call = { url: string; method: string; body?: Record<string, unknown> };

function fixture(
  route: (url: string, init: Init | undefined, call: number) => unknown,
) {
  const calls: Call[] = [];
  let n = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    n++;
    calls.push({
      url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) as Record<string, unknown> }
        : {}),
    });
    const body = route(url, init, n);
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

const ok = (value: unknown): ResponseLike => ({
  ok: true,
  status: 200,
  json: async () => value,
});

const params: A1111GenerationParams = {
  prompt: "a red fox",
  negativePrompt: "blurry",
  steps: 30,
  cfgScale: 7,
  width: 768,
  height: 512,
  seed: 42,
  samplerName: "DPM++ 2M",
  checkpoint: "dreamshaper.safetensors",
  enableHr: true,
  hrUpscaler: "4x-UltraSharp",
  hrScale: 1.5,
  denoisingStrength: 0.5,
  restoreFace: true,
};

test("request body maps every applied parameter", () => {
  const client = new A1111Client("http://127.0.0.1:7860", async () => {
    throw new Error("unused");
  });
  assert.deepEqual(client.buildRequestBody(params), {
    prompt: "a red fox",
    negative_prompt: "blurry",
    steps: 30,
    cfg_scale: 7,
    width: 768,
    height: 512,
    seed: 42,
    enable_hr: true,
    restore_faces: true,
    sampler_name: "DPM++ 2M",
    hr_upscaler: "4x-UltraSharp",
    hr_scale: 1.5,
    denoising_strength: 0.5,
    override_settings: { sd_model_checkpoint: "dreamshaper.safetensors" },
  });
});

test("txt2img discovers then posts and decodes images", async () => {
  const png = Buffer.from("fake-png-bytes").toString("base64");
  const fx = fixture((url) => {
    if (url.endsWith("/sd-models"))
      return [{ title: "dreamshaper.safetensors", sha256: null }];
    if (url.endsWith("/samplers")) return [{ name: "DPM++ 2M" }];
    if (url.endsWith("/txt2img")) return { images: [png], info: "seed 42" };
    return {};
  });
  const client = new A1111Client("http://127.0.0.1:7860", fx.fetchImpl);
  const { images, info } = await client.txt2img(params, {});
  assert.equal(Buffer.from(images[0]!).toString(), "fake-png-bytes");
  assert.equal(info, "seed 42");
  assert.deepEqual(
    fx.calls.map((c) => c.url.split("/").slice(5).join("/")),
    ["sd-models", "samplers", "txt2img"],
  );
  const post = fx.calls.find((c) => c.url.endsWith("/txt2img"));
  assert.equal(post?.body?.seed, 42);
  assert.equal(post?.body?.hr_upscaler, "4x-UltraSharp");
  assert.deepEqual(post?.body?.override_settings, {
    sd_model_checkpoint: "dreamshaper.safetensors",
  });
});

test("progress polls while a slow generation runs", async () => {
  const png = Buffer.from("x").toString("base64");
  const progress: number[] = [];
  let pollCalls = 0;
  const client = new A1111Client("http://127.0.0.1:7860", async (url, init) => {
    if (url.endsWith("/progress")) {
      pollCalls++;
      return ok({ progress: 0.6 });
    }
    if (url.endsWith("/txt2img")) {
      await new Promise<void>((_, reject) => {
        const signal = init?.signal!;
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return ok({ images: [png] });
    }
    return ok({});
  });
  const controller = new AbortController();
  const run = client.txt2img(
    { ...params, checkpoint: undefined, samplerName: undefined },
    {
      signal: controller.signal,
      reportProgress: (fraction) => progress.push(fraction),
    },
  );
  await new Promise((r) => setTimeout(r, 1_700));
  assert.ok(pollCalls >= 1 && progress.includes(0.6), "progress polled");
  controller.abort();
  await assert.rejects(run, /aborted/);
});

test("unavailable checkpoint, sampler, or API fail before queueing", async () => {
  const fx = fixture((url) => {
    if (url.endsWith("/sd-models")) return [{ title: "other.safetensors" }];
    if (url.endsWith("/samplers")) return [{ name: "Euler a" }];
    throw new Error("txt2img must not be called");
  });
  const client = new A1111Client("http://127.0.0.1:7860", fx.fetchImpl);
  await assert.rejects(
    client.txt2img(params, {}),
    (error: unknown) =>
      error instanceof MediaBackendError &&
      error.failure.code === "missing-model" &&
      /not available/.test(error.failure.message),
  );
  await assert.rejects(
    client.txt2img(
      { ...params, checkpoint: undefined, samplerName: "Bogus" },
      {},
    ),
    (error: unknown) =>
      error instanceof MediaBackendError &&
      error.failure.code === "unsupported",
  );
  assert.ok(!fx.calls.some((c) => c.url.endsWith("/txt2img")));

  const down = new A1111Client("http://127.0.0.1:7860", async () => {
    throw new Error("ECONNREFUSED");
  });
  await assert.rejects(
    down.txt2img({ ...params, checkpoint: undefined }, {}),
    (error: unknown) =>
      error instanceof MediaBackendError &&
      error.failure.code === "offline" &&
      error.failure.recoverable,
  );

  const http500 = new A1111Client("http://127.0.0.1:7860", async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  }));
  await assert.rejects(
    http500.txt2img({ ...params, checkpoint: undefined }, {}),
    (error: unknown) =>
      error instanceof MediaBackendError &&
      error.failure.code === "host-stopped",
  );
});

test("backend port maps snapshots to managed blob refs", async () => {
  const png = Buffer.from("img-bytes").toString("base64");
  const fx = fixture((url) => {
    if (url.endsWith("/samplers")) return [{ name: "DPM++ 2M" }];
    if (url.endsWith("/txt2img")) return { images: [png], info: "" };
    return {};
  });
  const written: { bytes: string; mime: string }[] = [];
  const backend = new A1111MediaBackend(
    new A1111Client("http://127.0.0.1:7860", fx.fetchImpl),
    async (bytes, mime) => {
      written.push({ bytes: Buffer.from(bytes).toString(), mime });
      return `blob-${written.length}`;
    },
  );
  const snapshot: MediaSnapshot = {
    conversationId: "c1",
    prompt: "a red fox",
    inputRefs: [],
    workflowSnapshot: {
      name: "dream",
      definition: {
        steps: 20,
        cfgScale: 6.5,
        width: 512,
        height: 512,
        samplerName: "DPM++ 2M",
      },
    },
    capturedAt: new Date().toISOString(),
  };
  assert.equal(snapshotParams(snapshot).steps, 20);
  const outcome = await backend.generate({
    snapshot,
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
  });
  assert.deepEqual(outcome.outputRefs, ["blob-1"]);
  assert.deepEqual(written, [{ bytes: "img-bytes", mime: "image/png" }]);
  await assert.rejects(
    backend.generate({
      snapshot: {
        ...snapshot,
        workflowSnapshot: { name: "broken", definition: {} },
      },
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
    }),
    (error: unknown) =>
      error instanceof MediaBackendError &&
      error.failure.code === "malformed" &&
      /missing numeric parameter "steps"/.test(error.failure.message),
  );
});
