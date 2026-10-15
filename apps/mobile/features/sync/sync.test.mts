import { describe, expect, it } from "vitest";
import {
  completeInitialSync,
  initialSyncPromptVisible,
  needsInitialSyncChoice,
  optInPairSync,
  optOutPairSync,
  parseSyncPreferenceRecords,
  setInitialSyncChoice,
  syncChoiceLabel,
  syncChoicePreviews,
  syncDataAllowed,
  syncFailureNote,
  syncPreferenceViews,
  syncToggleNote,
  type PairSyncPreference,
} from ".";

const ROUTE = "0198f2a3-0000-7000-8000-0000000000a1";
const NOW = "2026-10-14T12:00:00.000Z";

describe("sync opt-in flow (pairing prompt → choice → gate)", () => {
  it("keeps the gate closed until opt-in AND a choice are recorded", () => {
    let records = optInPairSync([], ROUTE, NOW);
    expect(syncDataAllowed(records, ROUTE)).toBe(false);
    expect(needsInitialSyncChoice(records, ROUTE)).toBe(true);
    records = setInitialSyncChoice(records, ROUTE, "copy-phone", NOW);
    expect(syncDataAllowed(records, ROUTE)).toBe(true);
  });

  it("prompts only opted-in pairs without a choice", () => {
    let records = optInPairSync([], ROUTE, NOW);
    const [promptRow] = syncPreferenceViews(records, [{ routeId: ROUTE, label: "Home Mac" }]);
    expect(initialSyncPromptVisible(promptRow!)).toBe(true);

    records = setInitialSyncChoice(records, ROUTE, "merge", NOW);
    records = completeInitialSync(records, ROUTE, NOW);
    const [readyRow] = syncPreferenceViews(records, [{ routeId: ROUTE, label: "Home Mac" }]);
    expect(initialSyncPromptVisible(readyRow!)).toBe(false);
    expect(readyRow!.choiceLabel).toBe("Both chat sets merged");
  });

  it("records survive a simulated restart through the vault rows", () => {
    let records = optInPairSync([], ROUTE, NOW);
    records = setInitialSyncChoice(records, ROUTE, "copy-mac", NOW);
    records = completeInitialSync(records, ROUTE, NOW);
    const revived = parseSyncPreferenceRecords(JSON.parse(JSON.stringify(records)));
    expect(syncDataAllowed(revived, ROUTE)).toBe(true);
    expect(needsInitialSyncChoice(revived, ROUTE)).toBe(false);
  });

  it("disabling sync keeps both local copies and the choice history", () => {
    let records = optInPairSync([], ROUTE, NOW);
    records = setInitialSyncChoice(records, ROUTE, "merge", NOW);
    records = completeInitialSync(records, ROUTE, NOW);
    const disabled = optOutPairSync(records, ROUTE, NOW);
    expect(syncDataAllowed(disabled, ROUTE)).toBe(false);
    expect(findChoice(disabled)).toBe("merge");
    expect(syncToggleNote(false)).toContain("never");
    expect(syncToggleNote(false)).toContain("both local copies");
  });
});

describe("sync copy strings", () => {
  it("offers the three source-guide choices with previews", () => {
    const previews = syncChoicePreviews();
    expect(previews.map((option) => option.choice)).toEqual([
      "copy-phone",
      "copy-mac",
      "merge",
    ]);
    for (const option of previews) {
      expect(option.preview.length).toBeGreaterThan(20);
    }
    expect(syncChoiceLabel(null)).toBe("No initial choice yet");
  });

  it("SY-08 failures name the toggle retry", () => {
    expect(syncFailureNote("Sync failed: relay offline.")).toContain(
      "Toggle Sync chats off and on to retry.",
    );
  });
});

function findChoice(records: readonly PairSyncPreference[]): string | null {
  const row = records.find((record) => record.routeId === ROUTE);
  return row?.choice ?? null;
}
