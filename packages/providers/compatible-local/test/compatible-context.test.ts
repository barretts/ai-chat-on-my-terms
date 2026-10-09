import { describe, expect, it, vi } from "vitest";
import {
  createHttpTransport,
  type HttpTransport,
  type HttpRequestOptions,
} from "@locallab/network-http";
import {
  createCompatibleLocalProvider,
  createCustomCompatiblePreset,
  type CompatibleLocalConnection,
} from "../src/index.js";

const origin = "https://local.example.test";
const connection = createCustomCompatiblePreset(origin);
const selected = "namespace/Qwen:Q4_K_M";

function fixtureTransport(
  models: unknown,
  details: unknown = undefined,
  props: unknown = undefined,
) {
  const calls: Array<{
    url: URL;
    init?: RequestInit;
    options?: HttpRequestOptions;
  }> = [];
  const transport: HttpTransport = {
    async request(input, init, options) {
      const url = new URL(input);
      calls.push({
        url,
        ...(init ? { init } : {}),
        ...(options ? { options } : {}),
      });
      const body =
        url.pathname === "/v1/models"
          ? models
          : url.pathname.startsWith("/v1/models/")
            ? details
            : url.pathname === "/props"
              ? props
              : undefined;
      return new Response(
        body === undefined ? "not found" : JSON.stringify(body),
        {
          status: body === undefined ? 404 : 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
    async *streamSse() {},
  };
  return { transport, calls };
}

function provider(transport: HttpTransport) {
  return createCompatibleLocalProvider({
    transport,
    resolveConnection: async () => connection,
  });
}

describe("configured compatible model context discovery", () => {
  it("uses the selected model's effective max_model_len without additional probes", async () => {
    const fixture = fixtureTransport({
      data: [
        { id: "another-model", max_model_len: 262144 },
        {
          id: selected,
          owned_by: "ninfer",
          max_model_len: 65536,
          meta: { n_ctx_train: 262144 },
        },
      ],
    });
    const adapter = provider(fixture.transport);
    expect(await adapter.listCompatibleModels(connection)).toEqual([
      {
        id: "another-model",
        contextWindowTokens: 262144,
        contextWindowSource: "models",
      },
      {
        id: selected,
        ownedBy: "ninfer",
        contextWindowTokens: 65536,
        contextWindowSource: "models",
        toolsSupported: true,
      },
    ]);
    fixture.calls.length = 0;
    expect(
      await adapter.discoverCompatibleModelContext(connection, selected),
    ).toEqual({
      contextWindowTokens: 65536,
      source: "models",
      toolsSupported: true,
    });
    expect(fixture.calls.map((call) => call.url.pathname)).toEqual([
      "/v1/models",
    ]);
  });

  it("uses exact authenticated model lookup when list metadata is absent", async () => {
    const fixture = fixtureTransport(
      { data: [{ id: selected }] },
      { id: selected, max_model_len: 32768 },
    );
    const credentialRef = "sec_00000000-0000-4000-8000-000000000001" as never;
    const authenticated: CompatibleLocalConnection = {
      ...connection,
      credentialRef,
    };
    const adapter = createCompatibleLocalProvider({
      transport: fixture.transport,
      resolveConnection: async () => authenticated,
      secretStore: {
        async resolveHeaders(host, refs) {
          expect(host).toBe(origin);
          expect(refs).toEqual([credentialRef]);
          return { authorization: "Bearer fixture-only" };
        },
        async put() {
          throw new Error("unused");
        },
        async remove() {},
      },
    });
    expect(
      await adapter.discoverCompatibleModelContext(authenticated, selected),
    ).toEqual({
      contextWindowTokens: 32768,
      source: "models",
    });
    expect(fixture.calls.map((call) => call.url.pathname)).toEqual([
      "/v1/models",
      `/v1/models/${encodeURIComponent(selected)}`,
    ]);
    expect(fixture.calls.every((call) => call.url.origin === origin)).toBe(
      true,
    );
    expect(
      fixture.calls.every(
        (call) =>
          new Headers(call.init?.headers).get("authorization") ===
          "Bearer fixture-only",
      ),
    ).toBe(true);
    expect(fixture.calls[1]?.options?.returnHttpErrors).toBe(true);
  });

  it("uses llama.cpp active per-slot context, preserves model identity and prevents router autoload", async () => {
    const fixture = fixtureTransport(
      { data: [{ id: selected, meta: { n_ctx_train: 262144 } }] },
      undefined,
      {
        model_alias: selected,
        total_slots: 4,
        n_ctx: 65536,
        default_generation_settings: { n_ctx: 16384 },
      },
    );
    expect(
      await provider(fixture.transport).discoverCompatibleModelContext(
        connection,
        selected,
      ),
    ).toEqual({
      contextWindowTokens: 16384,
      source: "llama.cpp-props",
    });
    const url = fixture.calls.at(-1)?.url;
    expect(url?.pathname).toBe("/props");
    expect(url?.searchParams.get("model")).toBe(selected);
    expect(url?.searchParams.get("autoload")).toBe("false");
    expect(fixture.calls.at(-1)?.options?.timeoutMs).toBe(3500);
  });

  it("supports older llama.cpp properties with an exact generation model alias", async () => {
    const fixture = fixtureTransport({ data: [{ id: selected }] }, undefined, {
      default_generation_settings: { model: selected, n_ctx: 8192 },
    });
    expect(
      await provider(fixture.transport).discoverCompatibleModelContext(
        connection,
        selected,
      ),
    ).toEqual({
      contextWindowTokens: 8192,
      source: "llama.cpp-props",
    });
  });

  it.each([
    {
      model_alias: "different-model",
      default_generation_settings: { n_ctx: 65536 },
    },
    { default_generation_settings: { n_ctx: 65536 } },
    {
      model_alias: selected,
      default_generation_settings: { n_ctx_train: 262144 },
    },
  ])("does not use unrelated or training-only properties %#", async (props) => {
    const fixture = fixtureTransport(
      { data: [{ id: selected, meta: { n_ctx_train: 262144 } }] },
      { id: "different-model", max_model_len: 65536 },
      props,
    );
    expect(
      await provider(fixture.transport).discoverCompatibleModelContext(
        connection,
        selected,
      ),
    ).toBeUndefined();
  });

  it.each([0, -1, 1.5, "65536", Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid advertised capacity %s and never guesses from a model name",
    async (capacity) => {
      const id = "Qwen-64K";
      const fixture = fixtureTransport(
        {
          data: [
            { id, max_model_len: capacity, meta: { n_ctx_train: 262144 } },
          ],
        },
        { id, max_model_len: capacity },
        { model_alias: id, default_generation_settings: { n_ctx: capacity } },
      );
      expect(
        await provider(fixture.transport).discoverCompatibleModelContext(
          connection,
          id,
        ),
      ).toBeUndefined();
    },
  );

  it("treats optional 404 and malformed endpoints as unavailable without failing model discovery", async () => {
    const paths: string[] = [];
    const transport = createHttpTransport({
      policy: { authorizedOrigins: [origin] },
      fetch: async (input) => {
        const url = new URL(String(input));
        paths.push(url.pathname);
        if (url.pathname === "/v1/models")
          return Response.json({ data: [{ id: selected }] });
        return new Response(
          url.pathname === "/props" ? "invalid JSON" : "unsupported",
          {
            status: url.pathname === "/props" ? 200 : 404,
          },
        );
      },
    });
    const adapter = provider(transport);
    expect(
      await adapter.discoverCompatibleModelContext(connection, selected),
    ).toBeUndefined();
    expect(await adapter.listModels(connection)).toEqual({
      ok: true,
      value: [selected],
    });
    expect(paths).toContain("/props");
  });

  it("does not probe an unauthorized origin", async () => {
    let fetchCalls = 0;
    const transport = createHttpTransport({
      policy: { authorizedOrigins: [] },
      fetch: async () => {
        fetchCalls += 1;
        return Response.json({});
      },
    });
    expect(
      await provider(transport).discoverCompatibleModelContext(
        connection,
        selected,
      ),
    ).toBeUndefined();
    expect(fetchCalls).toBe(0);
  });

  it("returns within 3.5 seconds even when a response body stalls", async () => {
    vi.useFakeTimers();
    try {
      const transport: HttpTransport = {
        async request() {
          return new Response(new ReadableStream({ start() {} }), {
            status: 200,
          });
        },
        async *streamSse() {},
      };
      const result = provider(transport).discoverCompatibleModelContext(
        connection,
        selected,
      );
      await vi.advanceTimersByTimeAsync(3501);
      expect(await result).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a stalled probe promptly and does not start subsequent requests", async () => {
    let requestCalls = 0;
    const transport: HttpTransport = {
      async request() {
        requestCalls += 1;
        return await new Promise<Response>(() => {});
      },
      async *streamSse() {},
    };
    const controller = new AbortController();
    const result = provider(transport).discoverCompatibleModelContext(
      connection,
      selected,
      controller.signal,
    );
    controller.abort();
    expect(await result).toBeUndefined();
    expect(requestCalls).toBeLessThanOrEqual(1);
  });
});
