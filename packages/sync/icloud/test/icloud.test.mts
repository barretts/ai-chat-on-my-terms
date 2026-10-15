/**
 * T100 (SY-09) smoke: two simulated Apple devices converge through a
 * simulated CloudKit private container — offline edits/deletes resolve
 * like the relay, the transports never echo, and photo assets ride as
 * sha256-addressed blobs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AttachmentSchema } from "@locallab/contracts/entities";
import { compareRevision } from "@locallab/contracts/identity";
import { MergeStore } from "@locallab/sync-merge";
import { ICloudError } from "@locallab/icloud";
import type { ICloudAccountStatus, ICloudBridge, ICloudRecord } from "@locallab/icloud";
import { IcloudSyncAdapter } from "../src/index.js";

const T0_MS = Date.parse("2026-10-01T00:00:00.000Z");
const hex = (n: number) => n.toString(16).padStart(12, "0");
const id = (n: number) => `0198f2a3-0000-7000-8000-${hex(n)}`;
const stamp = (ms: number) => new Date(T0_MS + ms).toISOString();

const DEV_A = id(900_001);
const DEV_B = id(900_002);
const CONV = id(9_100);
const MSG_1 = id(9_101);
const MSG_2 = id(9_102);
const MSG_3 = id(9_103);

class FakeCloud implements ICloudBridge {
  account: ICloudAccountStatus = "available";
  readonly assets = new Map<string, Uint8Array>();
  saves = 0;
  readonly savedRecordNames: string[] = [];
  private readonly rows = new Map<string, ICloudRecord>();
  private readonly log: ICloudRecord[] = [];

  async accountStatus(): Promise<ICloudAccountStatus> {
    return this.account;
  }

  async fetchChanges(cursor: string, limit: number): Promise<{ records: ICloudRecord[]; cursor: string; more: boolean }> {
    const from = cursor === "" ? 0 : Number.parseInt(cursor, 10);
    const page = this.log.slice(from, from + limit).map((entry) => structuredClone(entry));
    const next = from + page.length;
    return { records: page, cursor: String(next), more: next < this.log.length };
  }

  async saveRecords(records: readonly ICloudRecord[]): Promise<void> {
    this.saves += 1;
    for (const record of records) {
      const current = this.rows.get(record.recordName);
      if (current !== undefined && compareRevision(current.revision, record.revision) >= 0) continue;
      this.rows.set(record.recordName, structuredClone(record));
      this.log.push(structuredClone(record));
      this.savedRecordNames.push(record.recordName);
    }
  }

  async saveAsset(sha256: string, bytes: Uint8Array): Promise<void> {
    this.assets.set(sha256, bytes);
  }

  async fetchAsset(sha256: string): Promise<Uint8Array | null> {
    return this.assets.get(sha256) ?? null;
  }
}

function rec(entityType: string, entityId: string, payload: unknown, dev: string, wallMs: number) {
  return {
    entityType,
    entityId,
    id: entityId,
    createdAt: stamp(wallMs),
    updatedAt: stamp(wallMs),
    revision: { wallMs, counter: 0, deviceId: dev },
    payload,
    acknowledgedAt: null,
  };
}
function tomb(entityType: string, entityId: string, dev: string, wallMs: number) {
  return {
    entityType,
    entityId,
    id: entityId,
    createdAt: stamp(wallMs),
    updatedAt: stamp(wallMs),
    revision: { wallMs, counter: 0, deviceId: dev },
  };
}

const convPayload = (title: string, dev: string, wallMs: number) => ({
  id: id(9_500),
  createdAt: stamp(wallMs),
  updatedAt: stamp(wallMs),
  revision: { wallMs, counter: 0, deviceId: dev },
  kind: "chat",
  title,
  folderId: null,
  bindingId: null,
  overrides: {},
});
const msgPayload = (entityId: string, body: string, dev: string, wallMs: number) => ({
  id: entityId,
  conversationId: CONV,
  createdAt: stamp(wallMs),
  updatedAt: stamp(wallMs),
  revision: { wallMs, counter: 0, deviceId: dev },
  role: "user",
  parts: [{ type: "text", text: body }],
  selectedVariantId: null,
  runStatus: "completed",
});

function makeSim(cloud: FakeCloud, deviceId: string, extraTypes?: Record<string, typeof AttachmentSchema>) {
  const store = extraTypes === undefined ? new MergeStore() : new MergeStore(extraTypes);
  const adapter = new IcloudSyncAdapter({
    selfDeviceId: deviceId,
    store,
    bridge: cloud,
    now: () => stamp(5_000_000),
  });
  adapter.setEnabled(true);
  return { store, adapter };
}

const liveRows = (store: MergeStore) =>
  store
    .snapshot()
    .filter((entry) => entry.row.payload !== null)
    .map((entry) => `${entry.row.entityType}/${entry.row.entityId}:${JSON.stringify(entry.row.payload)}`)
    .sort();

test("two simulated Apple devices converge offline edits and deletes (SY-09/SY-06)", async () => {
  const cloud = new FakeCloud();
  const seed = [
    rec("conversation", CONV, convPayload("Trip", DEV_A, 100), DEV_A, 100),
    rec("message", MSG_1, msgPayload(MSG_1, "packing list", DEV_A, 200), DEV_A, 200),
    rec("message", MSG_2, msgPayload(MSG_2, "old draft", DEV_A, 300), DEV_A, 300),
  ];
  const a = makeSim(cloud, DEV_A);
  const b = makeSim(cloud, DEV_B);
  for (const sim of [a, b]) {
    sim.store.applyBatch(seed);
    sim.adapter.stageAllLocalRows();
    await sim.adapter.syncOnce();
  }

  // Offline edits on BOTH phones.
  const editM1 = rec("message", MSG_1, msgPayload(MSG_1, "packing list v2", DEV_A, 500), DEV_A, 500);
  const newM3 = rec("message", MSG_3, msgPayload(MSG_3, "tickets printed", DEV_A, 600), DEV_A, 600);
  a.store.applyBatch([editM1, newM3]);
  a.adapter.noteLocalChange([editM1, newM3]);

  const rename = rec("conversation", CONV, convPayload("Road trip", DEV_B, 700), DEV_B, 700);
  const delM2 = tomb("message", MSG_2, DEV_B, 800);
  b.store.applyBatch([rename, delM2]);
  b.adapter.noteLocalChange([rename, delM2]);

  await a.adapter.syncOnce();
  await b.adapter.syncOnce();
  await a.adapter.syncOnce();

  assert.deepEqual(liveRows(a.store), liveRows(b.store), "live rows identical after sync");
  assert.equal(a.store.rowFor("message", MSG_2)!.payload, null, "delete stayed a delete");
  assert.equal(b.store.rowFor("message", MSG_2)!.payload, null);
  assert.notEqual(a.store.rowFor("message", MSG_3), null, "offline create arrived");
  assert.notEqual(b.store.rowFor("message", MSG_3), null);
});

test("simultaneous transports NEVER echo a saved revision back up (SY-09)", async () => {
  const cloud = new FakeCloud();
  const seed = [
    rec("conversation", CONV, convPayload("Trip", DEV_A, 100), DEV_A, 100),
    rec("message", MSG_1, msgPayload(MSG_1, "packing list", DEV_A, 200), DEV_A, 200),
  ];
  const a = makeSim(cloud, DEV_A);
  const b = makeSim(cloud, DEV_B);
  for (const sim of [a, b]) {
    sim.store.applyBatch(seed);
    sim.adapter.stageAllLocalRows();
    await sim.adapter.syncOnce();
  }

  // A relay-delivered row on B (transport #1 running at the same time):
  // B's host reports it, so iCloud picks it up once — and only once.
  const relayRow = rec("message", MSG_3, msgPayload(MSG_3, "via relay", DEV_A, 900), DEV_A, 900);
  b.store.apply(relayRow);
  b.adapter.noteLocalChange([relayRow]);
  await b.adapter.syncOnce();

  // B now fetches its OWN upload back (cursor advanced past it): duplicate
  // effects, zero new uploads, no duplicate saves.
  const savesBefore = cloud.saves;
  const pulledBack = await b.adapter.fetch();
  assert.equal(pulledBack, 0, "own upload comes back as no-op");
  await b.adapter.publish();
  assert.equal(cloud.saves, savesBefore, "no echo upload");

  // The same row delivered again (relay replay): store no-op, cloud once.
  b.store.apply(relayRow);
  assert.equal(cloud.savedRecordNames.filter((name) => name.includes(MSG_3)).length, 1, "saved exactly once");

  // A converges through iCloud.
  await a.adapter.fetch();
  assert.deepEqual(liveRows(a.store), liveRows(b.store));
});

test("sync is fail-closed until the account is available and opt-in happened", async () => {
  const cloud = new FakeCloud();
  const a = makeSim(cloud, DEV_A);
  assert.equal(a.adapter.isEnabled(), true);

  cloud.account = "noAccount";
  const off = await a.adapter.status();
  assert.deepEqual(off, { state: "unavailable", account: "noAccount" });
  await assert.rejects(
    () => a.adapter.syncOnce(),
    (error: unknown) => error instanceof ICloudError && error.kind === "account",
  );

  const edit = rec("message", MSG_1, msgPayload(MSG_1, "queued offline", DEV_A, 400), DEV_A, 400);
  a.store.apply(edit);
  a.adapter.noteLocalChange([edit]); // queueing without an account is safe
  assert.equal(a.adapter.failureNote(), "iCloud account status: noAccount");

  cloud.account = "available";
  const ready = await a.adapter.status();
  assert.equal(ready.state, "ready");
  const pushed = (await a.adapter.syncOnce()).pushed;
  assert.equal(pushed, 1);
  assert.equal(a.adapter.failureNote(), null);

  const b = makeSim(cloud, DEV_B);
  await b.adapter.fetch();
  const got = b.store.rowFor("message", MSG_1)!.payload;
  assert.deepEqual(got, (edit as { payload: unknown }).payload);

  // Opt-out stops everything: no fetch, no publish.
  b.adapter.setEnabled(false);
  assert.deepEqual(await b.adapter.status(), { state: "off" });
  assert.equal(await b.adapter.fetch(), 0);
});

test("photo rows ride iCloud as sha256-addressed assets, bytes included", async () => {
  const cloud = new FakeCloud();
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const photoId = id(9_200);
  const sha = "ab".repeat(32);
  const storeA = new MergeStore({ attachment: AttachmentSchema });
  const storeB = new MergeStore({ attachment: AttachmentSchema });
  const a = new IcloudSyncAdapter({
    selfDeviceId: DEV_A,
    store: storeA,
    bridge: cloud,
    now: () => stamp(5_500_000),
    assetSource: async (want) => (want === sha ? bytes : null),
  });
  a.setEnabled(true);
  const sinkSeen: Array<{ entityId: string; sha256: string; size: number }> = [];
  const b = new IcloudSyncAdapter({
    selfDeviceId: DEV_B,
    store: storeB,
    bridge: cloud,
    now: () => stamp(6_000_000),
    assetSink: async (entityId, sha256, got) => {
      sinkSeen.push({ entityId, sha256, size: got.length });
    },
  });
  b.setEnabled(true);

  const photo = rec(
    "attachment",
    photoId,
    {
      id: photoId,
      createdAt: stamp(500),
      updatedAt: stamp(500),
      revision: { wallMs: 500, counter: 0, deviceId: DEV_A },
      mimeType: "image/jpeg",
      sha256: sha,
      blobRef: id(9_300),
      extractedText: null,
      byteLength: bytes.length,
    },
    DEV_A,
    500,
  );
  storeA.apply(photo);
  a.noteLocalChange([photo]);
  await a.publish();

  await b.fetch();
  assert.notEqual(storeB.rowFor("attachment", photoId), null, "photo row crossed iCloud");
  assert.deepEqual(sinkSeen, [{ entityId: photoId, sha256: sha, size: 5 }], "asset bytes drained");
});

// R022 — upload completion must not discard a newer pending edit.

class GateCloud extends FakeCloud {
  private gateOpen = false;
  private releaseFn: () => void = () => {};

  override async saveRecords(records: readonly ICloudRecord[]): Promise<void> {
    if (!this.gateOpen) {
      await new Promise<void>((resolve) => {
        this.releaseFn = resolve;
      });
    }
    await super.saveRecords(records);
  }

  open(): void {
    this.gateOpen = true;
    this.releaseFn();
  }
}

test("R022: an edit arriving while upload A is in flight survives A's completion", async () => {
  const cloud = new GateCloud();
  const { adapter } = makeSim(cloud, DEV_A);
  adapter.noteLocalChange([rec("conversation", CONV, convPayload("A", DEV_A, 10), DEV_A, 10)]);
  const publishing = adapter.publish();
  await new Promise((resolve) => setTimeout(resolve, 0)); // publish sits in saveRecords
  const newer = rec("conversation", CONV, convPayload("B NEWER", DEV_A, 20), DEV_A, 20);
  adapter.noteLocalChange([newer]); // user edits WHILE A uploads
  cloud.open();
  assert.equal(await publishing, 1, "A counted");
  const status = await adapter.status();
  assert.ok(status.state === "ready" && status.pendingUploads === 1, "B stays queued — A settled only A");

  assert.equal(await adapter.publish(), 1, "B uploads on the next pass");
  const watcher = makeSim(cloud, DEV_B);
  await watcher.adapter.fetch();
  assert.equal(
    (watcher.store.rowFor("conversation", CONV)!.payload as { title: string }).title,
    "B NEWER",
    "the newest edit actually reached the cloud",
  );
});

test("R022: fetching stale cloud A keeps newer pending B; a subsumed pending settles", async () => {
  const cloud = new FakeCloud();
  const stale = rec("conversation", CONV, convPayload("cloud A", DEV_B, 10), DEV_B, 10);
  await cloud.saveRecords([
    {
      recordName: `conversation:${CONV}`,
      entityType: "conversation",
      entityId: CONV,
      revision: { wallMs: 10, counter: 0, deviceId: DEV_B },
      payload: stale.payload,
      assetSha256: null,
      updatedAt: stamp(10),
    },
  ]);

  const { adapter } = makeSim(cloud, DEV_A);
  adapter.noteLocalChange([rec("conversation", CONV, convPayload("local B NEWER", DEV_A, 20), DEV_A, 20)]);
  await adapter.fetch(); // stale A crosses (superseded): pending B must SURVIVE
  const status = await adapter.status();
  assert.ok(status.state === "ready" && status.pendingUploads === 1, "newer local edit not discarded");
  await adapter.publish();

  // Same entity, pending NOT newer than cloud (wallMs 5 < A@10): after fetch
  // the pending entry must settle (old behavior preserved), so no endless
  // re-upload of a subsumed row.
  const { adapter: sim2 } = makeSim(cloud, id(900_003));
  sim2.noteLocalChange([rec("conversation", CONV, convPayload("ancient", DEV_A, 5), DEV_A, 5)]);
  await sim2.fetch();
  const settled = await sim2.status();
  assert.ok(settled.state === "ready" && settled.pendingUploads === 0, "subsumed pending settles");

  // And the newer B is now on the cloud for the other device:
  const watcher = makeSim(cloud, DEV_B);
  await watcher.adapter.fetch();
  assert.equal(
    (watcher.store.rowFor("conversation", CONV)!.payload as { title: string }).title,
    "local B NEWER",
  );
});
