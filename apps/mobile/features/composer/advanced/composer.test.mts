import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPOSER_PREFERENCES,
  makeComposerPayload,
  mergeDictationText,
  resolveComposerPreferences,
  returnKeyAction,
  sendWasAccepted,
  SQLiteComposerPreferenceStore,
} from "./index.ts";

  it("appends finalized dictation with one space without disturbing the draft", () => {
    expect(mergeDictationText("", "hello there")).toBe("hello there");
    expect(mergeDictationText("keep this", " said out loud ")).toBe(
      "keep this said out loud",
    );
    expect(mergeDictationText("keep this", "   ")).toBe("keep this");
  });

describe("advanced composer contract", () => {
  it("restores saved mode and both preferences while defaulting invalid values", () => {
    expect(
      resolveComposerPreferences({ mode: "compact", returnSends: false }),
    ).toEqual({
      ...DEFAULT_COMPOSER_PREFERENCES,
      mode: "compact",
      returnSends: false,
    });
    expect(resolveComposerPreferences({ mode: "invalid" as never })).toEqual(
      DEFAULT_COMPOSER_PREFERENCES,
    );
  });

  it("uses a single send payload for starter text and reserves attachments until success", () => {
    const attachment = {
      id: "a1",
      name: "notes.txt",
      uri: "file:///notes.txt",
    };
    const starterPayload = makeComposerPayload(
      "  Explain this  ",
      [attachment],
      true,
      ["summarize"],
    );
    expect(starterPayload).toEqual({
      text: "Explain this",
      attachments: [attachment],
      searchEnabled: true,
      toolIds: ["summarize"],
    });
    expect(makeComposerPayload("  ", [], false, [])).toBeNull();
  });

  it("models Return sending versus newline insertion explicitly", () => {
    expect(returnKeyAction(true)).toEqual({ type: "send" });
    expect(returnKeyAction(false)).toEqual({ type: "insert-newline" });
  });

  it("releases reserved attachments only after an accepted send", () => {
    expect(sendWasAccepted(undefined)).toBe(true);
    expect(sendWasAccepted(false)).toBe(false);
  });

  it("persists the mode and both switches through the app SQLite port", async () => {
    let row: Record<string, unknown> | null = null;
    const db = {
      execAsync: async () => undefined,
      getFirstAsync: async () => row,
      runAsync: async (
        _sql: string,
        mode: string,
        starters: number,
        returnSends: number,
      ) => {
        row = {
          mode,
          starter_suggestions: starters,
          return_sends: returnSends,
        };
      },
    };
    const store = new SQLiteComposerPreferenceStore(db);
    await store.save({
      mode: "compact",
      starterSuggestions: false,
      returnSends: false,
    });
    expect(await store.load()).toEqual({
      mode: "compact",
      starterSuggestions: false,
      returnSends: false,
    });
  });
});
