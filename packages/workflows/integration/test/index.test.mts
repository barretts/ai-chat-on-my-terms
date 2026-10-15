import assert from "node:assert/strict";
import test from "node:test";
import { SHORTCUT_ACTIONS } from "@locallab/automation";
import {
  RECIPE_LEDGER,
  SOURCE_CATALOG_RECIPES,
  diffLedgerAgainstCatalog,
  recipeById,
  workflowDevRoute,
} from "../src/index.ts";

test("ledger matches the 22-item source catalog exactly (step 3)", () => {
  assert.equal(RECIPE_LEDGER.length, 22);
  assert.deepEqual(
    RECIPE_LEDGER.map((entry) => entry.catalogName),
    [...SOURCE_CATALOG_RECIPES],
  );
  assert.deepEqual(diffLedgerAgainstCatalog(SOURCE_CATALOG_RECIPES), {
    missing: [],
    extra: [],
  });
  // All 22 catalog recipes are packaged workflows (actions), not
  // bare menu items — and the ledger records the distinction.
  for (const entry of RECIPE_LEDGER)
    assert.equal(entry.kind, "action", entry.catalogName);
});

test("every recipe registers one typed automation intent, prompt editable (step 1)", () => {
  for (const entry of RECIPE_LEDGER) {
    assert.equal(
      (SHORTCUT_ACTIONS as readonly string[]).includes(entry.action),
      true,
      entry.catalogName,
    );
    assert.equal(entry.intent.action, entry.action, entry.catalogName);
    assert.equal(entry.promptEditable, true, entry.catalogName);
    assert.match(entry.devRoute, /^\/workflows\/[a-z0-9-]+$/);
  }
  assert.equal(new Set(RECIPE_LEDGER.map((e) => e.devRoute)).size, 22);
  assert.equal(new Set(RECIPE_LEDGER.map((e) => e.id)).size, 22);
});

test("every recipe has a golden request that its real schema accepts", () => {
  for (const entry of RECIPE_LEDGER) {
    assert.equal(
      entry.validate(entry.fixture.request),
      entry.fixture.expect === "ok",
      `fixture ${entry.catalogName}`,
    );
    // Hostile requests never validate.
    for (const hostile of [{}, null])
      assert.equal(
        entry.validate(hostile),
        false,
        `hostile ${JSON.stringify(hostile)} ${entry.catalogName}`,
      );
  }
});

test("dev entry routes resolve by recipe id", () => {
  assert.equal(workflowDevRoute("morning-news"), "/workflows/morning-news");
  assert.equal(workflowDevRoute("nope"), undefined);
  assert.equal(recipeById("callkit-call")?.pkg, "@locallab/workflows-voice-actions");
});
