import { describe, expect, it } from "vitest";
import { createWidgetSnapshotPublisher } from "./snapshot-publisher";

const t0 = "2026-05-01T00:00:00.000Z";

function bridgeDouble() {
  const bridge = {
    snapshots: [] as unknown[],
    started: [] as unknown[],
    ended: [] as string[],
    activities: [] as { id: string; state: unknown }[],
    async writeSnapshot(snapshot: unknown) {
      bridge.snapshots.push(snapshot);
    },
    async startActivity(state: unknown) {
      bridge.started.push(state);
      return (state as { activityId: string }).activityId;
    },
    async updateActivity() {
      /* not exercised by the publisher */
    },
    async endActivity(id: string) {
      bridge.ended.push(id);
    },
    async listActivities() {
      return bridge.activities;
    },
  };
  return bridge;
}

describe("widget snapshot publisher", () => {
  it("is a no-op on builds without the native bridge", async () => {
    const publisher = createWidgetSnapshotPublisher({});
    expect(
      await publisher.publishSnapshot({
        generatedAt: t0,
        pinnedModelClasses: [],
        download: null,
        generation: null,
        updateAvailable: false,
      }),
    ).toBe(false);
    expect(
      await publisher.startActivity({
        kind: "download",
        activityId: "dl-1",
        startedAt: t0,
        modelClass: "q4-small",
        percent: 10,
        finished: false,
      }),
    ).toBe(null);
    expect(await publisher.reconcile()).toBe(0);
  });

  it("writes only contract-valid snapshots to the app group", async () => {
    const bridge = bridgeDouble();
    const publisher = createWidgetSnapshotPublisher({ bridge });
    const ok = await publisher.publishSnapshot({
      generatedAt: t0,
      pinnedModelClasses: ["q4-small"],
      download: null,
      generation: null,
      updateAvailable: false,
    });
    expect(ok).toBe(true);
    const chat = await publisher.publishSnapshot({
      generatedAt: t0,
      pinnedModelClasses: [],
      download: null,
      generation: null,
      updateAvailable: false,
      chatText: "private conversation",
    });
    expect(chat).toBe(false);
    expect(bridge.snapshots).toHaveLength(1);
  });

  it("starts and ends live activities for downloads and generations", async () => {
    const bridge = bridgeDouble();
    const publisher = createWidgetSnapshotPublisher({ bridge });
    const id = await publisher.startActivity({
      kind: "download",
      activityId: "dl-1",
      startedAt: t0,
      modelClass: "q4-small",
      percent: 25,
      finished: false,
    });
    expect(id).toBe("dl-1");
    const smuggled = await publisher.startActivity({
      kind: "generation",
      activityId: "gen-1",
      startedAt: t0,
      modelClass: "q4-small",
      finished: false,
      preview: "the model answer text",
    });
    expect(smuggled).toBe(null);
    await publisher.finishActivity({
      kind: "download",
      activityId: "dl-1",
      startedAt: t0,
      modelClass: "q4-small",
      percent: 100,
      finished: true,
    });
    expect(bridge.ended).toEqual(["dl-1"]);
  });

  it("reconciles finished, stale and unreadable activities on relaunch", async () => {
    const now = new Date("2026-05-01T02:00:00.000Z");
    const bridge = bridgeDouble();
    bridge.activities = [
      {
        id: "dl-done",
        state: {
          kind: "download",
          activityId: "dl-done",
          startedAt: "2026-05-01T01:55:00.000Z",
          modelClass: "q4-small",
          percent: 100,
          finished: true,
        },
      },
      {
        id: "gen-dead",
        state: {
          kind: "generation",
          activityId: "gen-dead",
          startedAt: "2026-05-01T00:00:00.000Z",
          modelClass: "q4-small",
          finished: false,
        },
      },
      { id: "legacy", state: { weird: "pre-contract row" } },
      {
        id: "gen-live",
        state: {
          kind: "generation",
          activityId: "gen-live",
          startedAt: "2026-05-01T01:59:00.000Z",
          modelClass: "q4-small",
          finished: false,
        },
      },
    ];
    const publisher = createWidgetSnapshotPublisher({
      bridge,
      now: () => now,
    });
    const ended = await publisher.reconcile({ maxAgeMs: 60 * 60 * 1000 });
    expect(ended).toBe(3);
    expect(bridge.ended.sort()).toEqual(["dl-done", "gen-dead", "legacy"]);
  });
});
