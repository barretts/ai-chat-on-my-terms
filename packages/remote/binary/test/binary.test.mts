/**
 * T097 smoke matrix: lossless binary forwarding with checksum integrity
 * (stands in for "ComfyUI/Kokoro checksums match local output"), duplicate
 * tolerance for slow relays/reconnects, bounded lengths, flow-control
 * credits and cancellation — including a live-relay sealed-frame pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MAX_MEDIA_CHUNK_BYTES, type EncryptedPayload } from "@locallab/service-contracts/relay";
import {
  BinaryReceiver,
  BinaryTransferError,
  BinaryWindow,
  MAX_BINARY_TOTAL_BYTES,
  binaryAckPayload,
  binaryFrames,
  fromBase64Url,
  readBinaryAck,
  sha256Hex,
  toBase64Url,
} from "../src/index.js";
import { createRelayServer } from "@locallab/relay";
import {
  createPairingQrV1,
  createSessionPairing,
  createUuidV7,
  deriveSessionSalts,
  mobileRouteTicketHash,
} from "@locallab/remote-crypto";

function pseudoRandomBytes(seed: number, length: number): Uint8Array {
  let state = seed >>> 0;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    // Force non-UTF8 sequences so any lossy text round-trip would break.
    bytes[i] = i % 97 === 0 ? 0xff : state & 0xff;
  }
  return bytes;
}

function feedAll(receiver: BinaryReceiver, frames: Iterable<EncryptedPayload>) {
  for (const frame of frames) {
    const outcome = receiver.push(frame);
    if (outcome === "finished") return;
  }
}

const TRANSFER = "0198f2a3-0000-7000-8000-0000000000b1";

test("binary round trip is lossless and checksums match the local bytes", () => {
  // 300 KiB: one full chunk + a fractional tail; contains raw 0xFF runs.
  const bytes = pseudoRandomBytes(0xc0ffee, MAX_MEDIA_CHUNK_BYTES + 40_000);
  const localSha = createHash("sha256").update(bytes).digest("hex");
  const receiver = new BinaryReceiver();
  feedAll(receiver, binaryFrames({ transferId: TRANSFER, mimeType: "image/png" }, bytes));
  assert.equal(receiver.mime(), "image/png");
  assert.equal(toBase64Url(receiver.bytes()), toBase64Url(bytes));
  assert.equal(sha256Hex(receiver.bytes()), localSha);
});

test("base64url survives the whole byte range (no lossy text step)", () => {
  const every = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.equal(toBase64Url(every).includes("+"), false);
  assert.equal(toBase64Url(every).includes("/"), false);
  assert.equal(toBase64Url(every).includes("="), false);
  assert.deepEqual(fromBase64Url(toBase64Url(every)), every);
});

test("re-delivered chunks are duplicates, never appended twice", () => {
  const bytes = pseudoRandomBytes(7, MAX_MEDIA_CHUNK_BYTES + 5);
  const receiver = new BinaryReceiver();
  const dupes: EncryptedPayload[] = [];
  for (const frame of binaryFrames({ transferId: TRANSFER, mimeType: "audio/wav" }, bytes)) {
    const outcome = receiver.push(frame);
    if (frame.tag === "binary-chunk" && frame.index === 1) dupes.push(frame);
    if (outcome === "finished") break;
  }
  assert.equal(dupes.length, 1);
  // Slow relay redelivers chunk 1 before end arrives? It already ended; use
  // a fresh receiver to replay mid-stream:
  const replay = new BinaryReceiver();
  let seenEnd = false;
  for (const frame of binaryFrames({ transferId: TRANSFER, mimeType: "audio/wav" }, bytes)) {
    if (seenEnd) break;
    if (frame.tag === "binary-end") seenEnd = true;
    replay.push(frame);
    if (frame.tag === "binary-chunk" && frame.index === 1) {
      assert.equal(replay.push(frame), "duplicate");
      assert.equal(replay.push(frame), "duplicate");
    }
  }
  assert.equal(sha256Hex(replay.bytes()), sha256Hex(bytes));
});

test("gap, truncation and tampered checksums fail closed", () => {
  const bytes = pseudoRandomBytes(11, MAX_MEDIA_CHUNK_BYTES * 2 + 10);
  const frames = [...binaryFrames({ transferId: TRANSFER, mimeType: "image/jpeg" }, bytes)];
  const chunkStart = frames.findIndex((f) => f.tag === "binary-chunk" && f.index === 1);

  const gapped = new BinaryReceiver();
  assert.throws(() => {
    for (let i = 0; i < frames.length; i += 1) {
      if (i === chunkStart) continue;
      gapped.push(frames[i]!);
    }
  }, (error: unknown) => error instanceof BinaryTransferError && error.kind === "sequence");

  const truncated = new BinaryReceiver();
  for (const frame of frames) {
    if (frame.tag === "binary-end") break;
    if (frame.tag === "binary-chunk" && frame.index === 2) continue;
    truncated.push(frame);
  }
  const tailFrames = frames.filter((f) => f.tag === "binary-end");
  assert.throws(() => truncated.push(tailFrames[0]!), (error: unknown) => {
    return error instanceof BinaryTransferError && error.kind === "sequence" && /of/.test(error.message);
  });

  const start = frames[0]!;
  if (start.tag !== "binary-start") throw new Error("first frame must be binary-start");
  const tamperedStart: EncryptedPayload = {
    ...start,
    sha256: "00".repeat(32),
  };
  const tampered = new BinaryReceiver();
  tampered.push(tamperedStart);
  for (const frame of frames.slice(1, -1)) tampered.push(frame);
  assert.throws(() => tampered.push(frames[frames.length - 1]!), (error: unknown) => {
    return error instanceof BinaryTransferError && error.kind === "checksum";
  });
});

test("declared or observed oversize is rejected", () => {
  const receiver = new BinaryReceiver();
  assert.throws(() => {
    receiver.push({
      tag: "binary-start",
      transferId: TRANSFER,
      mimeType: "image/png",
      length: MAX_BINARY_TOTAL_BYTES + 1,
      sha256: "ab".repeat(32),
    });
  }, (error: unknown) => error instanceof BinaryTransferError && error.kind === "oversize");

  const fatChunk: EncryptedPayload = {
    tag: "binary-chunk",
    transferId: TRANSFER,
    index: 0,
    bytesBase64Url: toBase64Url(new Uint8Array(MAX_MEDIA_CHUNK_BYTES + 1)),
  };
  const oversized = new BinaryReceiver();
  oversized.push({
    tag: "binary-start",
    transferId: TRANSFER,
    mimeType: "image/png",
    length: MAX_MEDIA_CHUNK_BYTES + 1,
    sha256: "ab".repeat(32),
  });
  assert.throws(() => oversized.push(fatChunk), (error: unknown) => {
    return error instanceof BinaryTransferError && error.kind === "oversize";
  });

  assert.throws(
    () => feedAll(new BinaryReceiver(), binaryFrames({ transferId: TRANSFER, mimeType: "image/png",
    }, pseudoRandomBytes(1, MAX_BINARY_TOTAL_BYTES + 64 * 1024))),
    (error: unknown) => error instanceof BinaryTransferError && error.kind === "oversize",
  );
});

test("cancel abandons a partial transfer and the receiver restarts", () => {
  const bytes = pseudoRandomBytes(3, MAX_MEDIA_CHUNK_BYTES + 9);
  const receiver = new BinaryReceiver();
  const frames = [...binaryFrames({ transferId: TRANSFER, mimeType: "audio/mp4" }, bytes)];
  receiver.push(frames[0]!);
  receiver.push(frames[1]!);
  receiver.push({ tag: "cancel", reason: "backend stopped" });
  assert.throws(() => receiver.bytes(), (error: unknown) => {
    return error instanceof BinaryTransferError && error.kind === "state";
  });
  feedAll(receiver, binaryFrames({ transferId: "0198f2a3-0000-7000-8000-0000000000b2", mimeType: "audio/mp4" }, bytes));
  assert.equal(sha256Hex(receiver.bytes()), sha256Hex(bytes));
});

test("flow control keeps at most the window of chunks in flight", () => {
  const window = new BinaryWindow(2);
  assert.equal(window.canSend(), true);
  window.onSent();
  window.onSent();
  assert.equal(window.canSend(), false);
  window.ack(0);
  assert.equal(window.inFlight(), 1);
  assert.equal(window.canSend(), true);
  window.onSent();
  window.ack(1);
  window.ack(0); // stale ack never rewinds credit
  assert.equal(window.inFlight(), 1);
  assert.throws(() => new BinaryWindow(0), (error: unknown) => error instanceof BinaryTransferError);
});

test("binary-ack credits round-trip through request envelopes", () => {
  const ack = binaryAckPayload(TRANSFER, 7);
  assert.deepEqual(readBinaryAck(ack), { transferId: TRANSFER, index: 7 });
  assert.equal(readBinaryAck({ tag: "health", nonce: "nonce-nonce-nonce" }), null);
  assert.equal(readBinaryAck({ tag: "request", body: { type: "pairing-hello" } }), null);
});

test("sealed frames through a live relay forward without corruption or duplication", async () => {
  const { relay, base } = await startRelay();
  try {
    const qr = createPairingQrV1({ relayUrl: base, serverIdentityFingerprint: `sha256:${"ab12cd34".repeat(8)}` });
    const secret = Buffer.from(qr.pairingSecret, "base64url");
    const salts = deriveSessionSalts(secret, qr.companionRouteId);
    const session = createSessionPairing(secret, salts.mobileSalt, salts.companionSalt, qr.companionRouteId);

    // Companion registers the route first; the mobile consumer must be
    // online BEFORE frames flow, because the relay drops frames whose
    // target peer is offline.
    const companionSocket = new WebSocket(
      `${base.replace("http://", "ws://")}/companion?routeId=${qr.companionRouteId}` +
        "&credential=companion-credential-0000" +
        `&mobileTicketHash=${mobileRouteTicketHash(qr.mobileRouteTicket)}`,
    );
    const opened = Promise.withResolvers<void>();
    companionSocket.addEventListener("open", () => opened.resolve());
    await opened.promise;

    const mobileSocket = new WebSocket(
      `${base.replace("http://", "ws://")}/mobile?routeId=${qr.companionRouteId}&ticket=${qr.mobileRouteTicket}`,
    );
    const receiver = new BinaryReceiver();
    const mobileOpened = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    mobileSocket.addEventListener("open", () => mobileOpened.resolve());
    mobileSocket.addEventListener("message", (event) => {
      const payload = session.mobile.fromCompanion.open(JSON.parse(String(event.data)));
      if (receiver.push(payload) === "finished") finished.resolve();
    });
    await mobileOpened.promise;

    const bytes = pseudoRandomBytes(0xbeef, MAX_MEDIA_CHUNK_BYTES + 128);
    for (const frame of binaryFrames({ transferId: TRANSFER, mimeType: "image/png" }, bytes)) {
      companionSocket.send(JSON.stringify(session.companion.toMobile.seal(frame, createUuidV7())));
    }
    await finished.promise;
    assert.equal(sha256Hex(receiver.bytes()), sha256Hex(bytes));

    // Transfer-layer duplicate handling for slow-relay re-delivery: the
    // same chunk arriving again never appends twice.
    const allFrames = [...binaryFrames({ transferId: TRANSFER, mimeType: "image/png" }, bytes)];
    const probe = new BinaryReceiver();
    probe.push(allFrames[0]!);
    const firstChunk = allFrames[1]!;
    assert.equal(probe.push(firstChunk), "accepted");
    assert.equal(probe.push(firstChunk), "duplicate");
    assert.equal(probe.push(firstChunk), "duplicate");
  } finally {
    await relay.close();
  }
});

async function startRelay() {
  const relay = createRelayServer();
  const listening = Promise.withResolvers<void>();
  relay.server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = relay.server.address();
  if (address === null || typeof address === "string") throw new Error("expected tcp address");
  return { relay, base: `http://127.0.0.1:${address.port}` };
}
