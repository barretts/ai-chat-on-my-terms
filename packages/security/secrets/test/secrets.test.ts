import assert from "node:assert/strict";
import { test } from "node:test";
import {
  exportWithoutSecrets,
  HostScopedSecretStore,
  SecretStoreError,
  redact,
  type SecretRef,
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
    { code: "host-mismatch" },
  );
  await assert.rejects(
    secrets.resolveHeaders("https://api.example.test", [second.ref]),
    { code: "host-mismatch" },
  );
  assert.equal(
    [...osStore.values.values()].some((stored) =>
      stored.includes("private-value"),
    ),
    true,
  );
  assert.equal(first.ref.includes("private-value"), false);
});

test("an absent owner or value reports missing credentials, not a different host", async () => {
  const osStore = new MemorySecureStore();
  const secrets = new HostScopedSecretStore(osStore, "missing-fixture");
  const absent = "sec_0195c000-0000-4000-8000-000000000504" as SecretRef;
  await assert.rejects(
    secrets.resolveHeaders("https://api.example.test", [absent]),
    { code: "missing" },
  );
  const saved = await secrets.put(
    "https://api.example.test",
    "Authorization",
    "Bearer missing-value-fixture",
  );
  const valueKey = [...osStore.values.keys()].find((key) =>
    key.endsWith(":value"),
  )!;
  osStore.values.delete(valueKey);
  await assert.rejects(
    secrets.resolveHeaders("https://api.example.test", [saved.ref]),
    { code: "missing" },
  );
  osStore.values.clear();
  await assert.rejects(
    secrets.resolveHeaders("https://api.example.test", [saved.ref]),
    { code: "missing" },
  );
});

test("corrupt ownership metadata is rejected before reading or forwarding its secret", async () => {
  const osStore = new MemorySecureStore();
  const reads: string[] = [];
  const secrets = new HostScopedSecretStore(
    {
      get: async (key) => {
        reads.push(key);
        return osStore.get(key);
      },
      set: (key, value) => osStore.set(key, value),
      delete: (key) => osStore.delete(key),
    },
    "corrupt-owner-fixture",
  );
  const saved = await secrets.put(
    "https://api.example.test",
    "Authorization",
    "Bearer corrupt-owner-fixture",
  );
  const ownerKey = [...osStore.values.keys()].find((key) =>
    key.endsWith(":owner"),
  )!;
  const corruptEntries = [
    "{",
    "null",
    "[]",
    JSON.stringify({ host: 42, headerName: "authorization" }),
    JSON.stringify({ host: "https://api.example.test", headerName: 42 }),
    JSON.stringify({ host: "invalid", headerName: "authorization" }),
    JSON.stringify({
      host: "https://api.example.test",
      headerName: "bad\nheader",
    }),
  ];
  for (const entry of corruptEntries) {
    osStore.values.set(ownerKey, entry);
    reads.length = 0;
    await assert.rejects(
      secrets.resolveHeaders("https://api.example.test", [saved.ref]),
      { code: "secure-store" },
    );
    assert.deepEqual(reads, [ownerKey]);
  }
});

test("invalid stored header values are never returned to the HTTP adapter", async () => {
  const osStore = new MemorySecureStore();
  const secrets = new HostScopedSecretStore(osStore, "corrupt-value-fixture");
  const saved = await secrets.put(
    "https://api.example.test",
    "Authorization",
    "Bearer value-fixture",
  );
  const valueKey = [...osStore.values.keys()].find((key) =>
    key.endsWith(":value"),
  )!;
  for (const value of ["", "Bearer fixture\r\nInjected: value"]) {
    osStore.values.set(valueKey, value);
    await assert.rejects(
      secrets.resolveHeaders("https://api.example.test", [saved.ref]),
      { code: "secure-store" },
    );
  }
});

test("a failed ownership write removes both records even when it committed before rejecting", async () => {
  const osStore = new MemorySecureStore();
  const failing: SecureValuePort = {
    get: (key) => osStore.get(key),
    set: async (key, value) => {
      await osStore.set(key, value);
      if (key.endsWith(":owner"))
        throw new Error("Native failure containing fixture-private-material");
    },
    delete: (key) => osStore.delete(key),
  };
  const secrets = new HostScopedSecretStore(failing, "write-failure-fixture");
  await assert.rejects(
    secrets.put(
      "https://api.example.test",
      "Authorization",
      "Bearer write-fixture",
    ),
    (cause: unknown) => {
      assert.equal(cause instanceof SecretStoreError, true);
      const error = cause as SecretStoreError;
      assert.equal(error.code, "secure-store");
      assert.equal(error.message.includes("fixture-private-material"), false);
      assert.equal(error.message.includes("write-fixture"), false);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /Native failure/);
      assert.equal(
        JSON.stringify(error).includes("fixture-private-material"),
        false,
      );
      return true;
    },
  );
  assert.equal(osStore.values.size, 0);
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
