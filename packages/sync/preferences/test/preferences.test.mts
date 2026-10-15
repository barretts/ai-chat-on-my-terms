/**
 * T098A smoke matrix: opt-in + initial choice persistence across restarts,
 * disable/re-enable retention, and the hard gate that no sync data is
 * allowed before opt-in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SyncPreferenceError,
  completeInitialSync,
  findPairSyncPreference,
  needsInitialSyncChoice,
  optInPairSync,
  optOutPairSync,
  parseSyncPreferenceRecords,
  setInitialSyncChoice,
  syncDataAllowed,
  syncPreferenceViews,
  type PairSyncPreference,
} from "../src/index.js";

const ROUTE = "0198f2a3-0000-7000-8000-0000000000a1";
const NOW = "2026-10-14T12:00:00.000Z";

test("opt-in and initial choice survive a simulated restart", async () => {
  const store = new Map<string, string>();
  const vault = {
    async load() {
      return store.has("prefs") ? parseSyncPreferenceRecords(JSON.parse(store.get("prefs")!)) : [];
    },
    async save(records: readonly PairSyncPreference[]) {
      store.set("prefs", JSON.stringify(records));
    },
  };

  let records = await vault.load();
  assert.equal(records.length, 0);
  records = optInPairSync(records, ROUTE, NOW);
  await vault.save(records);

  // The pairing-time prompt asks for the initial choice.
  assert.ok(needsInitialSyncChoice(records, ROUTE));
  assert.equal(syncDataAllowed(records, ROUTE), false, "no data before the choice");
  records = setInitialSyncChoice(records, ROUTE, "merge", NOW);
  records = completeInitialSync(records, ROUTE, NOW);
  await vault.save(records);

  const reloaded = await vault.load();
  assert.equal(syncDataAllowed(reloaded, ROUTE), true);
  assert.equal(findPairSyncPreference(reloaded, ROUTE)?.choice, "merge");
  assert.equal(findPairSyncPreference(reloaded, ROUTE)?.initialSyncDone, true);
});

test("disable and re-enable keep the pair, choice and history intact", () => {
  let records = optInPairSync([], ROUTE, NOW);
  records = setInitialSyncChoice(records, ROUTE, "copy-mac", NOW);
  records = completeInitialSync(records, ROUTE, "2026-10-14T12:01:00.000Z");

  const disabled = optOutPairSync(records, ROUTE, "2026-10-14T13:00:00.000Z");
  assert.equal(syncDataAllowed(disabled, ROUTE), false, "SY-07 gate closed while disabled");
  const off = findPairSyncPreference(disabled, ROUTE)!;
  assert.equal(off.enabled, false);
  assert.equal(off.choice, "copy-mac", "choice retained for re-enable");
  assert.equal(off.initialSyncDone, true, "initial copy not repeated later");

  const again = optInPairSync(disabled, ROUTE, "2026-10-14T14:00:00.000Z");
  assert.equal(syncDataAllowed(again, ROUTE), true);
  assert.equal(needsInitialSyncChoice(again, ROUTE), false);
});

test("nothing is allowed before opt-in, and stray operations fail closed", () => {
  assert.equal(syncDataAllowed([], ROUTE), false);
  assert.throws(() => optOutPairSync([], ROUTE, NOW), SyncPreferenceError);
  assert.throws(() => setInitialSyncChoice([], ROUTE, "merge", NOW), SyncPreferenceError);
  assert.throws(() => completeInitialSync([], ROUTE, NOW), SyncPreferenceError);

  let records = optInPairSync([], ROUTE, NOW);
  records = setInitialSyncChoice(records, ROUTE, "copy-phone", NOW);
  records = completeInitialSync(records, ROUTE, NOW);
  assert.throws(
    () => setInitialSyncChoice(records, ROUTE, "merge", NOW),
    (error: unknown) => error instanceof SyncPreferenceError && /already recorded/.test((error as Error).message),
  );
});

test("corrupt stored rows are rejected instead of trusted", () => {
  assert.throws(
    () => parseSyncPreferenceRecords([{ routeId: "not-a-uuid", enabled: true }]),
    (error: unknown) => error instanceof SyncPreferenceError && error.kind === "malformed",
  );
  assert.throws(
    () => parseSyncPreferenceRecords("nope"),
    (error: unknown) => error instanceof SyncPreferenceError && error.kind === "malformed",
  );
  assert.deepEqual(parseSyncPreferenceRecords([]), []);
});

test("panel rows show switch state, choice and pending prompts per pairing", () => {
  let records = optInPairSync([], ROUTE, NOW);
  records = setInitialSyncChoice(records, ROUTE, "merge", NOW);
  const rows = syncPreferenceViews(records, [
    { routeId: ROUTE, label: "Home Mac" },
    { routeId: "0198f2a3-0000-7000-8000-0000000000a2", label: "Office Mac" },
  ]);
  assert.deepEqual(rows[0], {
    routeId: ROUTE,
    label: "Home Mac",
    enabled: true,
    choiceLabel: "Both chat sets merged",
    initialSyncDone: false,
    needsChoice: false,
  });
  assert.equal(rows[1]!.enabled, false);
  assert.equal(rows[1]!.needsChoice, false, "never-enabled pairs need no prompt");
});
