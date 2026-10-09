import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { HostScopedSecretStore } from "@locallab/security-secrets";
import { HttpTransportError } from "@locallab/network-http";
import type { ProviderPort } from "@locallab/contracts/ports";
import {
  OPENAI_RESPONSES_ENDPOINT,
  putProviderCredential,
  requireListedProviderModel,
  validateProviderEndpoint,
  verifyOpenRouterCredential,
} from "./provider-setup-helpers";

describe("provider setup endpoints", () => {
  it("defaults OpenAI to the Responses API and accepts compatible Responses URLs", () => {
    assert.equal(
      OPENAI_RESPONSES_ENDPOINT,
      "https://api.openai.com/v1/responses",
    );
    for (const endpoint of [
      OPENAI_RESPONSES_ENDPOINT,
      "https://proxy.example/v1/responses/",
      "https://proxy.example/responses",
    ]) {
      assert.equal(
        validateProviderEndpoint("openai", ` ${endpoint} `, false).href,
        endpoint,
      );
    }
  });

  it("rejects non-Responses OpenAI URLs before saving or querying the endpoint", () => {
    for (const endpoint of [
      "https://api.openai.com/v1",
      "https://api.openai.com/v1/chat/completions",
      "http://192.168.1.2:8080/v1/responses",
      "https://proxy.example/v1/responses?api-key=fixture",
      "https://proxy.example/v1/responses#fragment",
      "https://user:fixture@proxy.example/v1/responses",
    ]) {
      assert.throws(
        () => validateProviderEndpoint("openai", endpoint, true),
        (error: Error) => {
          assert.match(error.message, /OpenAI uses the Responses API/);
          assert.match(error.message, /HTTPS \/responses endpoint/);
          assert.match(error.message, /Local server or Custom cloud API/);
          return true;
        },
      );
    }
    assert.throws(
      () => validateProviderEndpoint("openai", "api.openai.com/v1", false),
      /complete OpenAI Responses endpoint/,
    );
  });

  it("preserves local and custom cloud API base support and explicit HTTP authorization", () => {
    for (const kind of ["jan", "omlx", "unsloth", "compatible"] as const) {
      for (const path of ["/", "/v1", "/v1/"]) {
        const endpoint = `http://192.168.1.2:8080${path}`;
        assert.equal(
          validateProviderEndpoint(kind, endpoint, true).href,
          endpoint,
        );
        assert.throws(
          () => validateProviderEndpoint(kind, endpoint, false),
          /Allow this local HTTP origin/,
        );
      }
      assert.throws(
        () =>
          validateProviderEndpoint(
            kind,
            "http://192.168.1.2:8080/v1/chat/completions",
            true,
          ),
        /compatible server origin or its \/v1 API base/,
      );
    }
    for (const endpoint of [
      "https://proxy.example/",
      "https://proxy.example/v1",
      "https://proxy.example/custom/api",
    ]) {
      assert.equal(
        validateProviderEndpoint("cloud-compatible", endpoint, false).href,
        endpoint,
      );
    }
    assert.throws(
      () =>
        validateProviderEndpoint(
          "cloud-compatible",
          "https://user:fixture@proxy.example/v1",
          false,
        ),
      /without credentials in the URL/,
    );
  });
});

describe("provider setup credentials", () => {
  it("checks only the current OpenRouter key and retains full validation responses until the app boundary", async () => {
    const values = new Map<string, string>();
    const store = new HostScopedSecretStore(
      {
        get: async (key) => values.get(key) ?? null,
        set: async (key, value) => {
          values.set(key, value);
        },
        delete: async (key) => {
          values.delete(key);
        },
      },
      "openrouter-key-check-fixture",
    );
    const credential = await putProviderCredential(
      store,
      "openrouter",
      "https://openrouter.ai",
      "fixture-only-key",
    );
    const calls: string[] = [];
    await verifyOpenRouterCredential(
      store,
      credential.ref,
      async (url, init) => {
        calls.push(String(url));
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer fixture-only-key",
        );
        return Response.json({
          data: { label: "fixture-only", limit_remaining: 1 },
        });
      },
    );
    assert.deepEqual(calls, ["https://openrouter.ai/api/v1/key"]);
    for (const status of [401, 403, 429, 500]) {
      await assert.rejects(
        verifyOpenRouterCredential(store, credential.ref, async () =>
          Response.json(
            { error: { message: "fixture-only-key private-response" } },
            { status },
          ),
        ),
        (error: Error) => {
          assert.ok(error.cause instanceof HttpTransportError);
          assert.equal(error.cause.status, status);
          assert.match(error.message, /fixture-only-key private-response/);
          assert.match(error.message, /Response body/);
          assert.match(
            error.message,
            status === 401 || status === 403
              ? /rejected this API key/
              : status === 429
                ? /rate limiting/
                : /could not be completed/,
          );
          return true;
        },
      );
    }
    await assert.rejects(
      verifyOpenRouterCredential(store, credential.ref, async () =>
        Response.json({ data: [] }),
      ),
      (error: Error) => {
        assert.match(error.message, /could not be completed/);
        assert.ok(error.cause instanceof Error);
        assert.match(error.cause.message, /invalid key-check response/);
        return true;
      },
    );
  });

  it("retains text and structured validation responses without an error.message or a length cap", async () => {
    const values = new Map<string, string>();
    const store = new HostScopedSecretStore(
      {
        get: async (key) => values.get(key) ?? null,
        set: async (key, value) => {
          values.set(key, value);
        },
        delete: async (key) => {
          values.delete(key);
        },
      },
      "full-response-fixture",
    );
    const credential = await putProviderCredential(
      store,
      "openrouter",
      "https://openrouter.ai",
      "fixture-key",
    );
    const bodies = [
      "upstream reverse proxy failure\n" +
        "detail ".repeat(1500) +
        "last-line-fixture",
      JSON.stringify({
        detail: "bad request",
        request_id: "key-check-fixture",
        metadata: {
          explanation: "detail ".repeat(1500) + "last-field-fixture",
        },
      }),
    ];
    for (const body of bodies) {
      await assert.rejects(
        verifyOpenRouterCredential(
          store,
          credential.ref,
          async () =>
            new Response(body, {
              status: 502,
              statusText: "Bad Gateway",
              headers: { "content-type": "text/plain" },
            }),
        ),
        (error: Error) => {
          assert.ok(error.message.includes(body));
          assert.match(error.message, /502 Bad Gateway/);
          return true;
        },
      );
    }
  });

  it("preserves a listed-model failure category and transport details", async () => {
    const failure = {
      code: "auth",
      message: "HTTP 403 from endpoint fixture",
      retryable: false,
    };
    await assert.rejects(
      requireListedProviderModel(
        {
          listModels: async () => ({ ok: false, error: failure }),
        } as unknown as ProviderPort,
        "fixture-model",
      ),
      (error) => {
        assert.equal(error, failure);
        return true;
      },
    );
  });

  it("keeps LAN authorization complete while rejecting empty or multiline keys before storage", async () => {
    const values = new Map<string, string>();
    const store = new HostScopedSecretStore(
      {
        get: async (key) => values.get(key) ?? null,
        set: async (key, value) => {
          values.set(key, value);
        },
        delete: async (key) => {
          values.delete(key);
        },
      },
      "setup-helper-fixture",
    );
    for (const kind of ["ollama", "lmstudio", "compatible"] as const) {
      const descriptor = await putProviderCredential(
        store,
        kind,
        "http://192.168.1.2:8080",
        " Bearer Bearer fixture-token ",
      );
      assert.deepEqual(
        { ...(await store.resolveHeaders(descriptor.host, [descriptor.ref])) },
        { authorization: "Bearer fixture-token" },
      );
    }
    const storedCount = values.size;
    for (const invalid of ["", " \t ", "Bearer ", "line\nbreak"]) {
      assert.throws(
        () =>
          putProviderCredential(
            store,
            "openai",
            "https://api.example",
            invalid,
          ),
        /valid provider API key/,
      );
    }
    assert.equal(values.size, storedCount);
  });
});
