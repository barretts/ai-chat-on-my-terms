import assert from "node:assert/strict";
import test from "node:test";
import {
  briefingKey,
  buildBriefingPrompt,
  createMemoryBriefingCache,
  runBriefing,
} from "../src/index.ts";

const WEATHER = {
  kind: "weather-reporter",
  location: "Seattle",
  time: "07:00",
} as const;
const NEWS = {
  kind: "morning-news-brief",
  topics: ["ai", "transit"],
  time: "06:30",
  voice: true,
  notify: true,
} as const;

test("weather fixture: offline says live data is missing (smoke)", async () => {
  const cache = createMemoryBriefingCache(3_600_000);
  let searches = 0;
  const res = await runBriefing(WEATHER, {
    modelClass: "q4-small",
    searchEnabled: false,
    search: {
      async search() {
        searches += 1;
        return [];
      },
    },
    cache,
    now: 1000,
    async generate(prompt) {
      assert.match(
        prompt,
        /short weather-style briefing for Seattle at 07:00/,
      );
      assert.match(prompt, /No live sources are available/);
      return { ok: true as const, text: "gray morning, check locally" };
    },
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.fromCache, false);
  assert.deepEqual(res.brief.sources, {
    available: false,
    notice: "search-not-enabled",
  });
  assert.equal(searches, 0);
  assert.equal(res.scheduled, false);
});

test("news fixture: topics/time/voice inputs and enabled search (smoke)", async () => {
  const cache = createMemoryBriefingCache(3_600_000);
  const queries: string[] = [];
  const scheduled: Array<[string, string]> = [];
  const res = await runBriefing(NEWS, {
    modelClass: "q4-small",
    searchEnabled: true,
    search: {
      async search(query) {
        queries.push(query);
        return ["Transit strike ends", "Local AI meetup"];
      },
    },
    cache,
    notifications: {
      async schedule(key, time) {
        scheduled.push([key, time]);
      },
    },
    now: 1000,
    async generate(prompt) {
      assert.match(prompt, /morning news brief at 06:30 covering: ai, transit/);
      assert.match(prompt, /- Transit strike ends/);
      return { ok: true as const, text: "two items" };
    },
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(queries, ["news about ai, transit"]);
  assert.equal(res.brief.voice, true);
  assert.deepEqual(res.brief.sources, {
    available: true,
    provider: true,
    items: ["Transit strike ends", "Local AI meetup"],
  });
  assert.deepEqual(scheduled, [[briefingKey(NEWS), "06:30"]]);
  assert.equal(res.scheduled, true);
});

test("cached brief serves fresh, regenerates when stale (step 3)", async () => {
  const cache = createMemoryBriefingCache(1000);
  let generations = 0;
  const gen = async () => {
    generations += 1;
    return { ok: true as const, text: `v${generations}` };
  };
  const first = await runBriefing(WEATHER, {
    modelClass: "q4-small",
    searchEnabled: false,
    cache,
    now: 0,
    generate: gen,
  });
  assert.equal(first.ok, true);
  const fresh = await runBriefing(WEATHER, {
    modelClass: "q4-small",
    searchEnabled: false,
    cache,
    now: 500,
    generate: gen,
  });
  assert.equal(fresh.ok, true);
  if (fresh.ok) {
    assert.equal(fresh.fromCache, true);
    assert.equal(fresh.brief.text, "v1");
  }
  assert.equal(generations, 1);
  const stale = await runBriefing(WEATHER, {
    modelClass: "q4-small",
    searchEnabled: false,
    cache,
    now: 1501,
    generate: gen,
  });
  assert.equal(stale.ok, true);
  if (stale.ok) {
    assert.equal(stale.fromCache, false);
    assert.equal(stale.brief.text, "v2");
  }
  assert.equal(generations, 2);
});

test("invalid configs never schedule, model loss caches nothing", async () => {
  const cache = createMemoryBriefingCache(1000);
  let scheduled = 0;
  const notifications = {
    async schedule() {
      scheduled += 1;
    },
  };
  for (const bad of [
    { kind: "weather-reporter", location: "S", time: "24:00" },
    { kind: "morning-news-brief", topics: [], time: "06:30" },
    { kind: "morning-news-brief", topics: ["a".repeat(41)], time: "06:30" },
    { kind: "weather-reporter", location: "S", time: "07:00", apiKey: "k" },
  ]) {
    const res = await runBriefing(bad, {
      modelClass: "q4-small",
      searchEnabled: false,
      cache,
      notifications,
      now: 0,
      async generate() {
        return { ok: true as const, text: "x" };
      },
    });
    assert.deepEqual(res, { ok: false, reason: "invalid-input" }, JSON.stringify(bad));
  }
  assert.equal(scheduled, 0);
  const missing = await runBriefing(WEATHER, {
    modelClass: "q9-gone",
    searchEnabled: false,
    cache,
    now: 0,
    async generate() {
      return { ok: false as const, reason: "model-unavailable" as const };
    },
  });
  assert.deepEqual(missing, { ok: false, reason: "model-unavailable" });
  assert.deepEqual(cache.read(briefingKey(WEATHER), 0), { state: "none" });
  assert.equal(
    buildBriefingPrompt(NEWS, []).includes("label anything without live data"),
    true,
  );
});
