import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, vi } from "vitest";

const native = vi.hoisted(() => ({ values: new Map<string, string>() }));
// Keep Expo's installed JS facade (including its real key validation). Replace
// only the OS bridge, which cannot run on this Windows test host.
vi.mock("expo-secure-store/build/ExpoSecureStore", () => ({
  default: {
    getValueWithKeyAsync: async (key: string) => native.values.get(key) ?? null,
    setValueWithKeyAsync: async (value: string, key: string) => {
      native.values.set(key, value);
    },
    deleteValueWithKeyAsync: async (key: string) => {
      native.values.delete(key);
    },
  },
}));
vi.mock("../crypto", () => ({ randomUUID }));

import * as ExpoSecureStore from "expo-secure-store";
import { createNativeMobileSecretStore } from "./index";
import { expoSecureStoreKey } from "./secure-store-key";

test("native storage key escaping is valid, reversible and collision-safe", () => {
  for (const key of [
    "locallab:mobile-provider-headers:secret:sec_fixture:value",
    "literal_003a",
    "literal:",
    "namespace%20with spaces/🔐",
  ]) {
    const encoded = expoSecureStoreKey(key);
    assert.match(encoded, /^[\w.-]+$/);
    assert.equal(
      encoded.replace(/_([0-9a-f]{4})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      ),
      key,
    );
  }
  assert.notEqual(
    expoSecureStoreKey("literal_003a"),
    expoSecureStoreKey("literal:"),
  );
});

test("the installed Expo facade rejects the legacy colon-delimited key before the OS bridge", async () => {
  native.values.clear();
  await assert.rejects(
    ExpoSecureStore.setItemAsync(
      "locallab:mobile:secret:fixture:value",
      "fixture",
    ),
    /Invalid key/,
  );
  assert.equal(native.values.size, 0);
});

test("native credentials pass Expo validation and survive a new adapter instance", async () => {
  native.values.clear();
  const writer = createNativeMobileSecretStore();
  const descriptor = await writer.put(
    "https://api.fixture.invalid",
    "Authorization",
    "Bearer fixture-native-credential",
  );
  assert.equal(native.values.size, 2);
  assert.equal(
    [...native.values.keys()].every((key) => /^[\w.-]+$/.test(key)),
    true,
  );
  const reopened = createNativeMobileSecretStore();
  assert.deepEqual(
    {
      ...(await reopened.resolveHeaders("https://api.fixture.invalid", [
        descriptor.ref,
      ])),
    },
    { authorization: "Bearer fixture-native-credential" },
  );
  await assert.rejects(
    reopened.resolveHeaders("https://other.fixture.invalid", [descriptor.ref]),
    { code: "host-mismatch" },
  );
  await reopened.remove(descriptor.ref);
  assert.equal(native.values.size, 0);
  await assert.rejects(
    writer.resolveHeaders("https://api.fixture.invalid", [descriptor.ref]),
    { code: "missing" },
  );
});

test("browser adapters share tab memory but a fresh module reports missing credentials after refresh", async () => {
  const browser = await import("./index.web");
  const descriptor = await browser
    .createNativeMobileSecretStore()
    .put(
      "https://api.fixture.invalid",
      "Authorization",
      "Bearer fixture-tab-credential",
    );
  assert.deepEqual(
    {
      ...(await browser
        .createNativeMobileSecretStore()
        .resolveHeaders("https://api.fixture.invalid", [descriptor.ref])),
    },
    { authorization: "Bearer fixture-tab-credential" },
  );
  // A real navigation reload recreates JS modules; persisted opaque references
  // must produce a recoverable missing-credential error, not host-mismatch.
  vi.resetModules();
  const refreshed = await import("./index.web");
  await assert.rejects(
    refreshed
      .createNativeMobileSecretStore()
      .resolveHeaders("https://api.fixture.invalid", [descriptor.ref]),
    { code: "missing" },
  );
});
