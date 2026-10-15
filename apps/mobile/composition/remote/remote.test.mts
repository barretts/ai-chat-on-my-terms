/**
 * T103 remote composition: fake sealed session drives the chat conversation,
 * photo segmentation, sync glue (with the REAL SyncTransport on the caller
 * side), and the revoked-pairing guard.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createPairingQrV1 } from "@locallab/remote-crypto";
import { SyncTransport } from "@locallab/sync-transport";
import {
  EncryptedPayloadSchema,
  MAX_MEDIA_CHUNK_BYTES,
  type EncryptedPayload,
} from "@locallab/service-contracts/relay";
import { recordFromScan, type StoredPairing } from "../../features/remote";
import {
  createRemoteChatConnection,
  photoUploadPort,
  remoteConnectionGuarded,
  remoteSyncPorts,
  type RemoteSessionPort,
} from "./index";

/** Recording session port with a scripted inbound queue. */
function fakeSession(): RemoteSessionPort & {
  sent: EncryptedPayload[];
  deliver: (payload: EncryptedPayload) => void;
  closeReason: string | null;
} {
  const sent: EncryptedPayload[] = [];
  const listeners: ((payload: EncryptedPayload) => void)[] = [];
  return {
    sent,
    closeReason: null,
    send(payload) {
      try {
        EncryptedPayloadSchema.parse(payload);
      } catch (cause) {
        assert.fail(`sent payload must satisfy EncryptedPayloadSchema: ${String(cause)}`);
      }
      sent.push(payload);
    },
    onPayload(cb) {
      listeners.push(cb);
    },
    close(reason) {
      this.closeReason = reason ?? null;
    },
    deliver(payload) {
      for (const listener of listeners) listener(payload);
    },
  };
}

const fingerprint = `sha256:${"ab12cd34".repeat(8)}`;
const pairingQr = createPairingQrV1({
  relayUrl: "http://127.0.0.1:9",
  serverIdentityFingerprint: fingerprint,
});

function runEvent(runId: string, event: Record<string, unknown>): EncryptedPayload {
  return {
    tag: "event",
    event: {
      runId,
      sequence: 0,
      timestamp: "2026-10-14T12:00:00.000Z",
      ...event,
    },
  } as EncryptedPayload;
}

function parseBody(payload: EncryptedPayload): Record<string, unknown> {
  assert.equal(payload.tag, "request");
  if (payload.tag !== "request") throw new Error("unreachable");
  return payload.body as Record<string, unknown>;
}

describe("createRemoteChatConnection", () => {
  it("accumulates TextDeltas and resolves on the matching chat-complete", async () => {
    const session = fakeSession();
    const connection = createRemoteChatConnection(session, {
      routeId: pairingQr.companionRouteId,
      label: "Home Mac",
    });
    assert.equal(connection.modelId, "Home Mac");
    const deltas: string[] = [];
    const streaming = connection.streamRun(
      [{ role: "user", content: "hello companion" }],
      pairingQr.companionRouteId,
      { onDelta: (text) => deltas.push(text) },
    );
    const request = parseBody(session.sent[0]!);
    assert.equal(request.type, "chat-request");
    assert.equal(request.routeId, pairingQr.companionRouteId);
    assert.deepEqual(request.messages, [{ role: "user", content: "hello companion" }]);
    assert.deepEqual(request.tools, []);
    const runId = String(request.runId);
    assert.match(runId, /^[0-9a-f-]{36}$/);

    session.deliver(runEvent(runId, { type: "RunStarted" }));
    session.deliver(runEvent(runId, { type: "TextDelta", text: "Hi " }));
    session.deliver(runEvent(runId, { type: "TextDelta", text: "there" }));
    session.deliver(runEvent(runId, { type: "RunCompleted" }));
    session.deliver({ tag: "request", body: { type: "chat-complete", runId } });

    const result = await streaming;
    assert.equal(result.runId, runId);
    assert.equal(result.text, "Hi there");
    assert.deepEqual(deltas, ["Hi ", "there"]);
  });

  it("cancelRun seals a cancel naming the run", async () => {
    const session = fakeSession();
    const connection = createRemoteChatConnection(session, {
      routeId: pairingQr.companionRouteId,
      label: "Home Mac",
    });
    const streaming = connection.streamRun([{ role: "user", content: "stop soon" }], "route-x", {
      onDelta: () => {},
    });
    const runId = String(parseBody(session.sent[0]!).runId);
    connection.cancelRun(runId);
    const cancel = session.sent[1]!;
    assert.equal(cancel.tag, "cancel");
    assert.deepEqual(cancel, { tag: "cancel", reason: runId });
    session.deliver(runEvent(runId, { type: "RunCanceled", reason: "user cancel" }));
    session.deliver({ tag: "request", body: { type: "chat-complete", runId } });
    const result = await streaming;
    assert.equal(result.text, "");
  });
});

describe("photoUploadPort", () => {
  it("segments 300000 bytes into ceil(len/262144) chunks that re-decode identically", async () => {
    const session = fakeSession();
    const upload = photoUploadPort(session);
    const bytes = new Uint8Array(300_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + (i >> 8)) % 256;
    await upload(bytes, "image/jpeg", "a".repeat(64));

    const start = session.sent[0]!;
    assert.equal(start.tag, "binary-start");
    if (start.tag !== "binary-start") throw new Error("unreachable");
    assert.equal(start.length, bytes.length);
    assert.equal(start.mimeType, "image/jpeg");
    assert.equal(start.sha256, "a".repeat(64));

    const expectedChunks = Math.ceil(bytes.length / MAX_MEDIA_CHUNK_BYTES);
    const chunks = session.sent.filter((payload) => payload.tag === "binary-chunk");
    assert.equal(chunks.length, expectedChunks);
    const assembled = Buffer.concat(
      chunks.map((chunk, position) => {
        if (chunk.tag !== "binary-chunk") throw new Error("unreachable");
        assert.equal(chunk.index, position, "chunk indexes must be sequential");
        assert.equal(chunk.transferId, start.transferId);
        assert.ok(
          Buffer.from(chunk.bytesBase64Url, "base64url").length <= MAX_MEDIA_CHUNK_BYTES,
          "each decoded chunk must honor MAX_MEDIA_CHUNK_BYTES",
        );
        return Buffer.from(chunk.bytesBase64Url, "base64url");
      }),
    );
    assert.deepEqual(assembled, Buffer.from(bytes));
    const end = session.sent[session.sent.length - 1]!;
    assert.deepEqual(end, { tag: "binary-end", transferId: start.transferId });
  });

  it("rejects a malformed sha256 before sending anything", async () => {
    const session = fakeSession();
    const upload = photoUploadPort(session);
    await assert.rejects(
      () => upload(new Uint8Array([1, 2, 3]), "image/png", "not-a-digest"),
      /sha256 hex digest/,
    );
    assert.equal(session.sent.length, 0);
  });
});

describe("remoteSyncPorts", () => {
  function syncRecord(id: string): Record<string, unknown> {
    return {
      id,
      createdAt: "2026-10-14T11:00:00.000Z",
      updatedAt: "2026-10-14T12:00:00.000Z",
      revision: { wallMs: 1_760_000_000_000, counter: 1, deviceId: id },
      entityType: "conversation",
      entityId: id,
      payload: { title: "sync me" },
      acknowledgedAt: null,
    };
  }

  it("routes batches through the session and acks back into SyncTransport", async () => {
    const session = fakeSession();
    let transport: SyncTransport;
    const ports = remoteSyncPorts(session, pairingQr.companionRouteId, () => true, (payload) =>
      transport.handleAck(payload),
    );
    transport = new SyncTransport({
      routeId: pairingQr.companionRouteId,
      send: ports.send,
      allowed: () => true,
    });
    assert.equal(transport.enqueue([syncRecord(createTestRecordId(1))]), 1);
    await transport.sendPending();
    const batch = session.sent[0]!;
    assert.equal(batch.tag, "sync-batch");
    if (batch.tag !== "sync-batch") throw new Error("unreachable");
    assert.equal(batch.records.length, 1);

    // inbound sync-ack on the session lands in the transport's ack set
    session.deliver({ tag: "sync-ack", recordIds: batch.records.map((record) => record.id) });
    assert.equal(transport.status().pendingRecords, 0);

    // handleAck validates a raw frame object and routes acks too
    assert.equal(ports.handleAck({ tag: "sync-ack", recordIds: [createTestRecordId(2)] }), true);
    assert.equal(ports.handleAck({ tag: "close" }), false);
    assert.equal(ports.handleAck("not-an-object"), false);
  });

  it("refuses sends while the pair is not opted in", async () => {
    const session = fakeSession();
    const ports = remoteSyncPorts(session, "route-x", () => false, () => {});
    await assert.rejects(
      () => ports.send({ tag: "sync-batch", records: [] }, "request-1"),
      /not allowed/,
    );
    assert.equal(session.sent.length, 0);
  });

  it("records a refusal and closes the session", async () => {
    const session = fakeSession();
    const ports = remoteSyncPorts(session, "route-x", () => true, () => {});
    ports.refuse();
    assert.deepEqual(ports.refused(), {
      type: "sync-refused",
      reason: "the paired device refused sync",
    });
    assert.equal(session.closeReason, "sync-refused");
    await assert.rejects(
      () => ports.send({ tag: "sync-batch", records: [] }, "request-2"),
      /refused/,
    );
  });
});

describe("remoteConnectionGuarded", () => {
  const live: StoredPairing = recordFromScan(pairingQr, "Home Mac", "2026-10-14T12:00:00.000Z");
  const revoked: StoredPairing = {
    ...live,
    revokedAt: "2026-10-14T13:00:00.000Z",
  };

  it("blocks revoked pairings with a re-pair note", () => {
    const blocked = remoteConnectionGuarded([revoked], pairingQr.companionRouteId);
    assert.equal(blocked.ok, false);
    if (blocked.ok) throw new Error("unreachable");
    assert.match(blocked.note, /revoked/i);
  });

  it("allows live pairings", () => {
    assert.deepEqual(remoteConnectionGuarded([live], pairingQr.companionRouteId), { ok: true });
  });

  it("blocks unknown routes with a pairing note", () => {
    const blocked = remoteConnectionGuarded([live], createPairingQrV1({ relayUrl: "http://127.0.0.1:9", serverIdentityFingerprint: fingerprint }).companionRouteId);
    assert.equal(blocked.ok, false);
    if (blocked.ok) throw new Error("unreachable");
    assert.match(blocked.note, /pair/i);
  });
});

function createTestRecordId(n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-7000-8000-${hex}`;
}
