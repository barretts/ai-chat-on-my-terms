import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { HostScopedSecretStore } from "@locallab/security-secrets";
import {
  putProviderCredential,
  verifyOpenRouterCredential,
} from "./provider-setup-helpers";

describe("provider setup credentials", () => {
  it("checks only the current OpenRouter key and redacts failed validation responses", async () => {
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
          assert.doesNotMatch(
            error.message,
            /fixture-only-key|private-response/,
          );
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
      /could not be completed/,
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
