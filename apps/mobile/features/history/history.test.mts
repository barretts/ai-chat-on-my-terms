import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  deleteConfirmationText,
  DraftShelf,
  formatHistoryDate,
  historyRowLabel,
  historyRowReducer,
  IDLE_ROW,
  planNewChat,
  type HistoryConversation,
} from "./index";

// Local-time constructors keep these assertions timezone independent.
const now = new Date(2026, 8, 28, 15, 30);
const iso = (...parts: [number, number, number, number?, number?]) =>
  new Date(
    parts[0],
    parts[1],
    parts[2],
    parts[3] ?? 12,
    parts[4] ?? 0,
  ).toISOString();

const conversation = (
  over: Partial<HistoryConversation> = {},
): HistoryConversation => ({
  id: "c1",
  title: "Owl survey",
  folderId: null,
  modelId: null,
  lastUsedAt: iso(2026, 8, 28, 9, 5),
  archivedAt: null,
  createdAt: iso(2026, 8, 1),
  updatedAt: iso(2026, 8, 1),
  kind: "solo",
  avatarAttachmentId: null,
  personaPhotoAttachmentId: null,
  preview: "Who cooks for you",
  ...over,
});

describe("history dates", () => {
  it("uses the shortest unambiguous form", () => {
    assert.equal(formatHistoryDate(iso(2026, 8, 28, 9, 5), now), "9:05 AM");
    assert.equal(formatHistoryDate(iso(2026, 8, 28, 0, 0), now), "12:00 AM");
    assert.equal(formatHistoryDate(iso(2026, 8, 28, 13, 40), now), "1:40 PM");
    assert.equal(formatHistoryDate(iso(2026, 8, 27, 23, 59), now), "Yesterday");
    assert.equal(formatHistoryDate(iso(2026, 8, 22), now), "Tue");
    assert.equal(formatHistoryDate(iso(2026, 8, 21), now), "Sep 21");
    assert.equal(formatHistoryDate(iso(2025, 11, 31), now), "Dec 31, 2025");
    assert.equal(formatHistoryDate("not a date", now), "");
    assert.equal(formatHistoryDate(null, now), "");
  });
});

describe("history rows", () => {
  it("reads title, state, date and preview in one sentence", () => {
    assert.equal(
      historyRowLabel(conversation(), { current: true, now }),
      "Owl survey, open now, 9:05 AM, Who cooks for you",
    );
    assert.equal(
      historyRowLabel(
        conversation({ title: "  ", preview: null, lastUsedAt: null }),
        { current: false, now },
      ),
      "New chat, Sep 1, no messages yet",
    );
  });

  it("says group chat in the row sentence for room conversations", () => {
    assert.equal(
      historyRowLabel(
        conversation({ kind: "group", title: "Fog Horns", lastUsedAt: null }),
        { current: false, now },
      ),
      "Fog Horns, group chat, Sep 1, Who cooks for you",
    );
  });

  it("opens actions for one row at a time and confirms before delete", () => {
    let state = historyRowReducer(IDLE_ROW, {
      type: "toggle-actions",
      id: "a",
    });
    assert.deepEqual(state, { kind: "actions", id: "a" });
    state = historyRowReducer(state, { type: "toggle-actions", id: "b" });
    assert.deepEqual(state, { kind: "actions", id: "b" });
    state = historyRowReducer(state, { type: "request-delete", id: "b" });
    assert.deepEqual(state, { kind: "confirm-delete", id: "b" });
    // Tapping More again on the same row backs out of the confirmation.
    assert.deepEqual(
      historyRowReducer(state, { type: "toggle-actions", id: "b" }),
      IDLE_ROW,
    );
    assert.deepEqual(historyRowReducer(state, { type: "dismiss" }), IDLE_ROW);
  });

  it("explains exactly what delete removes and what happens next", () => {
    assert.equal(
      deleteConfirmationText({
        title: "Owl survey",
        current: false,
        working: false,
      }),
      'Delete "Owl survey" for good? Its messages and attachments will be removed from this phone. Saved memories stay in Memory.',
    );
    assert.match(
      deleteConfirmationText({ title: "x", current: true, working: true }),
      /reply being written will stop, and a new empty chat will take its place\.$/,
    );
    assert.match(
      deleteConfirmationText({ title: "x", current: true, working: false }),
      /Memory\. A new empty chat will take its place\.$/,
    );
  });
});

describe("new chat", () => {
  it("asks before interrupting a reply and does not stack empty chats", () => {
    assert.equal(
      planNewChat({ working: true, messageCount: 0 }),
      "confirm-stop",
    );
    assert.equal(
      planNewChat({ working: true, messageCount: 4 }),
      "confirm-stop",
    );
    assert.equal(
      planNewChat({ working: false, messageCount: 0 }),
      "already-new",
    );
    assert.equal(planNewChat({ working: false, messageCount: 2 }), "create");
  });

  it("keeps unsent drafts per conversation", () => {
    const shelf = new DraftShelf();
    shelf.put("a", "half a thought");
    shelf.put("b", "   ");
    assert.equal(shelf.get("a"), "half a thought");
    assert.equal(shelf.has("b"), false);
    shelf.put("a", "");
    assert.equal(shelf.has("a"), false);
    shelf.put("a", "again");
    shelf.forget("a");
    assert.equal(shelf.get("a"), "");
  });
});
