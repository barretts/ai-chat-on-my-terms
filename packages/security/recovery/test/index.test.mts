import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeviceRecoveryIdentity,
  issueGrant,
  sha256Hex,
  verifyGrant,
  memoryRecoveryStore,
  type GrantPayload,
} from "../src/index.ts";

const KEY = "00112233445566778899aabbccddeeff".repeat(4);
const NOW = Date.parse("2026-10-14T12:00:00.000Z");

const payload: GrantPayload = {
  v: 1,
  enrollmentId: "enr-1",
  deviceIdHash: sha256Hex("device-secret-hex"),
  iat: NOW,
  exp: NOW + 30 * 60 * 1000,
  nonce: "nonce-abc",
};

test("grants round-trip with signature and expiry intact", async () => {
  const grant = issueGrant(payload, KEY);
  const result = verifyGrant(grant, KEY, NOW + 60_000);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.payload, payload);
});

test("an expired grant cannot verify", async () => {
  const grant = issueGrant(payload, KEY);
  const result = verifyGrant(grant, KEY, payload.exp + 1);
  assert.ok(!result.ok);
  assert.equal(result.ok ? "" : result.code, "expired");
});

test("tampered payloads and wrong keys fail the signature", async () => {
  const grant = issueGrant(payload, KEY);
  const tampered = grant.slice(0, 20) + "A" + grant.slice(21);
  assert.equal(verifyGrant(tampered, KEY, NOW).ok, false);
  const wrongKey = verifyGrant(grant, "ff".repeat(32), NOW);
  assert.ok(!wrongKey.ok);
  assert.equal(wrongKey.ok ? "" : wrongKey.code, "bad-signature");
  assert.equal(verifyGrant("not-a-grant", KEY, NOW).ok, false);
});

test("the device identity hash chain binds the grant to a device", async () => {
  const identity = createDeviceRecoveryIdentity((length) =>
    Uint8Array.from({ length: 32 }, (_, i) => i),
  );
  assert.equal(identity.deviceSecret.length, 64);
  assert.equal(identity.deviceIdHash, sha256Hex(identity.deviceSecret));
  // The hash does not invert to anything close to the secret.
  assert.notEqual(identity.deviceIdHash, identity.deviceSecret);
  const bound = { ...payload, deviceIdHash: identity.deviceIdHash };
  const grant = issueGrant(bound, KEY);
  const verified = verifyGrant(grant, KEY, NOW + 1);
  assert.ok(verified.ok);
});

test("nonces consume exactly once", async () => {
  const store = memoryRecoveryStore();
  assert.equal(await store.consumeNonce("n1"), true);
  assert.equal(await store.consumeNonce("n1"), false);
});

test("enrollments are found by email without storing any device secret", async () => {
  const store = memoryRecoveryStore();
  await store.insertEnrollment({
    id: "e1",
    userId: "u1",
    email: "User@Example.com",
    deviceIdHash: "ab".repeat(32),
    createdAt: "2026-10-14T00:00:00.000Z",
  });
  const found = await store.enrollmentsByEmail("user@example.com");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.deviceIdHash, "ab".repeat(32));
  assert.equal((await store.enrollmentsByEmail("other@x.com")).length, 0);
});
