/**
 * T098 gate: two in-memory devices (iPhone + Home Mac) wired by a fake
 * opened-channel converge across every initial choice, live edits,
 * deletes, disable/re-enable, offline edits with reconnect, offline
 * failure + retry, and the SY-03 exclusion wall.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncCompositionError, SyncEngine, type SyncSide } from "../src/index.js";
import { MergeStore, type MergeStateRow } from "@locallab/sync-merge";
import type { PairSyncPreference, SyncChoice, SyncPreferenceVault } from "@locallab/sync-preferences";
import { PERSONA_TIER_TYPES, personaTierGate } from "@locallab/sync-personas";

const ROUTE = "0198f2a3-0000-7000-8000-0000000000f0";
const T0_MS = Date.parse("2026-10-01T00:00:00.000Z");
const hex = (n: number) => n.toString(16).padStart(12, "0");
const id = (n: number) => `0198f2a3-0000-7000-8000-${hex(n)}`;

const DEV_P = id(700_001);
const DEV_M = id(700_002);

const rev = (n: number, deviceId: string) => ({ wallMs: n, counter: 0, deviceId });
const stamp = (n: number) => new Date(T0_MS + n * 1000).toISOString();

const base = (idValue: string, revision: ReturnType<typeof rev>) => ({
  id: idValue,
  createdAt: stamp(revision.wallMs),
  updatedAt: stamp(revision.wallMs),
  revision,
});

const convPayload = (convId: string, deviceId: string, title: string, n: number) => ({
  ...base(id(50_000 + parseInt(convId.slice(-2), 16)), rev(n, deviceId)),
  kind: "chat",
  title,
  folderId: null,
  bindingId: null,
  overrides: {},
});

const msgPayload = (msgEntity: string, convEntity: string, deviceId: string, text: string, n: number) => ({
  ...base(msgEntity, rev(n, deviceId)),
  conversationId: convEntity,
  role: "user",
  parts: [{ type: "text", text }],
  selectedVariantId: null,
  runStatus: "completed",
});

const rec = (
  entityType: string,
  entityId: string,
  payload: Record<string, unknown>,
  deviceId: string,
  n: number,
) => ({
  ...base(id(n + 1_000), rev(n, deviceId)),
  entityType,
  entityId,
  payload,
  acknowledgedAt: null,
});

const tomb = (entityType: string, entityId: string, deviceId: string, n: number) => ({
  ...base(id(n + 2_000), rev(n, deviceId)),
  entityType,
  entityId,
});

interface DeviceLink {
  up: boolean;
  frames: number;
  peer: { onFrame: (f: unknown) => Promise<void> } | null;
}

interface Device {
  engine: SyncEngine;
  store: MergeStore;
  link: DeviceLink;
  rows: () => PairSyncPreference[];
}

function makeDevice(
  side: SyncSide,
  deviceId: string,
  seed: readonly unknown[],
  clockFrom: number,
  persona?: { store: MergeStore; gate(entityType: string, entityId: string, payload?: unknown): boolean },
): Device {
  const store = persona?.store ?? new MergeStore();
  store.applyBatch(seed);
  let rows: PairSyncPreference[] = [];
  const vault: SyncPreferenceVault = {
    load: async () => rows,
    save: async (next) => {
      rows = [...next];
    },
  };
  const link: DeviceLink = { up: true, frames: 0, peer: null };
  let tick = clockFrom;
  const engine = new SyncEngine({
    routeId: ROUTE,
    deviceId,
    side,
    store,
    vault,
    now: () => stamp(tick++),
    delay: async () => {},
    sendBatch: async (payload) => {
      if (!link.up || link.peer === null) throw new Error("pair offline");
      link.frames += 1;
      await link.peer.onFrame(payload);
    },
    sendAck: async (ack) => {
      await link.peer?.onFrame(ack);
    },
    personaGate: persona?.gate,
  });
  return { engine, store, link, rows: () => rows };
}

function wire(a: Device, b: Device): void {
  a.link.peer = b.engine;
  b.link.peer = a.engine;
}

const liveRows = (store: MergeStore): MergeStateRow[] =>
  store.snapshot().filter((entry) => entry.row.payload !== null).map((entry) => entry.row);

async function optIn(dev: Device, choice: SyncChoice | null): Promise<void> {
  await dev.engine.enableSync();
  if (choice !== null) await dev.engine.chooseInitial(choice);
}

function phoneSeed() {
  return [
    rec("conversation", id(1), convPayload(id(1), DEV_P, "Groceries", 10), DEV_P, 10),
    rec("message", id(101), msgPayload(id(101), id(1), DEV_P, "Add oats", 20), DEV_P, 20),
  ];
}
function macSeed() {
  return [
    rec("conversation", id(2), convPayload(id(2), DEV_M, "Groceries", 15), DEV_M, 15),
    rec("message", id(102), msgPayload(id(102), id(2), DEV_M, "Also beans", 25), DEV_M, 25),
  ];
}

test("merge choice: both sets converge; identical titles stay separate; edits and deletes propagate", async () => {
  const phone = makeDevice("phone", DEV_P, phoneSeed(), 100);
  const mac = makeDevice("mac", DEV_M, macSeed(), 200);
  wire(phone, mac);
  await optIn(phone, "merge");
  await optIn(mac, "merge");
  await phone.engine.runInitialSync();
  await mac.engine.runInitialSync();

  assert.deepEqual(liveRows(phone.store), liveRows(mac.store));
  assert.equal(phone.store.liveCount(), 4, "identical-title conversations with different ids coexist");
  assert.deepEqual(phone.engine.conflicts(), []);

  // Live edit on the phone (SY-01/04).
  const edited = rec("conversation", id(1), convPayload(id(1), DEV_P, "Groceries & more", 300), DEV_P, 300);
  phone.store.apply(edited);
  assert.equal(phone.engine.noteLocalChange([edited]), 1);
  await phone.engine.flush();
  assert.deepEqual(liveRows(phone.store), liveRows(mac.store));
  const macRow = mac.store.rowFor("conversation", id(1))!;
  assert.equal((macRow.payload as { title: string }).title, "Groceries & more");

  // Delete on the phone propagates to the Mac (SY-06).
  const del = tomb("message", id(102), DEV_P, 400);
  phone.store.apply(del);
  assert.equal(phone.engine.noteLocalChange([del]), 1);
  await phone.engine.flush();
  assert.deepEqual(liveRows(phone.store), liveRows(mac.store));
  assert.equal(mac.store.liveCount(), 3);

  // Initial sync recorded complete on BOTH sides.
  for (const dev of [phone, mac]) {
    const pref = dev.rows().find((r) => r.routeId === ROUTE)!;
    assert.equal(pref.initialSyncDone, true);
    assert.equal(pref.choice, "merge");
  }
});

test("copy-phone: Mac's set is replaced, source untouched; delete still propagates", async () => {
  const phone = makeDevice("phone", DEV_P, phoneSeed(), 100);
  const mac = makeDevice("mac", DEV_M, macSeed(), 200);
  wire(phone, mac);
  await optIn(phone, "copy-phone");
  await optIn(mac, "copy-phone");
  await mac.engine.runInitialSync(); // target replaces local set
  assert.equal(mac.store.liveCount(), 0);
  await phone.engine.runInitialSync(); // source ships everything

  assert.deepEqual(liveRows(phone.store), liveRows(mac.store));
  assert.deepEqual(
    new Set(liveRows(mac.store).map((r) => r.entityId)),
    new Set([id(1), id(101)]),
  );

  const del = tomb("conversation", id(1), DEV_M, 500);
  mac.store.apply(del);
  mac.engine.noteLocalChange([del]);
  await mac.engine.flush();
  assert.deepEqual(liveRows(phone.store), liveRows(mac.store));
  assert.equal(phone.store.liveCount(), 1);
});

test("copy-mac mirrors: iPhone's set is replaced by the Mac set", async () => {
  const phone = makeDevice("phone", DEV_P, phoneSeed(), 100);
  const mac = makeDevice("mac", DEV_M, macSeed(), 200);
  wire(phone, mac);
  await optIn(phone, "copy-mac");
  await optIn(mac, "copy-mac");
  await phone.engine.runInitialSync(); // target
  await mac.engine.runInitialSync(); // source

  assert.deepEqual(liveRows(phone.store), liveRows(mac.store));
  assert.deepEqual(
    new Set(liveRows(phone.store).map((r) => r.entityId)),
    new Set([id(2), id(102)]),
  );
});

test("disable never moves data or deletes local copies; re-enable keeps the initial choice", async () => {
  const phone = makeDevice("phone", DEV_P, phoneSeed(), 100);
  const mac = makeDevice("mac", DEV_M, macSeed(), 200);
  wire(phone, mac);
  await optIn(phone, "merge");
  await optIn(mac, "merge");
  await phone.engine.runInitialSync();
  await mac.engine.runInitialSync();
  assert.equal(phone.store.liveCount(), 4);

  await phone.engine.disableSync();
  await mac.engine.disableSync();

  const framesBefore = phone.link.frames;
  const fresh = rec("conversation", id(3), convPayload(id(3), DEV_P, "Brand new chat", 600), DEV_P, 600);
  phone.store.apply(fresh);
  assert.equal(phone.engine.noteLocalChange([fresh]), 0, "disabled pair never queues");
  await phone.engine.flush();
  assert.equal(phone.link.frames, framesBefore, "no frames crossed while disabled");
  assert.equal(mac.store.rowFor("conversation", id(3)), null, "peer never saw it");

  // Local copies intact on both sides (SY-07).
  assert.equal(phone.store.liveCount(), 5);
  assert.equal(mac.store.liveCount(), 4);

  await phone.engine.enableSync();
  await mac.engine.enableSync();
  const pref = phone.rows().find((r) => r.routeId === ROUTE)!;
  assert.equal(pref.choice, "merge", "re-enable keeps choice + initialSyncDone (no re-prompt, no re-copy)");
  assert.equal(pref.initialSyncDone, true);
});

test("offline edits reconnect and converge; failure surfaces then retryAfterWake resumes", async () => {
  const phone = makeDevice("phone", DEV_P, phoneSeed(), 100);
  const mac = makeDevice("mac", DEV_M, macSeed(), 200);
  wire(phone, mac);
  await optIn(phone, "merge");
  await optIn(mac, "merge");
  await phone.engine.runInitialSync();
  await mac.engine.runInitialSync();

  // Offline: queue on BOTH sides without connectivity (SY-08).
  phone.link.up = false;
  mac.link.up = false;
  const pEdit = rec("conversation", id(1), convPayload(id(1), DEV_P, "Phone edit offline", 700), DEV_P, 700);
  phone.store.apply(pEdit);
  phone.engine.noteLocalChange([pEdit]);
  const mDel = tomb("message", id(102), DEV_M, 800);
  mac.store.apply(mDel);
  mac.engine.noteLocalChange([mDel]);
  await phone.engine.flush();
  assert.equal(phone.engine.status().state, "failed", "SY-08: failure surfaced with bounded retries");
  assert.ok(phone.engine.status().note.length > 0);
  assert.equal(phone.engine.status().pendingRecords, 1);

  // Reconnect + host-wake/toggle retry on both sides.
  phone.link.up = true;
  mac.link.up = true;
  await phone.engine.retryAfterWake();
  await mac.engine.retryAfterWake();
  assert.deepEqual(liveRows(phone.store), liveRows(mac.store));
  assert.notEqual(mac.store.rowFor("conversation", id(1))!.payload, null);
  assert.equal(phone.store.rowFor("message", id(102))!.payload, null, "tombstone retained");
});

test("excluded records throw fail-closed and never reach a queue or envelope", async () => {
  const phone = makeDevice("phone", DEV_P, phoneSeed(), 100);
  const mac = makeDevice("mac", DEV_M, macSeed(), 200);
  wire(phone, mac);
  await optIn(phone, "merge");
  await optIn(mac, "merge");
  await phone.engine.runInitialSync();
  await mac.engine.runInitialSync();
  const framesBefore = phone.link.frames + mac.link.frames;

  // Model record, preference, provider connection and persona tombstone — excluded (SY-03).
  assert.throws(
    () =>
      phone.engine.noteLocalChange([rec("model", id(9), { name: "llama", sizeBytes: 40_000_000_000 }, DEV_P, 900)]),
    (error: unknown) => (error as { kind?: string }).kind === "unsupported",
  );
  assert.throws(
    () => phone.engine.noteLocalChange([rec("preference", id(9), { key: "theme", value: "matrix" }, DEV_P, 901)]),
    (error: unknown) => (error as { kind?: string }).kind === "unsupported",
  );
  assert.throws(
    () => phone.engine.noteLocalChange([rec("provider-connection", id(9), { apiKey: "sk-secret-999" }, DEV_P, 902)]),
    (error: unknown) => (error as { kind?: string }).kind === "unsupported",
  );
  assert.throws(
    () => phone.engine.noteLocalChange([tomb("persona", id(9), DEV_P, 903)]),
    (error: unknown) => (error as { kind?: string }).kind === "unsupported",
  );
  // A secret-bearing key stuffed INSIDE an otherwise-valid conversation payload fails strict validation.
  assert.throws(
    () =>
      phone.engine.noteLocalChange([
        rec("conversation", id(4), { ...convPayload(id(4), DEV_P, "innocent", 910), apiKey: "sk-stolen" }, DEV_P, 910),
      ]),
    (error: unknown) => (error as { kind?: string }).kind === "malformed",
  );

  // And at the RECEIVE seam: a raw forged batch is refused without state change.
  const forged = { tag: "sync-batch", records: [rec("model", id(9), { name: "giant.gguf" }, DEV_P, 920)] };
  await assert.rejects(
    () => mac.engine.onFrame(forged),
    (error: unknown) => (error as { kind?: string }).kind === "unsupported",
  );
  assert.equal(mac.store.rowFor("model", id(9)), null);

  assert.equal(phone.engine.status().pendingRecords, 0, "nothing was queued");
  assert.equal(phone.link.frames + mac.link.frames, framesBefore, "no new frames");
});

test("choosing before opting in and running before choosing fail closed", async () => {
  const phone = makeDevice("phone", DEV_P, phoneSeed(), 100);
  await assert.rejects(
    () => phone.engine.chooseInitial("merge"),
    (error: unknown) => error instanceof SyncCompositionError || (error as { kind?: string }).kind === "state",
  );
  await optIn(phone, null);
  await assert.rejects(
    () => phone.engine.runInitialSync(),
    (error: unknown) => (error as { kind?: string }).kind === "state",
  );
});

// --- T099 persona tier (SY-10) ------------------------------------------------

const PERS = id(5001);
const OTHER = id(5002);
const PHOTO = id(5101);
const MEM_A = id(5201);
const MEM_B = id(5202);
const MEM_GLOBAL = id(5203);

interface PersonaView {
  photoAttachmentId: string | null;
}
interface MemoryView {
  scope: string;
  scopeId: string | null;
}

function gateOver(store: MergeStore) {
  return personaTierGate(
    { routeId: ROUTE, personaIds: [PERS], photos: true, memories: true, updatedAt: stamp(1) },
    {
      personaLive: (personaId: string) => {
        const row = store.rowFor("persona", personaId);
        if (row === null || row.payload === null) return null;
        return row.payload as PersonaView;
      },
      memoryLive: (memoryId: string) => {
        const row = store.rowFor("memory", memoryId);
        if (row === null || row.payload === null) return null;
        return row.payload as MemoryView;
      },
      attachmentOwner: (attachmentId: string) => {
        for (const entry of store.snapshot()) {
          const row = entry.row;
          if (row.entityType !== "persona" || row.payload === null) continue;
          const persona = row.payload as PersonaView;
          if (persona.photoAttachmentId === attachmentId) return row.entityId;
        }
        return null;
      },
      conversationSynced: (conversationId: string) => {
        const row = store.rowFor("conversation", conversationId);
        return row !== null && row.payload !== null;
      },
      localRowExists: (entityType: string, entityId: string) => store.rowFor(entityType, entityId) !== null,
    },
  );
}

const personaPayload = (n: number) => ({
  ...base(id(6_000 + n), rev(n, DEV_P)),
  name: "Ada",
  profile: { prompt: "ship fast" },
  photoAttachmentId: PHOTO,
  modelId: id(7_700),
  parameterPresetId: null,
});
const attachmentPayload = (n: number) => ({
  ...base(id(6_500 + n), rev(n, DEV_P)),
  mimeType: "image/jpeg",
  sha256: "ab".repeat(32),
  blobRef: id(8_800),
  extractedText: null,
  byteLength: 12_345,
});
const memoryPayload = (entity: string, scope: string, scopeId: string | null, n: number) => ({
  ...base(entity, rev(n, DEV_P)),
  content: "prefers dark roast",
  provenance: { sourceMessageId: null, method: "manual" },
  scope,
  scopeId,
});

test("persona tier crosses ONLY under selection; unselected private memory cannot", async () => {
  const pStore = new MergeStore(PERSONA_TIER_TYPES);
  const phone = makeDevice("phone", DEV_P, phoneSeed(), 100, { store: pStore, gate: gateOver(pStore) });
  const mStore = new MergeStore(PERSONA_TIER_TYPES);
  const mac = makeDevice("mac", DEV_M, macSeed(), 200, { store: mStore, gate: gateOver(mStore) });
  wire(phone, mac);
  await optIn(phone, "merge");
  await optIn(mac, "merge");
  await phone.engine.runInitialSync();
  await mac.engine.runInitialSync();

  // Selected character + its photo + its fact cross the pair.
  const personaRec = rec("persona", PERS, personaPayload(1_000), DEV_P, 1_000);
  const photoRec = rec("attachment", PHOTO, attachmentPayload(1_010), DEV_P, 1_010);
  const memRec = rec("memory", MEM_A, memoryPayload(MEM_A, "persona", PERS, 1_020), DEV_P, 1_020);
  pStore.applyBatch([personaRec, photoRec, memRec]);
  assert.equal(phone.engine.noteLocalChange([personaRec, photoRec, memRec]), 3);
  await phone.engine.flush();
  assert.notEqual(mStore.rowFor("persona", PERS), null, "selected persona synced");
  assert.notEqual(mStore.rowFor("attachment", PHOTO), null, "selected persona photo synced");
  assert.notEqual(mStore.rowFor("memory", MEM_A), null, "selected persona fact synced");

  // Unselected private memory and global memory NEVER cross (SY-10 wall).
  const memB = rec("memory", MEM_B, memoryPayload(MEM_B, "persona", OTHER, 1_030), DEV_P, 1_030);
  const memGlobal = rec("memory", MEM_GLOBAL, memoryPayload(MEM_GLOBAL, "global", null, 1_040), DEV_P, 1_040);
  pStore.applyBatch([memB, memGlobal]);
  assert.throws(
    () => phone.engine.noteLocalChange([memB]),
    (error: unknown) => (error as { kind?: string }).kind === "unsupported",
    "non-selected character's memory",
  );
  assert.throws(
    () => phone.engine.noteLocalChange([memGlobal]),
    (error: unknown) => (error as { kind?: string }).kind === "unsupported",
    "global private memory",
  );
  // A peer FORCING it in is refused fail-closed at the receive seam too.
  await assert.rejects(
    () => mac.engine.onFrame({ tag: "sync-batch", records: [memB] }),
    (error: unknown) => (error as { kind?: string }).kind === "unsupported",
  );
  assert.equal(mStore.rowFor("memory", MEM_B), null);
  assert.equal(mStore.rowFor("memory", MEM_GLOBAL), null);

  // Delete of the selected persona's fact propagates (tombstone keeps identity).
  const memDel = tomb("memory", MEM_A, DEV_P, 1_050);
  pStore.apply(memDel);
  phone.engine.noteLocalChange([memDel]);
  await phone.engine.flush();
  assert.equal(mStore.rowFor("memory", MEM_A)!.payload, null);
});
