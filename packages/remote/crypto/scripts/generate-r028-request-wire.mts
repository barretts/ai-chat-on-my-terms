/**
 * R028: regenerates the frozen mobile→companion chat-request WIRE fixture
 * (`apps/companion/composition/remote/fixtures/r028-request-wire.json`).
 *
 * The frame inside is sealed by the REAL TypeScript pairing stack (same
 * code the mobile app uses) against the frozen pairing vectors, so the Rust
 * composition test proves it accepts exactly what a real iPhone sends —
 * envelope payload, structured body, protocol version pair and all.
 *
 * Run after intentionally changing the chat-request contract:
 *   cd packages/remote/crypto && npx tsx scripts/generate-r028-request-wire.mts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deriveNonceKey, deriveSessionKey, sealPayload } from "../src/index.js";

const b64ToBytes = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "base64url"));

const vectors = JSON.parse(
  readFileSync(new URL("../fixtures/pairing-vectors.json", import.meta.url), "utf8"),
);
const secret = b64ToBytes(vectors.pairingSecretBase64Url);
const mobileSalt = b64ToBytes(vectors.mobileSaltBase64Url);
const companionSalt = b64ToBytes(vectors.companionSaltBase64Url);
const entropy = {
  mobileEphemeral: b64ToBytes(vectors.mobileEphemeralBase64Url),
  companionEphemeral: b64ToBytes(vectors.companionEphemeralBase64Url),
};

// Deterministic, UUIDv7-shaped identifiers (the same constants the Rust
// composition test asserts against — change them ONLY together).
const runId = "0198f2a3-0000-7000-8000-0000000000c0";
const requestId = "0198f2a3-0000-7000-8000-0000000000d0";
const routeId = vectors.routeId as string;

// The EXACT payload the mobile composition adapter sends (R028): the
// EncryptedPayload envelope around the versioned structured body.
const payload = {
  tag: "request" as const,
  body: {
    type: "chat-request",
    version: 1,
    runId,
    routeId,
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  },
};
const key = deriveSessionKey(secret, mobileSalt, companionSalt, entropy, routeId, "mobile", "companion");
const nonceKey = deriveNonceKey(secret, mobileSalt, companionSalt, entropy, routeId, "mobile", "companion");
const outPath = new URL("../../../../apps/companion/composition/remote/fixtures/r028-request-wire.json", import.meta.url);
mkdirSync(new URL(".", outPath), { recursive: true });
const frame = sealPayload(payload, key, nonceKey, routeId, requestId, 0);

writeFileSync(
  outPath,
  `${JSON.stringify({ protocol: "r028-request-wire-v1", routeId, runId, requestId, frame }, null, 2)}\n`,
);
console.log("wrote apps/companion/composition/remote/fixtures/r028-request-wire.json");
