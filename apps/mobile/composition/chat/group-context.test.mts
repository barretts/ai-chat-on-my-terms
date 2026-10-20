import assert from "node:assert/strict";
import { test } from "vitest";
import {
  applyDrunkWindow,
  DRUNK_TOKEN_WINDOW,
  estimateContextTokens,
  type GroupContextItem,
} from "./group-context";

const item = (
  id: string,
  kind: GroupContextItem["kind"],
  chars: number,
  compacted?: boolean,
): GroupContextItem => ({
  id,
  kind,
  text: "x".repeat(chars),
  ...(compacted === undefined ? {} : { compacted }),
});

test("drunk window keeps newest history and pins instructions plus current", () => {
  // 400 chars = 100 estimated tokens each; six rows overflow 512.
  const items: GroupContextItem[] = [
    item("persona", "persona", 80),
    item("room", "room", 40),
    item("h1", "history", 400),
    item("h2", "history", 400),
    item("h3", "history", 400),
    item("h4", "history", 400),
    item("h5", "history", 400),
    item("h6", "history", 400),
    item("now", "current", 20),
  ];
  const kept = applyDrunkWindow(items).map((value) => value.id);
  assert.deepEqual(kept, [
    "persona",
    "room",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "now",
  ]);
});

test("compacted history never survives the drunk window", () => {
  const items: GroupContextItem[] = [
    item("room", "room", 10),
    item("summary", "history", 40, true),
    item("h1", "history", 40),
    item("now", "current", 10),
  ];
  const kept = applyDrunkWindow(items).map((value) => value.id);
  assert.deepEqual(kept, ["room", "h1", "now"]);
});

test("a single newest row survives even past the window", () => {
  const huge = item("h1", "history", DRUNK_TOKEN_WINDOW * 4 + 100);
  const kept = applyDrunkWindow([huge]).map((value) => value.id);
  assert.deepEqual(kept, ["h1"]);
  assert.ok(estimateContextTokens(huge.text) > DRUNK_TOKEN_WINDOW);
});

test("history inside the budget is untouched and input is not mutated", () => {
  const items: GroupContextItem[] = [
    item("h1", "history", 40),
    item("h2", "history", 40),
  ];
  assert.deepEqual(applyDrunkWindow(items), items);
  assert.equal(items.length, 2);
});
