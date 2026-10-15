/**
 * T098C smoke matrix: chunked encrypted batches, bounded retries with a
 * resume cursor that survives dropped/duplicated/reordered frames, the
 * hard "disabled pair never queues" gate, host-wake resume, and receiver
 * dedup through the T098B merge store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncTransport, SyncTransportError, syncAckPayload } from "../src/index.js";
import { MergeStore } from "@locallab/sync-merge";
import { EncryptedPayloadSchema } from "@locallab/service-contracts/relay";

const DEV = "0198f2a3-0000-7000-8000-0000000000aa";
const ROUTE = "0198f2a3-0000-7000-8000-0000000000f0";
const hex = (n: number) => n.toString(16).padStart(12, "0");
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const T0 = "2026-10-01T00:00:00.000Z";
const id = (n: number) => `0198f2a3-0000-7000-8000-${hex(n)}`;

const record = (n: number) => ({
  id: id(n),
  createdAt: T0,
  updatedAt: T0,
  revision: { wallMs: n, counter: 0, deviceId: DEV },
  entityType: "message",
  entityId: id(10_000 + n),
  payload: {
    id: id(10_000 + n),
    createdAt: T0,
    updatedAt: T0,
    revision: { wallMs: n, counter: 0, deviceId: DEV },
    conversationId: id(1),
    role: "user",
    parts: [{ type: "text", text: `hello ${n}` }],
    selectedVariantId: null,
    runStatus: "completed",
  },
  acknowledgedAt: null,
});

const records = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => record(from + i));

const noDelay = async () => {};

test("batches are chunked to the frozen cap and drained by acks", async () => {
  const sent: { ids: string[]; requestId: string }[] = [];
  const transport = new SyncTransport({
    routeId: ROUTE,
    allowed: () => true,
    delay: noDelay,
    send: async (payload, requestId) => {
      EncryptedPayloadSchema.parse(payload);
      assert.match(requestId, UUID7, "requestIds follow the pairing wire contract");
      sent.push({ ids: payload.records.map((r) => r.id), requestId });
      // The receiver acks every record it applied.
      transport.handleAck({ tag: "sync-ack", recordIds: payload.records.map((r) => r.id) });
    },
  });
  assert.equal(transport.enqueue(records(0, 600)), 600);
  assert.equal(transport.status().pendingRecords, 600);
  await transport.sendPending();
  assert.equal(sent.length, 2, "500 + 100 records");
  assert.deepEqual(sent[0]!.ids.length, 500);
  assert.deepEqual(sent[1]!.ids.length, 100);
  assert.deepEqual(transport.status(), {
    state: "idle",
    note: "",
    pendingRecords: 0,
    resumeCursor: 2,
    attempts: 0,
  });
});

test("a disabled pair never queues or sends", async () => {
  let sends = 0;
  const transport = new SyncTransport({
    routeId: ROUTE,
    allowed: () => false,
    delay: noDelay,
    send: async () => {
      sends += 1;
    },
  });
  assert.equal(transport.enqueue(records(0, 3)), 0);
  await transport.sendPending();
  assert.equal(sends, 0);
  const status = transport.status();
  assert.equal(status.state, "disabled");
  assert.ok(/off/i.test(status.note));
  assert.equal(status.resumeCursor, 0);
});

test("dropped frames retry bounded then resume via wake without resending acked batches", async () => {
  const sentIds: string[][] = [];
  let healthy = false;
  let failCount = 0;
  const transport = new SyncTransport({
    routeId: ROUTE,
    allowed: () => true,
    maxAttempts: 3,
    delay: noDelay,
    send: async (payload) => {
      const ids = payload.records.map((r) => r.id);
      sentIds.push(ids);
      const batchTwo = ids[0] === id(500);
      if (batchTwo && !healthy) {
        failCount += 1;
        throw new Error("socket dropped");
      }
      transport.handleAck({ tag: "sync-ack", recordIds: ids });
    },
  });
  transport.enqueue(records(0, 600));
  await transport.sendPending();
  assert.equal(failCount, 3, "bounded attempts then suspend");
  const failed = transport.status();
  assert.equal(failed.state, "failed");
  assert.ok(failed.note.length > 0, "SY-08: failure surfaced to the user");
  assert.equal(failed.resumeCursor, 1, "acked batch 1 stays acked");
  assert.equal(failed.pendingRecords, 100);

  // Host wake (or the off/on retry toggle): resume from the cursor only.
  healthy = true;
  transport.wake();
  await transport.sendPending();
  assert.deepEqual(transport.status().resumeCursor, 2);
  const afterWake = sentIds.slice(4);
  assert.ok(afterWake.every((ids) => ids[0] === id(500)), "batch 1 never re-sent");
  assert.equal(transport.status().state, "idle");
});

test("duplicated and stale acks resume idempotently", async () => {
  const batches: { tag: "sync-batch"; records: { id: string }[] }[] = [];
  const transport = new SyncTransport({
    routeId: ROUTE,
    allowed: () => true,
    delay: noDelay,
    send: async (payload) => {
      batches.push(payload);
    },
  });
  transport.enqueue(records(0, 600));
  await transport.sendPending();
  assert.equal(batches.length, 1, "window of one in flight");

  // A stale/unknown ack must not move the cursor.
  transport.handleAck({ tag: "sync-ack", recordIds: [id(99_999)] });
  assert.equal(transport.status().resumeCursor, 0);
  assert.equal(transport.status().pendingRecords, 600);

  // Duplicated acks drain the head exactly once.
  const one = syncAckPayload(batches[0]!.records.map((r) => r.id));
  transport.handleAck(one);
  transport.handleAck(one);
  assert.equal(transport.status().resumeCursor, 1);
  assert.equal(transport.status().pendingRecords, 100);

  // Pump again: batch 2 goes out; duplicate acks and a stale replay are no-ops.
  await transport.sendPending();
  assert.equal(batches.length, 2);
  const two = syncAckPayload(batches[1]!.records.map((r) => r.id));
  transport.handleAck(two);
  transport.handleAck(two);
  transport.handleAck(one);
  assert.equal(transport.status().resumeCursor, 2);
  assert.equal(transport.status().pendingRecords, 0);

  assert.throws(
    () => transport.handleAck({ tag: "request", body: {} }),
    (error: unknown) => error instanceof SyncTransportError && error.kind === "malformed",
  );
});

test("re-delivered batches dedup in the receiver merge store", async () => {
  const receiver = new MergeStore();
  const transport = new SyncTransport({
    routeId: ROUTE,
    allowed: () => true,
    delay: noDelay,
    send: async (payload) => {
      // Simulate reconnect: the SAME frame reaches the peer twice.
      for (let replay = 0; replay < 2; replay += 1) {
        const accepted: string[] = [];
        for (const change of payload.records) {
          receiver.apply(change);
          accepted.push(change.id);
        }
        transport.handleAck({ tag: "sync-ack", recordIds: accepted });
      }
    },
  });
  transport.enqueue(records(0, 3));
  await transport.sendPending();
  assert.equal(transport.status().resumeCursor, 1);
  assert.equal(receiver.liveCount(), 3, "duplicate frames do not duplicate rows");
  assert.equal(transport.status().state, "idle");
});

test("malformed records never enter the queue", () => {
  const transport = new SyncTransport({
    routeId: ROUTE,
    allowed: () => true,
    delay: noDelay,
    send: async () => {},
  });
  assert.throws(
    () => transport.enqueue([{ nope: 1 }]),
    (error: unknown) => error instanceof SyncTransportError && error.kind === "malformed",
  );
  assert.equal(transport.status().pendingRecords, 0);
});
