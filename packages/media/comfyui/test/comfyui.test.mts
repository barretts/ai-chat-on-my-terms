import assert from "node:assert/strict";
import test from "node:test";
import { MediaBackendError, type MediaSnapshot } from "@locallab/media-engine";
import {
  applyLoras,
  applyPlaceholders,
  ComfyUiClient,
  ComfyUiMediaBackend,
  defaultGraph,
  snapshotParams,
  validateGraph,
  type ComfyGraph,
  type ComfyGenerationParams,
  type ComfySocketLike,
} from "../src/index.js";

const params: ComfyGenerationParams = {
  prompt: "a red fox",
  negativePrompt: "blurry",
  seed: 7,
  steps: 25,
  cfgScale: 6,
  width: 640,
  height: 480,
  samplerName: "dpmpp_2m",
  scheduler: "karras",
  checkpoint: "dreamshaper.safetensors",
  loras: [],
};

test("default graph carries all mapped values", () => {
  const graph = defaultGraph(params);
  assert.equal(graph["1"]?.inputs.ckpt_name, "dreamshaper.safetensors");
  assert.equal(graph["2"]?.inputs.text, "a red fox");
  assert.equal(graph["3"]?.inputs.text, "blurry");
  assert.deepEqual(graph["4"]?.inputs, { width: 640, height: 480, batch_size: 1 });
  assert.deepEqual(graph["5"]?.inputs, {
    model: ["1", 0],
    seed: 7,
    steps: 25,
    cfg: 6,
    sampler_name: "dpmpp_2m",
    scheduler: "karras",
    positive: ["2", 0],
    negative: ["3", 0],
    latent_image: ["4", 0],
  });
});

test("LoRA loaders chain between checkpoint and consumers", () => {
  const { graph, loraNodeIds } = applyLoras(defaultGraph(params), [
    { name: "add-detail.safetensors", strengthModel: 0.8 },
    { name: "more-eyes.safetensors" },
  ]);
  assert.deepEqual(loraNodeIds, ["20", "21"]);
  assert.deepEqual(graph["20"]?.inputs, {
    model: ["1", 0],
    clip: ["1", 1],
    lora_name: "add-detail.safetensors",
    strength_model: 0.8,
    strength_clip: 1,
  });
  assert.deepEqual(graph["21"]?.inputs.model, ["20", 0]);
  assert.equal(graph["21"]?.inputs.strength_model, 1);
  assert.deepEqual(graph["5"]?.inputs.model, ["21", 0]);
  assert.deepEqual(graph["2"]?.inputs.clip, ["21", 1]);
  assert.deepEqual(graph["3"]?.inputs.clip, ["21", 1]);
});

function expectMalformed(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof MediaBackendError);
    assert.equal(error.failure.code, "malformed");
    assert.match(error.failure.message, new RegExp(message));
    return;
  }
  throw new Error(`expected malformed: ${message}`);
}

test("graph validation rejects broken links and missing sinks", () => {
  const broken = {
    a: { class_type: "KSampler", inputs: { model: ["nope", 0] } },
    b: { class_type: "SaveImage", inputs: { images: ["a", 0] } },
  };
  expectMalformed(() => validateGraph(broken), "references missing node");
  expectMalformed(
    () => validateGraph({ a: { class_type: "KSampler", inputs: {} } }),
    "no SaveImage node",
  );
  expectMalformed(() => validateGraph([]), "must be an object");
  const good: unknown = defaultGraph(params);
  assert.equal(validateGraph(good)["1"]?.class_type, "CheckpointLoaderSimple");
});

test("typed placeholders substitute strings and numbers", () => {
  const graph = applyPlaceholders(
    {
      "10": {
        class_type: "KSampler",
        inputs: { seed: "{{seed}}", steps: "{{steps}}", text: "{{positive}}" },
      },
      "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
    } satisfies ComfyGraph,
    params,
  );
  assert.equal(graph["10"]?.inputs.seed, 7);
  assert.equal(graph["10"]?.inputs.steps, 25);
  assert.equal(graph["10"]?.inputs.text, "a red fox");
  expectMalformed(
    () =>
      applyPlaceholders(
        { x: { class_type: "SaveImage", inputs: { q: "{{nope}}" } } },
        params,
      ),
    "unknown placeholder",
  );
});

type FakeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

const jsonResponse = (body: unknown): FakeResponse => ({
  ok: true,
  status: 200,
  json: async () => body,
  arrayBuffer: async () => new ArrayBuffer(0),
});

class FakeSocket implements ComfySocketLike {
  messageHandler?: (data: string) => void;
  closedCount = 0;
  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }
  onClose(): void {}
  close(): void {
    this.closedCount++;
  }
  emit(event: unknown): void {
    this.messageHandler?.(JSON.stringify(event));
  }
}

test("run posts graph, follows progress, returns outputs", async () => {
  const socket = new FakeSocket();
  let historyCalls = 0;
  const urls: string[] = [];
  let postedBody: Record<string, unknown> | undefined;
  const client = new ComfyUiClient("http://127.0.0.1:8188", {
    fetchImpl: async (url, init) => {
      urls.push(url);
      if (url.endsWith("/prompt")) {
        postedBody = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        return jsonResponse({ prompt_id: "p-1" });
      }
      if (url.includes("/history/")) {
        historyCalls++;
        if (historyCalls === 1) {
          socket.emit({ type: "progress", data: { value: 10, max: 20 } });
          return jsonResponse({});
        }
        return jsonResponse({
          "p-1": {
            outputs: { "7": { images: [{ filename: "out_00001.png", subfolder: "" }] } },
          },
        });
      }
      return jsonResponse({});
    },
    socketFactory: async () => socket,
  });
  const progress: number[] = [];
  const result = await client.run(defaultGraph(params), {
    signal: new AbortController().signal,
    reportProgress: (fraction) => progress.push(fraction),
    clientId: "c-1",
  });
  assert.deepEqual(result.outputs, [{ filename: "out_00001.png", subfolder: "" }]);
  assert.deepEqual(progress, [0.5]);
  assert.equal(socket.closedCount, 1);
  assert.equal((postedBody?.prompt as ComfyGraph)["7"]?.class_type, "SaveImage");
  assert.equal(postedBody?.client_id, "c-1");
  assert.ok(urls.some((u) => u.includes("/history/p-1")));
});

test("execution_error events and node_errors become typed failures", async () => {
  const socket = new FakeSocket();
  const client = new ComfyUiClient("http://127.0.0.1:8188", {
    fetchImpl: async (url) => {
      if (url.endsWith("/prompt")) return jsonResponse({ prompt_id: "p-2" });
      socket.emit({
        type: "execution_error",
        data: { exception_message: "CUDA out of memory" },
      });
      return jsonResponse({});
    },
    socketFactory: async () => socket,
  });
  await assert.rejects(
    client.run(defaultGraph(params), {
      signal: new AbortController().signal,
      reportProgress: () => undefined,
      clientId: "c-2",
    }),
    (error: unknown) =>
      error instanceof MediaBackendError &&
      error.failure.code === "host-stopped" &&
      /CUDA out of memory/.test(error.failure.message),
  );

  const rejected = new ComfyUiClient("http://127.0.0.1:8188", {
    fetchImpl: async () =>
      jsonResponse({ prompt_id: "p-3", node_errors: { "5": { errors: [] } } }),
  });
  await assert.rejects(
    rejected.run(defaultGraph(params), {
      signal: new AbortController().signal,
      reportProgress: () => undefined,
      clientId: "c-3",
    }),
    (error: unknown) =>
      error instanceof MediaBackendError && error.failure.code === "malformed",
  );
});

test("output bytes survive binary frames uncorrupted", async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x00, 0xff, 0x01, 0x0d, 0x0a]);
  const client = new ComfyUiClient("http://127.0.0.1:8188", {
    fetchImpl: async (url) => {
      assert.ok(url.includes("/view?"));
      assert.ok(url.includes("filename=out_00001.png"));
      assert.ok(url.includes("subfolder=sub"));
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () =>
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer,
      };
    },
  });
  const fetched = await client.fetchOutput({
    filename: "out_00001.png",
    subfolder: "sub",
  });
  assert.deepEqual([...fetched], [...bytes]);
});

test("backend port maps snapshot through to blob refs", async () => {
  const socket = new FakeSocket();
  let viewCalls = 0;
  const png = Buffer.from("comfy-image");
  const client = new ComfyUiClient("http://127.0.0.1:8188", {
    fetchImpl: async (url) => {
      if (url.endsWith("/prompt")) return jsonResponse({ prompt_id: "p-9" });
      if (url.includes("/history/"))
        return jsonResponse({
          "p-9": {
            outputs: { "7": { images: [{ filename: "a.png", subfolder: "" }] } },
          },
        });
      if (url.includes("/view")) {
        viewCalls++;
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          arrayBuffer: async () =>
            png.buffer.slice(
              png.byteOffset,
              png.byteOffset + png.byteLength,
            ) as ArrayBuffer,
        };
      }
      return jsonResponse({});
    },
    socketFactory: async () => socket,
  });
  const written: string[] = [];
  const backend = new ComfyUiMediaBackend(
    client,
    async (bytes) => {
      written.push(Buffer.from(bytes).toString());
      return `blob-${written.length}`;
    },
    "image/png",
    () => "fixed-client",
  );
  const snapshot: MediaSnapshot = {
    conversationId: "c1",
    prompt: "a blue owl",
    inputRefs: [],
    workflowSnapshot: {
      name: "comfy-default",
      definition: {
        checkpoint: "dreamshaper.safetensors",
        steps: 22,
        cfgScale: 5,
        width: 512,
        height: 512,
        seed: 3,
        samplerName: "euler",
        scheduler: "normal",
        loras: [{ name: "add-detail.safetensors", strengthModel: 0.6 }],
      },
    },
    capturedAt: new Date().toISOString(),
  };
  const { params: mapped } = snapshotParams(snapshot);
  assert.deepEqual(mapped.loras, [
    { name: "add-detail.safetensors", strengthModel: 0.6 },
  ]);
  const reported: string[] = [];
  const outcome = await backend.generate({
    snapshot,
    jobId: "job-1",
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
    reportServerJob: (id) => reported.push(id),
  });
  assert.deepEqual(outcome.outputRefs, ["blob-1"]);
  assert.deepEqual(written, ["comfy-image"]);
  assert.equal(viewCalls, 1);
  assert.deepEqual(reported, ["p-9"], "prompt id reported as server job id");
});

test("resume follows the recorded prompt id without resubmitting", async () => {
  const socket = new FakeSocket();
  const urls: string[] = [];
  const png = Buffer.from("late-part");
  const client = new ComfyUiClient("http://127.0.0.1:8188", {
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith("/prompt"))
        throw new Error("resume must never POST /prompt");
      if (url.includes("/history/"))
        return jsonResponse({
          "p-7": {
            outputs: { "7": { images: [{ filename: "late.png", subfolder: "" }] } },
          },
        });
      if (url.includes("/view"))
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          arrayBuffer: async () =>
            png.buffer.slice(
              png.byteOffset,
              png.byteOffset + png.byteLength,
            ) as ArrayBuffer,
        };
      return jsonResponse({});
    },
    socketFactory: async () => socket,
  });
  const backend = new ComfyUiMediaBackend(
    client,
    async () => "blob-late",
    "image/png",
    () => "rc-1",
  );
  const outcome = await backend.resume({
    serverJobId: "p-7",
    snapshot: {
      conversationId: "c1",
      prompt: "a blue owl",
      inputRefs: [],
      workflowSnapshot: { name: "comfy-default", definition: {} },
      capturedAt: new Date().toISOString(),
    },
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
  });
  assert.deepEqual(outcome.outputRefs, ["blob-late"]);
  assert.ok(urls.some((u) => u.includes("/history/p-7")));
  assert.ok(!urls.some((u) => u.endsWith("/prompt")));
  assert.equal(socket.closedCount, 1);
});
