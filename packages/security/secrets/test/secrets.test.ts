import assert from "node:assert/strict";
import { test } from "node:test";
import {
  exportWithoutSecrets,
  HostScopedSecretStore,
  redact,
  type SecureValuePort,
} from "../src/index.js";

class MemorySecureStore implements SecureValuePort {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

test("an injected UUID factory stores and resolves a secret without global crypto", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: undefined,
  });
  try {
    const osStore = new MemorySecureStore();
    let created = 0;
    const secrets = new HostScopedSecretStore(
      osStore,
      "native-factory-fixture",
      () => {
        created += 1;
        return "0195c000-0000-4000-8000-000000000502";
      },
    );
    const saved = await secrets.put(
      "https://api.example.test",
      "Authorization",
      "Bearer fixture",
    );
    assert.equal(created, 1);
    assert.equal(saved.ref, "sec_0195c000-0000-4000-8000-000000000502");
    assert.deepEqual(
      {
        ...(await secrets.resolveHeaders("https://api.example.test", [
          saved.ref,
        ])),
      },
      { authorization: "Bearer fixture" },
    );
    await secrets.remove(saved.ref);
    assert.equal(osStore.values.size, 0);
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test("header refs are bound to one normalized host", async () => {
  const osStore = new MemorySecureStore();
  const secrets = new HostScopedSecretStore(osStore, "test-profile");
  const first = await secrets.put(
    "https://api.example.test/",
    "Authorization",
    "Bearer private-value",
  );
  const second = await secrets.put(
    "https://other.example.test",
    "X-Api-Key",
    "other-private-value",
  );
  assert.deepEqual(
    {
      ...(await secrets.resolveHeaders("https://api.example.test", [
        first.ref,
      ])),
    },
    { authorization: "Bearer private-value" },
  );
  await assert.rejects(
    secrets.resolveHeaders("https://other.example.test", [first.ref]),
    /host-mismatch/,
  );
  await assert.rejects(
    secrets.resolveHeaders("https://api.example.test", [second.ref]),
    /host-mismatch/,
  );
  assert.equal(
    [...osStore.values.values()].some((stored) =>
      stored.includes("private-value"),
    ),
    true,
  );
  assert.equal(first.ref.includes("private-value"), false);
});

test("redaction and export exclusion remove values and opaque refs", async () => {
  const apiSecret = "sk-live-value-123";
  const diagnostic = JSON.stringify(
    redact(
      {
        error: `request failed ${apiSecret}`,
        authorization: `Bearer ${apiSecret}`,
      },
      [apiSecret],
    ),
  );
  const exported = JSON.stringify(
    exportWithoutSecrets({
      connection: {
        host: "https://api.example.test",
        apiKeyRef: "sec_sensitive-ref",
        headers: { authorization: `Bearer ${apiSecret}` },
      },
      chat: "kept",
    }),
  );
  for (const output of [diagnostic, exported]) {
    assert.equal(output.includes(apiSecret), false);
    assert.equal(output.includes("sec_sensitive-ref"), false);
  }
  assert.match(exported, /kept/);
});
