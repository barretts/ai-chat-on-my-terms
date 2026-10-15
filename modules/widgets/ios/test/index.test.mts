import assert from "node:assert/strict";
import test from "node:test";
import {
  ActivityStateSchema,
  WidgetSnapshotSchema,
  parseWidgetRouteUrl,
  reconcileActivities,
  widgetRouteUrl,
} from "../src/index.ts";

const t0 = "2026-05-01T00:00:00.000Z";

test("widget quick-entry routes round-trip on the locallab scheme", () => {
  assert.equal(widgetRouteUrl("new-chat"), "locallab://widget/new-chat");
  assert.deepEqual(parseWidgetRouteUrl("locallab://widget/camera"), {
    kind: "camera",
  });
  assert.deepEqual(parseWidgetRouteUrl("locallab://widget/news"), {
    kind: "news",
  });
  assert.equal(parseWidgetRouteUrl("locallab://chat/abc"), null);
  assert.equal(parseWidgetRouteUrl("otherapp://widget/new-chat"), null);
  assert.equal(parseWidgetRouteUrl("locallab://widget/anything"), null);
});

test("app-group snapshot schema refuses chat text and secrets", () => {
  const good = {
    generatedAt: t0,
    pinnedModelClasses: ["q4-small", "minilm-l6"],
    download: {
      kind: "download",
      activityId: "dl-1",
      startedAt: t0,
      modelClass: "q4-small",
      percent: 42,
      finished: false,
    },
    generation: null,
    updateAvailable: true,
  };
  assert.equal(WidgetSnapshotSchema.safeParse(good).success, true);

  for (const smuggled of [
    { chatText: "the private conversation" },
    { prompt: "the user prompt" },
    { apiKey: "sk-live-secret" },
  ]) {
    const bad = { ...good, ...smuggled };
    const res = WidgetSnapshotSchema.safeParse(bad);
    assert.equal(res.success, false, `expected refusal: ${Object.keys(smuggled)}`);
  }

  // free text cannot hide inside allowed slots either
  assert.equal(
    WidgetSnapshotSchema.safeParse({
      ...good,
      pinnedModelClasses: ["my private chat text"],
    }).success,
    false,
  );
  assert.equal(
    WidgetSnapshotSchema.safeParse({
      ...good,
      download: { ...good.download, percent: 101 },
    }).success,
    false,
  );
});

test("generation activities carry no preview text", () => {
  const state = {
    kind: "generation",
    activityId: "gen-1",
    startedAt: t0,
    modelClass: "q4-small",
    finished: false,
  };
  assert.equal(ActivityStateSchema.safeParse(state).success, true);
  assert.equal(
    ActivityStateSchema.safeParse({ ...state, preview: "the answer" })
      .success,
    false,
  );
  assert.equal(
    ActivityStateSchema.safeParse({
      ...state,
      modelClass: "assistant said hello",
    }).success,
    false,
  );
});

test("activities reconcile after foreground/relaunch", () => {
  const now = new Date("2026-05-01T01:00:00.000Z");
  const result = reconcileActivities(
    [
      {
        kind: "download",
        activityId: "dl-done",
        startedAt: "2026-05-01T00:55:00.000Z",
        modelClass: "q4-small",
        percent: 100,
        finished: true,
      },
      {
        kind: "download",
        activityId: "dl-running",
        startedAt: "2026-05-01T00:58:00.000Z",
        modelClass: "q4-small",
        percent: 60,
        finished: false,
      },
      {
        kind: "generation",
        activityId: "gen-dead",
        startedAt: "2026-04-30T20:00:00.000Z",
        modelClass: "q4-small",
        finished: false,
      },
    ],
    { now, maxAgeMs: 2 * 60 * 60 * 1000 },
  );
  assert.deepEqual(result.end.sort(), ["dl-done", "gen-dead"]);
  assert.deepEqual(
    result.keep.map((s) => s.activityId),
    ["dl-running"],
  );
});
