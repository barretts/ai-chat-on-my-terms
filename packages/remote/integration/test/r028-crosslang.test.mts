/**
 * R028 cross-language proof (half 2). The Rust companion (`cargo test` in
 * apps/companion) opens the TS-sealed chat-request sealed with the keys in
 * crypto/fixtures/pairing-vectors.json (fixture: apps/companion/composition/
 * remote/fixtures/r028-request-wire.json) and writes the sealed response
 * frames it produced to a temp marker. This test replays BOTH directions
 * through fresh TS channels with the strict contract schema and the
 * replay-window opener: the request must open on a TS companion channel
 * (proving Rust and TS derive identical keys) and every Rust-emitted
 * response frame must satisfy exactly what the phone's TS stack enforces —
 * protocol pair, routeId, monotonic sequences, payload shapes, replay
 * rejection.
 *
 * Run `cargo test` in apps/companion first; without a marker the test skips
 * loudly instead of silently passing.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EncryptedRelayFrameV1Schema,
  validateRelayFrameSize,
  type EncryptedPayload,
  type EncryptedRelayFrameV1,
} from "@locallab/service-contracts/relay";
import { createSessionPairing, type SessionEntropy } from "@locallab/remote-crypto";

const vectors = JSON.parse(
  readFileSync(new URL("../../../remote/crypto/fixtures/pairing-vectors.json", import.meta.url), "utf8"),
);
const wire = JSON.parse(
  readFileSync(
    new URL("../../../../apps/companion/composition/remote/fixtures/r028-request-wire.json", import.meta.url),
    "utf8",
  ),
);

const markerPath = join(tmpdir(), "locallab-r028-crosslang.json");

function frameOf(raw: unknown): EncryptedRelayFrameV1 {
  const checked = EncryptedRelayFrameV1Schema.parse(raw);
  validateRelayFrameSize(checked);
  return checked;
}

test(
  "TS-sealed request opens on the Rust-derived keys and Rust response frames replay through the TS stack",
  {
    skip: existsSync(markerPath)
      ? false
      : "no Rust response marker in tmpdir — run `cargo test` in apps/companion first",
  },
  () => {
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.equal(marker.routeId, wire.routeId, "the Rust run used the wire fixture's route");
    assert.equal(marker.runId, wire.runId, "the Rust run used the wire fixture's run id");

    const entropy: SessionEntropy = {
      mobileEphemeral: new Uint8Array(Buffer.from(vectors.mobileEphemeralBase64Url, "base64url")),
      companionEphemeral: new Uint8Array(Buffer.from(vectors.companionEphemeralBase64Url, "base64url")),
    };
    const pairing = createSessionPairing(
      new Uint8Array(Buffer.from(vectors.pairingSecretBase64Url, "base64url")),
      new Uint8Array(Buffer.from(vectors.mobileSaltBase64Url, "base64url")),
      new Uint8Array(Buffer.from(vectors.companionSaltBase64Url, "base64url")),
      entropy,
      wire.routeId,
    );

    // Direction 1: TS-sealed request -> opened on a companion-side TS channel
    // built from the same vectors the Rust test derives its keys from. If the
    // two stacks disagreed on any KDF input this open fails.
    const requestFrame = frameOf(wire.frame);
    const request = pairing.companion.fromMobile.open(requestFrame);
    assert.equal(request.tag, "request");
    const body = request.body as Record<string, unknown>;
    assert.equal(body.type, "chat-request");
    assert.equal(body.version, 1, "the companion accepts the stamped payload version");
    assert.equal(body.runId, wire.runId);
    assert.equal(body.routeId, wire.routeId);
    assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
    assert.deepEqual(body.tools, []);

    // Direction 2: the frames the Rust companion emitted for that request
    // must replay through the phone's opening channel untouched.
    const opener = pairing.mobile.fromCompanion;
    const payloads: EncryptedPayload[] = [];
    let expectedSequence = 0;
    const seenRequestIds = new Set<string>();
    for (const raw of marker.frames) {
      const frame = frameOf(raw);
      assert.equal(frame.routeId, wire.routeId, "every response frame rides the session route");
      // Protocol minor 1.2 since cb44ec5 (R007/CR001 random handshake nonces):
      // PAIRING_PROTOCOL in service-contracts/pairing.ts is frozen at {1,2},
      // pairing-vectors.json and r028-request-wire.json KATs carry minor 2, and
      // the TS opener that consumes these frames below requires minor == 2.
      assert.deepEqual(frame.protocol, { major: 1, minor: 2 }, "Rust negotiates the phone's protocol");
      assert.equal(frame.sequence, expectedSequence, "response sequences are monotonic from 0");
      expectedSequence += 1;
      seenRequestIds.add(frame.requestId);
      payloads.push(opener.open(frame));
    }
    assert.equal(payloads.length, 6, "RunStarted + 3 TextDeltas + RunCompleted + chat-complete");
    assert.ok(
      [...seenRequestIds].every((id) => /^[0-9a-f-]{36}$/.test(id)),
      "response requestIds are UUIDv7",
    );

    const events = payloads.slice(0, 5).map((payload) => {
      if (payload.tag !== "event") throw new Error("response payload is not an event frame");
      const event = payload.event as Record<string, unknown>;
      assert.equal(event.runId, wire.runId);
      return event;
    });
    assert.equal(events[0]!.type, "RunStarted");
    assert.equal(events[1]!.type, "TextDelta");
    assert.equal(events[2]!.type, "TextDelta");
    assert.equal(events[3]!.type, "TextDelta");
    assert.equal(events[4]!.type, "RunCompleted");
    const deltas = payloads.slice(0, 5).flatMap((payload) => {
      if (payload.tag !== "event") return [];
      const event = payload.event as Record<string, unknown>;
      return event.type === "TextDelta" ? [String(event.text)] : [];
    });
    assert.equal(deltas.join(""), "Hello world", "the SSE deltas arrive intact and in order");

    const tail = payloads[5]!;
    assert.equal(tail.tag, "request");
    assert.deepEqual(tail.body, { type: "chat-complete", runId: wire.runId });

    // Hostile branch: replaying an accepted response frame must throw.
    const first = frameOf(marker.frames[0]);
    assert.throws(() => opener.open(first), /sequence/i, "the TS opener rejects Rust-emitted replays");
  },
);
