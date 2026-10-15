import { mkdirSync, writeFileSync } from "node:fs";
import { EncryptedPayloadSchema } from "@locallab/service-contracts/relay";
import {
  deriveHelloKey,
  deriveNonceKey,
  deriveSessionKey,
  helloProof,
  mobileRouteTicketHash,
  sealPayload,
  type EncryptedPayload,
} from "../src/index.js";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

// Deterministic development inputs; the frozen outputs are shared with Rust.
const pairingSecret = new Uint8Array(32).map((_, i) => 0xa0 + i);
const mobileSalt = new Uint8Array(16).map((_, i) => 0x10 + i);
const companionSalt = new Uint8Array(16).map((_, i) => 0x20 + i);
const routeId = "0198f2a3-0000-7000-8000-0000000000c3";
const mobileTicket = new Uint8Array(32).map((_, i) => 0x30 + i);

const payloads: { sequence: number; payload: EncryptedPayload }[] = [
  { sequence: 0, payload: { tag: "request", body: { kind: "ping" } } },
  {
    sequence: 1,
    payload: {
      tag: "event",
      event: {
        type: "RunStarted",
        runId: "0198f2a3-0000-7000-8000-0000000000d1",
        sequence: 0,
        timestamp: "2026-10-14T00:00:00.000Z",
      },
    },
  },
  { sequence: 5, payload: { tag: "health", nonce: "session-health-nonce-0001" } },
];

const sealed = [];
for (const direction of ["mobile-to-companion", "companion-to-mobile"] as const) {
  const [from, to] = direction === "mobile-to-companion"
    ? (["mobile", "companion"] as const)
    : (["companion", "mobile"] as const);
  const key = deriveSessionKey(pairingSecret, mobileSalt, companionSalt, routeId, from, to);
  const nonceKey = deriveNonceKey(pairingSecret, mobileSalt, companionSalt, routeId, from, to);
  for (const entry of payloads) {
    const requestId = `0198f2a3-0000-7000-8000-0000000000e${entry.sequence}`;
    sealed.push({
      name: `${direction}-seq${entry.sequence}`,
      direction,
      requestId,
      sequence: entry.sequence,
      contentTag: entry.payload.tag,
      payloadJson: JSON.stringify(EncryptedPayloadSchema.parse(entry.payload)),
      frame: sealPayload(entry.payload, key, nonceKey, routeId, requestId, entry.sequence),
    });
  }
}

const fixture = {
  protocol: "1.0",
  pairingSecretBase64Url: b64(pairingSecret),
  mobileSaltBase64Url: b64(mobileSalt),
  companionSaltBase64Url: b64(companionSalt),
  routeId,
  mobileRouteTicketBase64Url: b64(mobileTicket),
  mobileRouteTicketHash: mobileRouteTicketHash(b64(mobileTicket)),
  helloKeyHex: hex(deriveHelloKey(pairingSecret, mobileSalt, companionSalt, routeId)),
  helloProofBase64Url: helloProof(pairingSecret, mobileSalt, companionSalt, routeId),
  mobileToCompanionKeyHex: hex(
    deriveSessionKey(pairingSecret, mobileSalt, companionSalt, routeId, "mobile", "companion"),
  ),
  companionToMobileKeyHex: hex(
    deriveSessionKey(pairingSecret, mobileSalt, companionSalt, routeId, "companion", "mobile"),
  ),
  sealed,
};

mkdirSync(new URL("../fixtures/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../fixtures/pairing-vectors.json", import.meta.url),
  JSON.stringify(fixture, null, 2) + "\n",
);
console.log("wrote fixtures/pairing-vectors.json", sealed.length, "frames");
