/**
 * T098B smoke matrix: reordered/duplicated batches converge, equal-revision
 * tombstone precedence, order-independent conflict winner, content-addressed
 * covers, and the "deletes and covers do not resurrect after reconnect"
 * property. Stable IDs are checked verbatim.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CoverStager,
  MergeStore,
  SyncMergeError,
  contentDigest,
  isTombstone,
  mergeKey,
} from "../src/index.js";

const DEV_A = "0198f2a3-0000-7000-8000-0000000000aa";
const DEV_B = "0198f2a3-0000-7000-8000-0000000000bb";
const CONV_1 = "0198f2a3-0000-7000-8000-000000000101";
const CONV_2 = "0198f2a3-0000-7000-8000-000000000102";
const MSG_1 = "0198f2a3-0000-7000-8000-000000000201";
const MSG_2 = "0198f2a3-0000-7000-8000-000000000202";
const FOLDER_1 = "0198f2a3-0000-7000-8000-000000000301";
const T0 = "2026-10-01T00:00:00.000Z";

const rev = (wallMs: number, counter: number, deviceId: string) => ({
  wallMs,
  counter,
  deviceId,
});

type Rev = ReturnType<typeof rev>;

const base = (id: string, revision: Rev) => ({
  id,
  createdAt: T0,
  updatedAt: "2026-10-10T00:00:00.000Z",
  revision,
});

const convPayload = (id: string, title: string, revision: Rev) => ({
  ...base(id, revision),
  kind: "chat",
  title,
  folderId: null,
  bindingId: null,
  overrides: {},
});

const msgPayload = (id: string, text: string, revision: Rev) => ({
  ...base(id, revision),
  conversationId: CONV_1,
  role: "user",
  parts: [{ type: "text", text }],
  selectedVariantId: null,
  runStatus: "completed",
});

const folderPayload = (id: string, name: string, revision: Rev) => ({
  ...base(id, revision),
  name,
  parentId: null,
});

const rec = (entityType: string, entityId: string, payload: Record<string, unknown>, revision?: Rev) => ({
  ...base(entityId, revision ?? (payload.revision as Rev)),
  entityType,
  entityId,
  payload,
  acknowledgedAt: null,
});

const tomb = (entityType: string, entityId: string, revision: Rev) => ({
  ...base(entityId, revision),
  entityType,
  entityId,
});

test("reordered and duplicated batches converge to identical state", () => {
  const r1 = rec("conversation", CONV_1, convPayload(CONV_1, "Trip planning", rev(100, 0, DEV_A)));
  const r2 = rec("conversation", CONV_1, convPayload(CONV_1, "Trip planning!", rev(200, 1, DEV_A)));
  const m1 = rec("message", MSG_1, msgPayload(MSG_1, "Where do we go?", rev(100, 0, DEV_B)));
  const f1 = rec("folder", FOLDER_1, folderPayload(FOLDER_1, "Travel", rev(100, 0, DEV_A)));
  const del = tomb("message", MSG_2, rev(300, 0, DEV_B));

  const left = new MergeStore();
  left.applyBatch([r1, r2, m1, f1, del]);
  const right = new MergeStore();
  right.applyBatch([del, f1, m1, r2, r2, r1, del]);

  assert.deepEqual(left.snapshot(), right.snapshot());
  assert.equal(left.rowFor("conversation", CONV_1)?.payload, r2.payload);
  assert.equal(left.rowFor("message", MSG_1)?.payload, m1.payload);
  assert.equal(left.rowFor("message", MSG_2)?.payload, null);
  assert.equal(left.liveCount(), 3);
  // Stable IDs survive verbatim: the winning row carries the newer record's
  // own (never-rewritten) id.
  assert.equal(left.rowFor("conversation", CONV_1)?.recordId, CONV_1);
});

test("equal revision: tombstone beats update in either arrival order", () => {
  const r = rec("conversation", CONV_1, convPayload(CONV_1, "Edited anyway", rev(100, 1, DEV_A)));
  const t = tomb("conversation", CONV_1, rev(100, 1, DEV_A));

  const recordFirst = new MergeStore();
  recordFirst.applyBatch([r, t]);
  const tombFirst = new MergeStore();
  tombFirst.applyBatch([t, r]);

  assert.equal(recordFirst.rowFor("conversation", CONV_1)?.payload, null);
  assert.equal(tombFirst.rowFor("conversation", CONV_1)?.payload, null);
  assert.deepEqual(recordFirst.snapshot(), tombFirst.snapshot());
});

test("divergent payloads at one revision pick an order-independent winner", () => {
  const a = rec("message", MSG_1, msgPayload(MSG_1, "phone version", rev(150, 2, DEV_B)));
  const b = rec("message", MSG_1, {
    ...msgPayload("0198f2a3-0000-7000-8000-000000000203", "mac version", rev(150, 2, DEV_B)),
    id: MSG_1,
  });
  const firstWins = contentDigest(a.payload) < contentDigest(b.payload);

  const order1 = new MergeStore();
  order1.applyBatch([a, b]);
  const order2 = new MergeStore();
  order2.applyBatch([b, a]);

  assert.deepEqual(order1.snapshot(), order2.snapshot());
  const row = order1.rowFor("message", MSG_1)!;
  assert.deepEqual(row.payload, firstWins ? a.payload : b.payload);
  assert.equal(row.recordId, firstWins ? a.id : b.id, "winner keeps its stable record id");
  assert.equal(order1.conflicts().length, 1);
  assert.deepEqual(order1.conflicts(), order2.conflicts(), "same winner/loser pair in both orders");
  assert.deepEqual(order1.conflicts()[0]!.entityId, MSG_1);
});

test("covers are content-addressed, idempotent, and never resurrect deleted rows", () => {
  const stager = new CoverStager();
  const members = [
    rec("conversation", CONV_1, convPayload(CONV_1, "Copied chat", rev(100, 0, DEV_A))),
    rec("message", MSG_1, msgPayload(MSG_1, "copied text", rev(100, 0, DEV_A))),
    rec("folder", FOLDER_1, folderPayload(FOLDER_1, "Travel", rev(100, 0, DEV_A))),
  ];
  const digest = stager.stage(members);
  const reorderedDigest = stager.stage([members[2]!, members[0]!, members[1]!, members[0]!]);
  assert.equal(digest, reorderedDigest, "same content addresses the same digest");

  const store = new MergeStore();
  const localExtra = rec("conversation", CONV_2, convPayload(CONV_2, "Local-only chat", rev(50, 0, DEV_B)));
  store.apply(localExtra);
  const removed = store.snapshot().length;
  assert.equal(removed, 1);
  const coverRev = rev(10_000, 0, DEV_A);
  const stager2 = new CoverStager();
  const coverDigest2 = stager2.stage(members);
  const tombstoned = stager2.applyCover(store, coverDigest2, coverRev, "2026-10-12T00:00:00.000Z");
  assert.deepEqual(tombstoned, ["conversation/" + CONV_2]);
  assert.equal(store.liveCount(), 3);
  assert.equal(store.rowFor("conversation", CONV_2)?.payload, null, "replaced row stays tombstoned");

  // Reconnect replay: the pre-cover batch and an idempotent cover re-apply
  // must not bring CONV_2 back.
  store.applyBatch([localExtra, ...members]);
  assert.equal(store.rowFor("conversation", CONV_2)?.payload, null);
  stager2.applyCover(store, coverDigest2, coverRev, "2026-10-12T00:00:00.000Z");
  assert.equal(store.liveCount(), 3);
  assert.equal(store.rowFor("conversation", CONV_1)?.payload, members[0]!.payload);
});

test("excluded and malformed records are rejected fail-closed", () => {
  const store = new MergeStore();
  assert.throws(
    () => store.apply(rec("preference", CONV_1, { key: "theme", value: "dark" }, rev(1, 0, DEV_A))),
    (error: unknown) => error instanceof SyncMergeError && error.kind === "unsupported",
  );
  assert.throws(
    () => store.apply(rec("conversation", CONV_1, { kind: "chat" }, rev(1, 0, DEV_A))),
    (error: unknown) => error instanceof SyncMergeError && error.kind === "malformed",
  );
  assert.throws(
    () => store.apply({ nope: true }),
    (error: unknown) => error instanceof SyncMergeError && error.kind === "malformed",
  );
  const stager = new CoverStager();
  assert.throws(
    () => stager.stage([tomb("conversation", CONV_1, rev(1, 0, DEV_A))]),
    (error: unknown) => error instanceof SyncMergeError && error.kind === "malformed",
  );
  assert.throws(
    () => stager.stage([]),
    (error: unknown) => error instanceof SyncMergeError && error.kind === "malformed",
  );
  assert.equal(store.liveCount(), 0);
});

test("digest and helpers behave canonically", () => {
  assert.equal(contentDigest({ b: 1, a: 2 }), contentDigest({ a: 2, b: 1 }));
  assert.equal(contentDigest([1, { x: [true, null] }]).length, 16);
  assert.ok(isTombstone(tomb("folder", FOLDER_1, rev(1, 0, DEV_A))));
  assert.ok(!isTombstone(rec("folder", FOLDER_1, folderPayload(FOLDER_1, "n", rev(1, 0, DEV_A)))));
  assert.equal(mergeKey({ entityType: "message", entityId: MSG_1 }), `message/${MSG_1}`);
});
