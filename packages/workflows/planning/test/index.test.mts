import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPrompt,
  planFields,
  requestPlaceRecommendations,
  runPlanningWorkflow,
  type PlanningInput,
} from "../src/index.ts";

test("recipe fixture: servings reviewable, prompt names them twice (golden)", () => {
  const input: PlanningInput = {
    workflow: "recipe-maker",
    ingredients: ["eggs", "flour", "cheese"],
    diet: "vegetarian",
    servings: 3,
  };
  const prompt = buildPrompt(input);
  assert.equal(
    prompt,
    [
      "Diet: vegetarian.",
      "Plan 3 servings using mainly these ingredients (extras must be pantry staples).",
      "Give: recipe name, ingredient list with quantities for 3 servings, short steps.",
      "",
      "Ingredients:",
      "- eggs",
      "- flour",
      "- cheese",
    ].join("\n"),
  );
  assert.deepEqual(planFields(input), { servings: 3 });
});

test("grocery fixture: budget and meals stay reviewable (golden)", () => {
  const input: PlanningInput = {
    workflow: "grocery-genius",
    pantry: ["rice", "beans"],
    budgetUsd: 25,
    meals: 5,
  };
  const prompt = buildPrompt(input);
  assert.match(prompt, /plan 5 simple meals/);
  assert.match(prompt, /under \$25/);
  assert.deepEqual(planFields(input), { budgetUsd: 25, meals: 5 });
});

test("tourist fixture: offline discloses absent live results (smoke)", async () => {
  let searches = 0;
  const res = await runPlanningWorkflow(
    {
      workflow: "tourist-guide",
      location: { label: "Kyoto", latitude: 35.0, longitude: 135.7 },
      days: 2,
      interests: ["temples"],
    },
    {
      modelClass: "q4-small",
      searchEnabled: false,
      async generate() {
        return { ok: true as const, text: "day one: temples" };
      },
    },
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.places, {
    available: false,
    notice: "search-not-enabled",
  });
  assert.match(
    buildPrompt({
      workflow: "tourist-guide",
      location: { label: "Kyoto" },
      days: 2,
      interests: ["temples"],
    }),
    /Interests: temples\./,
  );
  assert.deepEqual(
    planFields({
      workflow: "tourist-guide",
      location: { label: "Kyoto" },
      days: 2,
    }),
    { location: { label: "Kyoto" }, days: 2 },
  );

  const on = await requestPlaceRecommendations("Kyoto", {
    searchEnabled: true,
    search: {
      async search(query) {
        searches += 1;
        assert.equal(query, "places to visit in Kyoto");
        return ["Fushimi Inari"];
      },
    },
  });
  assert.equal(searches, 1);
  assert.deepEqual(on, { available: true, places: ["Fushimi Inari"] });

  const off = await requestPlaceRecommendations("Kyoto", {
    searchEnabled: false,
    search: {
      async search() {
        searches += 1;
        return [];
      },
    },
  });
  assert.deepEqual(off, { available: false, notice: "search-not-enabled" });
  assert.equal(searches, 1);
});

test("inputs are bounded and strict; model loss surfaces", async () => {
  const options = {
    modelClass: "q4-small",
    searchEnabled: false,
    async generate() {
      return { ok: true as const, text: "x" };
    },
  };
  for (const bad of [
    { workflow: "recipe-maker", ingredients: [], servings: 3 },
    { workflow: "recipe-maker", ingredients: ["eggs"], servings: 13 },
    { workflow: "grocery-genius", pantry: ["a"], budgetUsd: 1001, meals: 5 },
    {
      workflow: "tourist-guide",
      location: { label: "x", latitude: 91 },
      days: 1,
    },
    { workflow: "recipe-maker", ingredients: ["eggs"], servings: 2, apiKey: "k" },
  ]) {
    const res = await runPlanningWorkflow(bad, options);
    assert.deepEqual(
      res,
      { ok: false, reason: "invalid-input" },
      JSON.stringify(bad),
    );
  }
  const missing = await runPlanningWorkflow(
    { workflow: "recipe-maker", ingredients: ["eggs"], servings: 2 },
    {
      modelClass: "q9-gone",
      searchEnabled: false,
      async generate() {
        return { ok: false as const, reason: "model-unavailable" as const };
      },
    },
  );
  assert.deepEqual(missing, { ok: false, reason: "model-unavailable" });
});
