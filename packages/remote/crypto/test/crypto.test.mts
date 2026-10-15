import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertPairingUsable,
  createHandshakePairing,
  createPairingQrV1,
  createPairingRecord,
  createSessionPairing,
  deriveHandshakeKey,
  deriveHandshakeNonceKey,
  deriveNonce,
  deriveNonceKey,
  deriveSessionKey,
  deriveSessionSalts,
  encodePairingQrPayload,
  generateSessionSalt,
  helloProof,
  mobileRouteTicketHash,
  parsePairingQrPayload,
  PairingCryptoError,
  regeneratePairing,
  sealPayload,
  verifyHelloProof,
  REPLAY_WINDOW,
  type EncryptedPayload,
  type EncryptedRelayFrameV1,
  type SessionEntropy,
} from "../src/index.js";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/pairing-vectors.json", import.meta.url), "utf8"),
) as {
  pairingSecretBase64Url: string;
  mobileSaltBase64Url: string;
  companionSaltBase64Url: string;
  mobileEphemeralBase64Url: string;
  companionEphemeralBase64Url: string;
  routeId: string;
  mobileRouteTicketBase64Url: string;
  mobileRouteTicketHash: string;
  helloProofBase64Url: string;
  mobileToCompanionKeyHex: string;
  companionToMobileKeyHex: string;
  mobileToCompanionHandshakeKeyHex: string;
  companionToMobileHandshakeKeyHex: string;
  sealed: {
    name: string;
    direction: "mobile-to-companion" | "companion-to-mobile";
    channel: "session" | "handshake";
    requestId: string;
    sequence: number;
    contentTag: string;
    payloadJson: string;
    frame: EncryptedRelayFrameV1;
  }[];
};

const secret = new Uint8Array(Buffer.from(fixture.pairingSecretBase64Url, "base64url"));
const mobileSalt = new Uint8Array(Buffer.from(fixture.mobileSaltBase64Url, "base64url"));
const companionSalt = new Uint8Array(Buffer.from(fixture.companionSaltBase64Url, "base64url"));
const entropy: SessionEntropy = {
  mobileEphemeral: new Uint8Array(Buffer.from(fixture.mobileEphemeralBase64Url, "base64url")),
  companionEphemeral: new Uint8Array(Buffer.from(fixture.companionEphemeralBase64Url, "base64url")),
};

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (h) => Number.parseInt(h, 16));
}

function directionRoles(direction: "mobile-to-companion" | "companion-to-mobile") {
  return direction === "mobile-to-companion"
    ? (["mobile", "companion"] as const)
    : (["companion", "mobile"] as const);
}

test("golden vectors reproduce derived keys, hello proof, ticket hash and every frame", () => {
  assert.equal(secret.length, 32, "pairing secret is 256-bit");
  assert.equal(
    fixture.mobileToCompanionKeyHex,
    hex(deriveSessionKey(secret, mobileSalt, companionSalt, entropy, fixture.routeId, "mobile", "companion")),
  );
  assert.equal(
    fixture.companionToMobileKeyHex,
    hex(deriveSessionKey(secret, mobileSalt, companionSalt, entropy, fixture.routeId, "companion", "mobile")),
  );
  assert.equal(hexToBytes(fixture.mobileToCompanionKeyHex).length, 32);
  assert.notEqual(fixture.mobileToCompanionKeyHex, fixture.companionToMobileKeyHex);
  assert.equal(
    fixture.mobileToCompanionHandshakeKeyHex,
    hex(deriveHandshakeKey(secret, mobileSalt, companionSalt, fixture.routeId, "mobile", "companion")),
  );
  assert.equal(
    fixture.companionToMobileHandshakeKeyHex,
    hex(deriveHandshakeKey(secret, mobileSalt, companionSalt, fixture.routeId, "companion", "mobile")),
  );
  assert.notEqual(
    fixture.mobileToCompanionHandshakeKeyHex,
    hex(deriveSessionKey(secret, mobileSalt, companionSalt, entropy, fixture.routeId, "mobile", "companion")),
  );
  assert.equal(
    fixture.helloProofBase64Url,
    helloProof(secret, mobileSalt, companionSalt, fixture.routeId),
  );
  assert.equal(
    fixture.mobileRouteTicketHash,
    mobileRouteTicketHash(fixture.mobileRouteTicketBase64Url),
  );
  for (const entry of fixture.sealed) {
    const [from, to] = directionRoles(entry.direction);
    const frame = sealPayload(
      JSON.parse(entry.payloadJson) as EncryptedPayload,
      entry.channel === "handshake"
        ? deriveHandshakeKey(secret, mobileSalt, companionSalt, fixture.routeId, from, to)
        : deriveSessionKey(secret, mobileSalt, companionSalt, entropy, fixture.routeId, from, to),
      entry.channel === "handshake"
        ? deriveHandshakeNonceKey(secret, mobileSalt, companionSalt, fixture.routeId, from, to)
        : deriveNonceKey(secret, mobileSalt, companionSalt, entropy, fixture.routeId, from, to),
      fixture.routeId,
      entry.requestId,
      entry.sequence,
    );
    assert.deepEqual(frame, entry.frame, entry.name);
  }
});

test("session channels round-trip payloads in both directions", () => {
  const pairing = createSessionPairing(secret, mobileSalt, companionSalt, entropy, fixture.routeId);
  const payload: EncryptedPayload = { tag: "health", nonce: "ping-0123456789ab" };
  const fromMobile = pairing.mobile.toCompanion.seal(payload, "0198f2a3-0000-7000-8000-0000000000f1");
  assert.deepEqual(pairing.companion.fromMobile.open(fromMobile), payload);
  const reply: EncryptedPayload = { tag: "close", reason: "bye" };
  const fromCompanion = pairing.companion.toMobile.seal(reply, "0198f2a3-0000-7000-8000-0000000000f2");
  assert.deepEqual(pairing.mobile.fromCompanion.open(fromCompanion), reply);
});

test("replay, stale and out-of-window sequences are rejected", () => {
  const pairing = createSessionPairing(secret, mobileSalt, companionSalt, entropy, fixture.routeId);
  const receiver = pairing.companion.fromMobile;
  const frames = Array.from({ length: 3 }, (_, i) =>
    pairing.mobile.toCompanion.seal({ tag: "health", nonce: `nonce-${i}-012345678` }, `0198f2a3-0000-7000-8000-0000000000f${i}`),
  );
  for (const frame of frames) receiver.open(frame);
  assert.throws(
    () => receiver.open(frames[1] as EncryptedRelayFrameV1),
    (error: unknown) =>
      error instanceof PairingCryptoError && /already used/.test(error.message),
  );
  const jump = sealPayload(
    { tag: "health", nonce: "jump-0123456789ab" },
    deriveSessionKey(secret, mobileSalt, companionSalt, entropy, fixture.routeId, "mobile", "companion"),
    deriveNonceKey(secret, mobileSalt, companionSalt, entropy, fixture.routeId, "mobile", "companion"),
    fixture.routeId,
    "0198f2a3-0000-7000-8000-0000000000f9",
    100,
  );
  receiver.open(jump);
  assert.throws(
    () => receiver.open(frames[0] as EncryptedRelayFrameV1),
    (error: unknown) =>
      error instanceof PairingCryptoError && /below the replay window/.test(error.message),
  );
  const far = sealPayload(
    { tag: "health", nonce: "far-nonce-0123456789a" },
    deriveSessionKey(secret, mobileSalt, companionSalt, entropy, fixture.routeId, "mobile", "companion"),
    deriveNonceKey(secret, mobileSalt, companionSalt, entropy, fixture.routeId, "mobile", "companion"),
    fixture.routeId,
    "0198f2a3-0000-7000-8000-0000000000fa",
    100 + REPLAY_WINDOW + 1,
  );
  assert.throws(
    () => receiver.open(far),
    (error: unknown) =>
      error instanceof PairingCryptoError && /beyond the replay window/.test(error.message),
  );
});

test("tampered ciphertext and foreign frames fail authentication", () => {
  const pairing = createSessionPairing(secret, mobileSalt, companionSalt, entropy, fixture.routeId);
  const frame = pairing.mobile.toCompanion.seal({ tag: "health", nonce: "tamper-0123456789ab" }, "0198f2a3-0000-7000-8000-0000000000fb");
  const bytes = Buffer.from(frame.ciphertextBase64Url, "base64url");
  bytes[0] = bytes[0]! ^ 0xff;
  assert.throws(
    () => pairing.companion.fromMobile.open({ ...frame, ciphertextBase64Url: bytes.toString("base64url") }),
    (error: unknown) =>
      error instanceof PairingCryptoError && /authentication failed/.test(error.message),
  );
  const attacker = createSessionPairing(secret, generateSessionSalt(), generateSessionSalt(), entropy, fixture.routeId);
  const foreign = attacker.mobile.toCompanion.seal({ tag: "health", nonce: "forged-0123456789ac" }, "0198f2a3-0000-7000-8000-0000000000fc");
  assert.throws(
    () => pairing.companion.fromMobile.open(foreign),
    (error: unknown) =>
      error instanceof PairingCryptoError && /nonce does not match/.test(error.message),
  );
});

test("R021: accepted out-of-order frames are spent; failed auth consumes nothing", () => {
  const { mobile, companion } = createSessionPairing(secret, mobileSalt, companionSalt, entropy, fixture.routeId);
  const payload: EncryptedPayload = { tag: "health", nonce: "reorder-0123456789ab" };
  const zero = mobile.toCompanion.seal(payload, "0198f2a3-0000-7000-8000-000000000001");
  const one = mobile.toCompanion.seal(payload, "0198f2a3-0000-7000-8000-000000000002");
  // A legitimate reordering (1 before 0) is accepted in both orders.
  companion.fromMobile.open(one);
  companion.fromMobile.open(zero);
  // The defect: every REPEAT of the in-window older sequence 0 must now
  // be rejected — the seen bit for an accepted old sequence used to never
  // get set, so captured valid frames replayed indefinitely.
  assert.throws(() => companion.fromMobile.open(zero), (error: unknown) => error instanceof PairingCryptoError && error.code === "unauthorized");
  assert.throws(() => companion.fromMobile.open(zero), (error: unknown) => error instanceof PairingCryptoError && error.code === "unauthorized");
  // A frame that fails authentication must NOT consume its sequence: the
  // genuine frame still opens on a fresh receiver after the tampered one.
  const fresh = createSessionPairing(secret, mobileSalt, companionSalt, entropy, fixture.routeId);
  const ciphertext = Buffer.from(zero.ciphertextBase64Url, "base64url");
  ciphertext[0] = ciphertext[0]! ^ 0xff;
  const tampered = { ...zero, ciphertextBase64Url: ciphertext.toString("base64url") };
  assert.throws(() => fresh.companion.fromMobile.open(tampered), (error: unknown) => error instanceof PairingCryptoError && error.code === "unauthorized");
  assert.equal(fresh.companion.fromMobile.open(zero).tag, payload.tag);
  // And on the SAME receiver, a failed attempt leaves the slot open.
  const shared = createSessionPairing(secret, mobileSalt, companionSalt, entropy, fixture.routeId);
  assert.throws(() => shared.companion.fromMobile.open(tampered));
  assert.equal(shared.companion.fromMobile.open(zero).tag, payload.tag);
});

test("nonces are unique per sequence and never reused across sessions", () => {
  const nonceKey = deriveNonceKey(secret, mobileSalt, companionSalt, entropy, fixture.routeId, "mobile", "companion");
  const nonces = Array.from({ length: 200 }, (_, i) =>
    Buffer.from(deriveNonce(nonceKey, i)).toString("base64url"),
  );
  assert.equal(new Set(nonces).size, nonces.length);
  const freshSalt = generateSessionSalt();
  const otherNonceKey = deriveNonceKey(secret, freshSalt, companionSalt, entropy, fixture.routeId, "mobile", "companion");
  assert.notEqual(
    Buffer.from(deriveNonce(otherNonceKey, 0)).toString("base64url"),
    Buffer.from(deriveNonce(nonceKey, 0)).toString("base64url"),
  );
  // R007: a restarted session mixes fresh ephemerals, so the (key, nonce)
  // pairs of the previous session are unreachable even at sequence 0.
  const restarted: SessionEntropy = {
    mobileEphemeral: generateSessionSalt(),
    companionEphemeral: generateSessionSalt(),
  };
  const restartedKey = deriveSessionKey(secret, mobileSalt, companionSalt, restarted, fixture.routeId, "mobile", "companion");
  const restartedNonceKey = deriveNonceKey(secret, mobileSalt, companionSalt, restarted, fixture.routeId, "mobile", "companion");
  assert.notEqual(hex(restartedKey), hex(deriveSessionKey(secret, mobileSalt, companionSalt, entropy, fixture.routeId, "mobile", "companion")));
  assert.notEqual(
    Buffer.from(deriveNonce(restartedNonceKey, 0)).toString("base64url"),
    Buffer.from(deriveNonce(nonceKey, 0)).toString("base64url"),
  );
});

test("hello proof proves possession without exposing the secret", () => {
  const proof = helloProof(secret, mobileSalt, companionSalt, fixture.routeId);
  assert.ok(verifyHelloProof(proof, secret, mobileSalt, companionSalt, fixture.routeId));
  assert.ok(!verifyHelloProof(proof, generateSessionSalt(), mobileSalt, companionSalt, fixture.routeId));
  assert.ok(!verifyHelloProof(proof, secret, mobileSalt, generateSessionSalt(), fixture.routeId));
  assert.ok(!verifyHelloProof(proof, secret, mobileSalt, companionSalt, "0198f2a3-0000-7000-8000-000000000099"));
});

test("QR v1 payloads generate fresh 256-bit secrets and round-trip through text", () => {
  const first = createPairingQrV1({
    relayUrl: "https://relay.example.internal/ws",
    serverIdentityFingerprint: `sha256:${"ab".repeat(32)}`,
  });
  const second = createPairingQrV1({
    relayUrl: "https://relay.example.internal/ws",
    serverIdentityFingerprint: `sha256:${"ab".repeat(32)}`,
  });
  assert.notEqual(first.pairingSecret, second.pairingSecret);
  assert.notEqual(first.mobileRouteTicket, second.mobileRouteTicket);
  assert.notEqual(first.companionRouteId, second.companionRouteId);
  assert.equal(Buffer.from(first.pairingSecret, "base64url").length, 32);
  assert.equal(encodePairingQrPayload(first), encodePairingQrPayload(parsePairingQrPayload(encodePairingQrPayload(first))));
  assert.throws(() => parsePairingQrPayload("{\"protocol\":{\"major\":2}}"));
  assert.throws(() =>
    parsePairingQrPayload(
      encodePairingQrPayload({ ...first, pairingSecret: Buffer.from(generateSessionSalt()).toString("base64url") }),
    ),
  );
});

test("regenerating keys revokes the old pairing and rotates the route", () => {
  const record = createPairingRecord({
    relayUrl: "wss://relay.example.internal",
    serverIdentityFingerprint: `sha256:${"cd".repeat(32)}`,
    label: "Studio Mac",
    now: "2026-10-14T00:00:00.000Z",
  });
  assertPairingUsable(record);
  const { old, next } = regeneratePairing(record, "2026-10-14T00:05:00.000Z");
  assert.equal(old.revokedAt, "2026-10-14T00:05:00.000Z");
  assertPairingUsable(next);
  assert.throws(
    () => assertPairingUsable(old),
    (error: unknown) => error instanceof PairingCryptoError && /invalidated/.test(error.message),
  );
  assert.notEqual(next.qr.companionRouteId, old.qr.companionRouteId);
  assert.notEqual(next.qr.pairingSecret, old.qr.pairingSecret);
  assert.notEqual(next.qr.mobileRouteTicket, old.qr.mobileRouteTicket);
  const oldSecret = new Uint8Array(Buffer.from(old.qr.pairingSecret, "base64url"));
  const proof = helloProof(oldSecret, mobileSalt, companionSalt, fixture.routeId);
  const newSecret = new Uint8Array(Buffer.from(next.qr.pairingSecret, "base64url"));
  assert.ok(!verifyHelloProof(proof, newSecret, mobileSalt, companionSalt, fixture.routeId));
});

test("pairing-derived session salts are deterministic and per-pairing", () => {
  const first = deriveSessionSalts(secret, fixture.routeId);
  const again = deriveSessionSalts(secret, fixture.routeId);
  assert.deepEqual(first, again);
  assert.equal(first.mobileSalt.length, 16);
  assert.equal(first.companionSalt.length, 16);
  assert.notEqual(Buffer.compare(Buffer.from(first.mobileSalt), Buffer.from(first.companionSalt)), 0);
  const otherRoute = deriveSessionSalts(secret, "0198f2a3-0000-7000-8000-000000000099");
  assert.notEqual(Buffer.compare(Buffer.from(first.mobileSalt), Buffer.from(otherRoute.mobileSalt)), 0);
  const otherQr = createPairingQrV1({
    relayUrl: "https://relay.example.internal",
    serverIdentityFingerprint: `sha256:${"cd".repeat(32)}`,
  });
  const rotated = deriveSessionSalts(
    new Uint8Array(Buffer.from(otherQr.pairingSecret, "base64url")),
    fixture.routeId,
  );
  assert.notEqual(Buffer.compare(Buffer.from(first.mobileSalt), Buffer.from(rotated.mobileSalt)), 0);
  // Derived salts still produce interoperable sessions (mobile seals, companion opens).
  const session = createSessionPairing(secret, first.mobileSalt, first.companionSalt, entropy, fixture.routeId);
  const payload: EncryptedPayload = { tag: "health", nonce: "0198f2a3-0000-7000-8000-000000000099" };
  assert.deepEqual(
    session.companion.fromMobile.open(session.mobile.toCompanion.seal(payload, "0198f2a3-0000-7000-8000-000000000099")),
    payload,
  );
});

test("handshake channels authenticate hello/ready before data keys exist", () => {
  const handshake = createHandshakePairing(secret, mobileSalt, companionSalt, fixture.routeId);
  const hello: EncryptedPayload = { tag: "request", body: { type: "pairing-hello", proof: "x" } };
  const helloFrame = handshake.mobile.toCompanion.seal(hello, "0198f2a3-0000-7000-8000-0000000000a0");
  assert.deepEqual(handshake.companion.fromMobile.open(helloFrame), hello);
  const ready: EncryptedPayload = { tag: "request", body: { type: "pairing-ready", proof: "y" } };
  const readyFrame = handshake.companion.toMobile.seal(ready, "0198f2a3-0000-7000-8000-0000000000a1");
  assert.deepEqual(handshake.mobile.fromCompanion.open(readyFrame), ready);
  // The deterministic handshake channel must be key-wise distinct from the
  // data channel it bootstraps.
  assert.notEqual(
    hex(deriveHandshakeKey(secret, mobileSalt, companionSalt, fixture.routeId, "mobile", "companion")),
    hex(deriveSessionKey(secret, mobileSalt, companionSalt, entropy, fixture.routeId, "mobile", "companion")),
  );
});

test("two sessions from one saved pairing never reuse key or nonce", () => {
  // R007 regression: QR pairing salts are deterministic, so without mixed
  // per-connection ephemerals a recreated session would replay its exact
  // (key, nonce) pairs — the receiving window would accept a stale frame.
  const first = createSessionPairing(secret, mobileSalt, companionSalt, entropy, fixture.routeId);
  const restarted = createSessionPairing(secret, mobileSalt, companionSalt, {
    mobileEphemeral: generateSessionSalt(),
    companionEphemeral: generateSessionSalt(),
  }, fixture.routeId);
  const payload: EncryptedPayload = { tag: "health", nonce: "restart-0123456789ab" };
  const firstFrame = first.mobile.toCompanion.seal(payload, "0198f2a3-0000-7000-8000-0000000000d0");
  const restartedFrame = restarted.mobile.toCompanion.seal(payload, "0198f2a3-0000-7000-8000-0000000000d0");
  assert.notEqual(firstFrame.nonceBase64Url, restartedFrame.nonceBase64Url);
  // Fresh receiver at sequence 0 refuses the previous session's frame.
  assert.throws(
    () => restarted.companion.fromMobile.open(firstFrame),
    (error: unknown) => error instanceof PairingCryptoError && error.code === "unauthorized",
  );
  // The restarted receiver does accept its own sequence-0 frame, proving
  // the rejection above was key/nonce separation, not a broken opener.
  const mirrored = restarted.companion.fromMobile.open(restartedFrame);
  assert.deepEqual(mirrored, payload);
});
