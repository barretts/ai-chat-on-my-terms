import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildUsbHello,
  buildUsbReady,
  encodeFrame,
  FrameDecoder,
  MAX_USB_PAYLOAD_BYTES,
  ModeGuard,
  UsbDeviceTracker,
  UsbFrameError,
  USB_PROTOCOL,
  verifyUsbHello,
  verifyUsbReady,
  type UsbPairingRecord,
} from "../src/index.js";

function readJson(relative: string) {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

function b64url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function hexToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "hex"));
}

function hexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

const frameVectors = readJson("../fixtures/usb-frame-vectors.json");

test("golden USB frame vectors match the companion byte-for-byte", () => {
  assert.equal(frameVectors.protocol, USB_PROTOCOL);
  assert.equal(frameVectors.maxPayloadBytes, MAX_USB_PAYLOAD_BYTES);
  for (const vector of frameVectors.frames) {
    const payload = b64url(vector.payloadBase64Url);
    assert.equal(hexOf(encodeFrame(payload)), vector.frameHex, `encode ${vector.name}`);
    const decoder = new FrameDecoder();
    const frames = decoder.push(hexToBytes(vector.frameHex));
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0], payload);
    assert.equal(decoder.buffered(), 0);
  }
});

test("fragmented cable reads reassemble in order", () => {
  const stream = new Uint8Array([
    ...encodeFrame(new TextEncoder().encode("one")),
    ...encodeFrame(new TextEncoder().encode("two!")),
    ...encodeFrame(new TextEncoder().encode("three")),
  ]);
  const decoder = new FrameDecoder();
  const got: string[] = [];
  for (let start = 0; start < stream.length; start += 3) {
    for (const frame of decoder.push(stream.subarray(start, start + 3))) {
      got.push(new TextDecoder().decode(frame));
    }
  }
  assert.deepEqual(got, ["one", "two!", "three"]);
  assert.equal(decoder.buffered(), 0);
});

test("oversize declaration kills the channel", () => {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, MAX_USB_PAYLOAD_BYTES + 1, false);
  const decoder = new FrameDecoder();
  assert.throws(() => decoder.push(header), (error: unknown) => error instanceof UsbFrameError && error.kind === "oversize");
  assert.equal(decoder.buffered(), 0);
});

const pairing = readJson("../../../../packages/remote/crypto/fixtures/pairing-vectors.json");

const record: UsbPairingRecord = {
  routeId: pairing.routeId,
  pairingSecret: b64url(pairing.pairingSecretBase64Url),
  mobileSalt: b64url(pairing.mobileSaltBase64Url),
  companionSalt: b64url(pairing.companionSaltBase64Url),
};

const mobileEphemeral = b64url(pairing.mobileEphemeralBase64Url);
const companionEphemeral = b64url(pairing.companionEphemeralBase64Url);

test("QR pairing material authenticates the USB handshake unchanged", () => {
  const hello = buildUsbHello(record, mobileEphemeral);
  // The proof the iPhone puts on the cable is the SAME value the pairing
  // golden vectors pin — no new secret material, nothing new to derive.
  assert.equal(hello.proof, pairing.helloProofBase64Url);
  // R007: the hello also carries the phone's fresh session ephemeral.
  assert.equal(hello.sessionSalt, pairing.mobileEphemeralBase64Url);
  assert.deepEqual(verifyUsbHello(hello, [record]), {
    status: "authenticated",
    routeId: record.routeId,
    mobileEphemeral: mobileEphemeral,
  });
  const routes = [{ id: "default", backend: "lmstudio", label: "LM Studio" }];
  const ready = buildUsbReady(record, routes, companionEphemeral);
  assert.deepEqual(verifyUsbReady(ready, record), { routes, companionEphemeral });
});

test("forged proofs, unknown routes and stale protocols fail closed", () => {
  const forged = { ...buildUsbHello(record, mobileEphemeral), proof: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
  assert.equal(verifyUsbHello(forged, [record]).status, "unauthorized");
  const unknownRoute = { ...buildUsbHello(record, mobileEphemeral), routeId: "0198f2a3-0000-7000-8000-0000000000ff" };
  assert.equal(verifyUsbHello(unknownRoute, [record]).status, "unauthorized");
  const stale = { ...buildUsbHello(record, mobileEphemeral), protocol: "locallab-usb-v0" };
  assert.equal(verifyUsbHello(stale, [record]).status, "version-mismatch");
  const empty = { ...buildUsbHello(record, mobileEphemeral), tag: "usb-hi" };
  assert.equal(verifyUsbHello(empty, [record]).status, "malformed");
  // R007: a hello without (or with a malformed) ephemeral is malformed —
  // there is no silent fallback to deterministic keys.
  assert.equal(verifyUsbHello({ ...buildUsbHello(record, mobileEphemeral), sessionSalt: "short" }, [record]).status, "malformed");
  // A cable peer that could not verify the hello cannot fake the ready echo.
  assert.equal(verifyUsbReady({ tag: "usb-ready", protocol: USB_PROTOCOL, proof: "nope-nope-nope-nope-nope", routes: [] }, record), null);
  // A ready whose ephemeral is malformed is refused even with a valid proof.
  const readyBadSalt = { ...buildUsbReady(record, [], companionEphemeral), sessionSalt: "short!" };
  assert.equal(verifyUsbReady(readyBadSalt, record), null);
});

test("remote and USB sessions are mutually exclusive per pairing", () => {
  const guard = new ModeGuard();
  assert.equal(guard.modeOf(record.routeId), null);
  assert.deepEqual(guard.claim(record.routeId, "usb"), { ok: true });
  const refused = guard.claim(record.routeId, "remote");
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.match(refused.message, /usb session/);
  }
  assert.deepEqual(guard.claim(record.routeId, "usb"), { ok: true });
  assert.equal(guard.release(record.routeId, "remote"), false);
  assert.equal(guard.release(record.routeId, "usb"), true);
  assert.deepEqual(guard.claim(record.routeId, "remote"), { ok: true });
});

test("cable state machine requires trust and resets on unplug", () => {
  const tracker = new UsbDeviceTracker();
  assert.equal(tracker.current(), "unattached");
  tracker.attach(false);
  assert.equal(tracker.current(), "untrusted");
  assert.equal(tracker.markActive(), false);
  tracker.trustGranted();
  assert.equal(tracker.markActive(), true);
  assert.match(tracker.note(), /remote mode is off/);
  tracker.detach();
  assert.equal(tracker.current(), "unattached");
  assert.match(tracker.note(), /No Mac connected over USB/);
});
