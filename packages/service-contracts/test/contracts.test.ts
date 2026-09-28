import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PairingQrV1Schema, assertProtocolCompatible } from "../src/pairing.js";
import {
  EncryptedPayloadSchema,
  EncryptedRelayFrameV1Schema,
  validateRelayFrameSize,
} from "../src/relay.js";
import {
  SearchRequestSchema,
  EncryptedBackupObjectSchema,
} from "../src/services.js";

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(
    await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"),
  ) as unknown;

test("pairing and encrypted relay fixtures validate without real credentials", async () => {
  assert.equal(
    PairingQrV1Schema.safeParse(await fixture("pairing-qr-v1.json")).success,
    true,
  );
  const frame = EncryptedRelayFrameV1Schema.parse(
    await fixture("encrypted-frame-v1.json"),
  );
  assert.doesNotThrow(() => validateRelayFrameSize(frame));
  assert.equal(
    EncryptedPayloadSchema.safeParse(await fixture("sync-envelope-v1.json"))
      .success,
    true,
  );
});

test("protocol compatibility rejects major and future-minor mismatches", () => {
  assert.doesNotThrow(() =>
    assertProtocolCompatible({ major: 1, minor: 0 }, { major: 1, minor: 0 }),
  );
  assert.throws(
    () =>
      assertProtocolCompatible({ major: 1, minor: 0 }, { major: 2, minor: 0 }),
    /major version/,
  );
  assert.throws(
    () =>
      assertProtocolCompatible({ major: 1, minor: 0 }, { major: 1, minor: 1 }),
    /minor version/,
  );
});

test("optional service schemas enforce resource bounds and encrypted backups", () => {
  assert.equal(
    SearchRequestSchema.safeParse({ query: "weather", limit: 3 }).success,
    true,
  );
  assert.equal(
    SearchRequestSchema.safeParse({ query: "x".repeat(513) }).success,
    false,
  );
  assert.equal(
    EncryptedBackupObjectSchema.safeParse({
      objectId: "018f1f1e-7b4a-7c12-8a10-000000000014",
      sha256: "a".repeat(64),
      ciphertextBase64Url: "opaque-ciphertext",
    }).success,
    true,
  );
  assert.equal(
    EncryptedBackupObjectSchema.safeParse({
      objectId: "018f1f1e-7b4a-7c12-8a10-000000000014",
      sha256: "a".repeat(64),
      ciphertextBase64Url: "opaque-ciphertext",
      plaintext: "chat",
    }).success,
    false,
  );
});
