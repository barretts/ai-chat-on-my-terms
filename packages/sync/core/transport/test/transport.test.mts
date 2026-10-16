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
      transport.handleAck({
        tag: "sync-ack",
        batchId: payload.batchId,
        recordIds: payload.records.map((r) => r.id),
      });
    },
  });
  assert.equal(transport.enqueue(records(0, 600)), 600);
  assert.equal(transport.status().pendingRecords, 600);
  await transport.sendPending();
  assert.equal(sent.length, 2, "500 + 100 records");
  assert.deepEqual(sent[0]!.ids.length, 500);
  assert.deepEqual(sent[1]!.ids.length, 100);
  // R008/CR005 (commit cb44ec5) added `pendingBatches` to the status
  // contract (consumed by the composition delivery gate); the drained
  // queue reports an empty batch count alongside the empty record count.
  assert.deepEqual(transport.status(), {
    state: "idle",
    note: "",
    pendingRecords: 0,
    pendingBatches: 0,
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
      transport.handleAck({
        tag: "sync-ack",
        batchId: payload.batchId,
        recordIds: ids,
      });
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
  const batches: { tag: "sync-batch"; batchId: string; records: { id: string }[] }[] = [];
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

  // A correct-id ack naming the wrong (unknown) batch must not move the
  // cursor, and an ack on the right batch carrying an unknown id must not
  // either: only per-batch bookkeeping drains.
  transport.handleAck({
    tag: "sync-ack",
    batchId: id(42_424),
    recordIds: batches[0]!.records.map((r) => r.id),
  });
  transport.handleAck({ tag: "sync-ack", batchId: batches[0]!.batchId, recordIds: [id(99_999)] });
  assert.equal(transport.status().resumeCursor, 0);
  assert.equal(transport.status().pendingRecords, 600);

  // Duplicated acks drain the head exactly once.
  const one = syncAckPayload(batches[0]!.batchId, batches[0]!.records.map((r) => r.id));
  transport.handleAck(one);
  transport.handleAck(one);
  assert.equal(transport.status().resumeCursor, 1);
  assert.equal(transport.status().pendingRecords, 100);

  // Pump again: batch 2 goes out; duplicate acks and a stale replay are no-ops.
  await transport.sendPending();
  assert.equal(batches.length, 2);
  const two = syncAckPayload(batches[1]!.batchId, batches[1]!.records.map((r) => r.id));
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
        transport.handleAck({ tag: "sync-ack", batchId: payload.batchId, recordIds: accepted });
      }
    },
  });
  transport.enqueue(records(0, 3));
  await transport.sendPending();
  assert.equal(transport.status().resumeCursor, 1);
  assert.equal(receiver.liveCount(), 3, "duplicate frames do not duplicate rows");
  assert.equal(transport.status().state, "idle");
});

test("R023: an acked record id re-enqueued (newer revision, then tombstone) still sends", async () => {
  const sent: { batchId: string; ids: string[] }[] = [];
  const transport = new SyncTransport({
    routeId: ROUTE,
    allowed: () => true,
    delay: noDelay,
    send: async (payload) => {
      EncryptedPayloadSchema.parse(payload);
      const ids = payload.records.map((r) => r.id);
      sent.push({ batchId: payload.batchId, ids });
      transport.handleAck(syncAckPayload(payload.batchId, ids));
    },
  });
  transport.enqueue([record(1)]);
  await transport.sendPending();
  assert.equal(sent.length, 1);
  assert.equal(transport.status().resumeCursor, 1);

  // Same record id, newer revision: an old acknowledgement must not
  // pre-ack the new batch (the R023 silent-drop).
  transport.enqueue([
    { ...record(1), revision: { wallMs: 999_001, counter: 0, deviceId: DEV } },
  ]);
  await transport.sendPending();
  assert.equal(sent.length, 2, "acked ids are scoped to their batch, not global");
  assert.deepEqual(sent[1]!.ids, [id(1)]);
  assert.notEqual(sent[1]!.batchId, sent[0]!.batchId, "each batch carries a fresh identity");

  // The deletion under the same entity id (tombstone reuses the id) also
  // reaches the wire instead of being silently dropped.
  transport.enqueue([tombstone("message", id(10_001), 2_000)]);
  await transport.sendPending();
  assert.equal(sent.length, 3, "the tombstone under an acked entity id must send");
  assert.equal(transport.status().resumeCursor, 3);
});

test("R023: a stale ack replayed for a drained batch cannot drain the newer batch", async () => {
  const sent: { batchId: string; ids: string[] }[] = [];
  const transport = new SyncTransport({
    routeId: ROUTE,
    allowed: () => true,
    delay: noDelay,
    send: async (payload) => {
      sent.push({ batchId: payload.batchId, ids: payload.records.map((r) => r.id) });
      // Acks are held back; the test drives them manually.
    },
  });
  transport.enqueue([record(1)]);
  await transport.sendPending();
  const ackOfBatchOne = syncAckPayload(sent[0]!.batchId, [id(1)]);
  transport.handleAck(ackOfBatchOne);
  assert.equal(transport.status().resumeCursor, 1);

  transport.enqueue([
    { ...record(1), revision: { wallMs: 999_002, counter: 0, deviceId: DEV } },
  ]);
  await transport.sendPending();
  assert.equal(sent.length, 2, "newer revision re-sends");

  // Replayed/delayed ack of batch 1 while batch 2 (same record id) is in
  // flight: it names a drained batch identity and must be rejected.
  transport.handleAck(ackOfBatchOne);
  assert.equal(transport.status().resumeCursor, 1, "stale ack cannot drain the newer batch");
  assert.equal(transport.status().pendingRecords, 1);

  transport.handleAck(syncAckPayload(sent[1]!.batchId, [id(1)]));
  assert.equal(transport.status().resumeCursor, 2);
  assert.equal(transport.status().pendingRecords, 0);
});

const tombstone = (entityType: string, entityId: string, n: number) => ({
  id: id(n + 2_000),
  createdAt: T0,
  updatedAt: T0,
  revision: { wallMs: n, counter: 0, deviceId: DEV },
  entityType,
  entityId,
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

test("R008: a lost acknowledgement is retried by the watchdog within the shared bound, then fails", async () => {
  let sends = 0;
  const timers: Array<() => void> = [];
  const transport = new SyncTransport({
    routeId: ROUTE,
    allowed: () => true,
    maxAttempts: 2,
    delay: noDelay,
    ackTimeoutMs: 1_000,
    watchdogDelay: () =>
      new Promise<void>((resolve) => {
        timers.push(resolve);
      }),
    send: async () => {
      sends += 1; // the acknowledgement NEVER arrives
    },
  });
  transport.enqueue(records(0, 1));
  await transport.sendPending();
  assert.equal(sends, 1);
  assert.equal(transport.status().pendingRecords, 1);
  assert.equal(timers.length, 1, "the unacked batch arms exactly one watchdog");
  timers.shift()!();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sends, 2, "within bounds the watchdog re-pumps the batch");
  assert.equal(transport.status().state, "retrying");
  assert.match(transport.status().note, /no acknowledgement/i);
  timers.shift()!();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sends, 2, "the bounded budget suspends instead of retrying forever");
  const status = transport.status();
  assert.equal(status.state, "failed");
  assert.match(status.note, /no acknowledgement/i);
  assert.equal(status.pendingRecords, 1, "the cursor is preserved for a later wake");
});

test("R008: a watchdog firing after its batch drained cannot disturb the newer window", async () => {
  const sent: { batchId: string; ids: string[] }[] = [];
  const timers: Array<() => void> = [];
  const transport = new SyncTransport({
    routeId: ROUTE,
    allowed: () => true,
    delay: noDelay,
    ackTimeoutMs: 1_000,
    watchdogDelay: () =>
      new Promise<void>((resolve) => {
        timers.push(resolve);
      }),
    send: async (payload) => {
      const ids = payload.records.map((r) => r.id);
      sent.push({ batchId: payload.batchId, ids });
      if (sent.length > 1)
        transport.handleAck({ tag: "sync-ack", batchId: payload.batchId, recordIds: ids });
      // batch 1's ack is held for the test to deliver by hand.
    },
  });
  transport.enqueue(records(0, 600));
  await transport.sendPending(); // batch 1 in flight, watchdog armed
  assert.equal(sent.length, 1);
  transport.handleAck({ tag: "sync-ack", batchId: sent[0]!.batchId, recordIds: sent[0]!.ids });
  await transport.sendPending(); // batch 2 goes out and self-acks
  assert.equal(sent.length, 2);
  assert.equal(transport.status().pendingRecords, 0);
  timers.shift()!(); // batch 1's stale watchdog fires now
  await new Promise((r) => setTimeout(r, 0));
  const status = transport.status();
  assert.equal(sent.length, 2, "the stale watchdog sent nothing");
  assert.equal(status.state, "idle");
  assert.equal(status.attempts, 0);
  assert.equal(status.pendingRecords, 0);
});

test("R008: concurrent sendPending invocations collapse into one active pump", async () => {
  let sends = 0;
  const transport = new SyncTransport({
    routeId: ROUTE,
    allowed: () => true,
    delay: noDelay,
    send: async () => {
      sends += 1; // never acked: the pump stops after the window-filling send
    },
  });
  transport.enqueue(records(0, 2));
  await Promise.all([transport.sendPending(), transport.sendPending(), transport.sendPending()]);
  assert.equal(sends, 1, "one active send pump, no double sends or overlapping loops");
});

test("R006: snapshot enqueue stamps chunk descriptors; plain stays bare; empty marker ships", async () => {
  const sent: { batchId: string; snapshot: unknown; count: number }[] = [];
  const transport = new SyncTransport({
    routeId: ROUTE,
    allowed: () => true,
    delay: noDelay,
    send: async (payload) => {
      EncryptedPayloadSchema.parse(payload);
      sent.push({ batchId: payload.batchId, snapshot: payload.snapshot, count: payload.records.length });
      transport.handleAck({
        tag: "sync-ack",
        batchId: payload.batchId,
        recordIds: payload.records.map((r) => r.id),
      });
    },
  });
  assert.equal(transport.enqueue(records(0, 2)), 2);
  await transport.sendPending();
  assert.equal(sent[0]!.snapshot, undefined, "plain batches stay snapshot-free");

  sent.length = 0;
  assert.equal(transport.enqueue(records(100, 600), { snapshotId: id(4_242) }), 600);
  await transport.sendPending();
  assert.equal(sent.length, 2, "500 + 100 chunk split");
  assert.deepEqual(sent[0]!.snapshot, { snapshotId: id(4_242), seq: 1, chunks: 2 });
  assert.deepEqual(sent[1]!.snapshot, { snapshotId: id(4_242), seq: 2, chunks: 2 });
  assert.notEqual(sent[0]!.batchId, sent[1]!.batchId, "each chunk keeps its own ack-able batch identity");

  sent.length = 0;
  assert.equal(transport.enqueue([], { snapshotId: id(4_243) }), 0, "an empty set carries no records");
  await transport.sendPending();
  assert.equal(sent.length, 1, "the empty marker chunk still ships so the copy can complete");
  assert.equal(sent[0]!.count, 0);
  assert.deepEqual(sent[0]!.snapshot, { snapshotId: id(4_243), seq: 1, chunks: 1 });
  assert.equal(transport.status().pendingRecords, 0, "the marker drains on its ack");
});
