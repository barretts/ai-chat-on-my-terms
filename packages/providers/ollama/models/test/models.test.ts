import { describe, expect, it } from "vitest";
import { createHttpTransport, type FetchLike } from "@locallab/network-http";
import { OllamaModelService } from "../src/index.js";

const origin = "http://127.0.0.1:11434";
const enc = new TextEncoder();
function service(fetch: FetchLike) {
  const transport = createHttpTransport({
    fetch,
    policy: { authorizedOrigins: [origin], cleartextLanOrigins: [origin] },
  });
  return new OllamaModelService({
    transport,
    resolveConnection: async () => ({ baseUrl: origin }),
    createOperationId: () => "pull-1",
  });
}
function stream(value: string) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(value));
        controller.close();
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
}

describe("Ollama model lifecycle", () => {
  it("preserves complete plain text HTTP errors for inventory, pull and delete", async () => {
    const raw = "Publisher failure: " + "x".repeat(20_000) + "http-tail";
    const api = service(
      async () =>
        new Response(raw, {
          status: 503,
          statusText: "Fixture failure",
          headers: { "content-type": "text/plain" },
        }),
    );
    await expect(api.inventory("conn", "qwen3:8b")).rejects.toThrow(raw);
    await expect(api.delete("conn", "qwen3:8b")).rejects.toThrow(raw);
    const failure = await api.pull("conn", "qwen3:8b").result;
    expect(failure.status).toBe("failed");
    expect(failure.error).toContain(raw);
    expect(failure.error).toContain("HTTP 503 Fixture failure");
    expect(failure.error).toContain("text/plain");
  });

  it("preserves structured pull errors without a message and their full envelope", async () => {
    const raw = JSON.stringify({
      error: { code: "publisher_unavailable", retry_after: 37 },
      request_id: "fixture-request",
      cause: { policy: "publisher explanation" },
      details: "x".repeat(9_000) + "stream-tail",
    });
    const failure = await service(async () => stream(raw + "\n")).pull(
      "conn",
      "qwen3:8b",
    ).result;
    expect(failure.status).toBe("failed");
    expect(failure.error).toContain(raw);
  });

  it("includes malformed inventory and pull progress bodies in their errors", async () => {
    const raw = "invalid-json" + "x".repeat(9_000) + "malformed-tail";
    await expect(
      service(async () => new Response(raw)).inventory("conn", "qwen3:8b"),
    ).rejects.toThrow(raw);
    const failure = await service(async () => stream(raw + "\n")).pull(
      "conn",
      "qwen3:8b",
    ).result;
    expect(failure.status).toBe("failed");
    expect(failure.error).toContain(raw);
  });

  it("pulls with progress and reports installed, loaded and selected independently", async () => {
    const fetch: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/pull") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "qwen3:8b",
          stream: true,
        });
        return stream(
          '{"status":"downloading","digest":"sha256:x","total":10,"completed":5}\n{"status":"success"}\n',
        );
      }
      if (url.pathname === "/api/tags")
        return Response.json({
          models: [
            {
              name: "qwen3:8b",
              size: 40,
              digest: "sha256:x",
              details: {
                families: ["qwen"],
                parameter_size: "8B",
                quantization_level: "Q4_K_M",
              },
            },
          ],
        });
      if (url.pathname === "/api/ps")
        return Response.json({
          models: [{ name: "qwen3:8b", expires_at: "2026-09-26T12:00:00Z" }],
        });
      throw new Error(`unexpected URL ${url}`);
    };
    const api = service(fetch);
    const pull = api.pull("conn", "qwen3:8b");
    expect((await pull.result).status).toBe("completed");
    expect(pull.progress.progress).toBeUndefined(); // terminal success has no byte counter
    const [model] = await api.inventory("conn", "qwen3:8b");
    expect(model).toMatchObject({
      installed: true,
      loaded: true,
      selected: true,
      sizeBytes: 40,
      parameterSize: "8B",
      quantizationLevel: "Q4_K_M",
    });
  });

  it("cancellation leaves inventory unchanged and releases the pull lock", async () => {
    let cancelStream!: () => void;
    const fetch: FetchLike = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/pull")
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                enc.encode(
                  '{"status":"downloading","total":100,"completed":10}\n',
                ),
              );
              cancelStream = () => controller.close();
            },
            cancel() {},
          }),
          { headers: { "content-type": "application/x-ndjson" } },
        );
      if (path === "/api/tags") return Response.json({ models: [] });
      if (path === "/api/ps") return Response.json({ models: [] });
      throw new Error(`unexpected URL ${path}`);
    };
    const api = service(fetch);
    const pull = api.pull("conn", "new-model");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pull.progress).toMatchObject({
      status: "running",
      completed: 10,
      progress: 0.1,
    });
    pull.cancel();
    expect(await pull.result).toEqual({ status: "canceled" });
    expect(await api.inventory("conn", "new-model")).toEqual([]);
    expect(cancelStream).toBeTypeOf("function");
    const retry = api.pull("conn", "new-model");
    expect(retry.model).toBe("new-model");
    retry.cancel();
    expect(await retry.result).toEqual({ status: "canceled" });
  });

  it("surfaces delete errors without changing caller selection and rejects simultaneous use/pull", async () => {
    const api = service(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/delete")
        return Response.json({ error: "model is in use" }, { status: 500 });
      return Response.json({ models: [] });
    });
    await expect(api.delete("conn", "qwen3:8b")).rejects.toThrow(
      "model is in use",
    );
    let release!: () => void;
    const use = api.withModelUse(
      "conn",
      "qwen3:8b",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(() => api.pull("conn", "qwen3:8b")).toThrow("in use");
    release();
    await use;
  });
});
