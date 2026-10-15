import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateEvents,
  buildSupportBundle,
  createAnalyticsBuffer,
  createMetricsCollector,
  validateEvent,
} from "../src/index.ts";

const at = "2026-05-01T00:00:00.000Z";

test("events are allowlist validated; prompts cannot be represented", () => {
  const good = validateEvent({
    event: "worker-status",
    at,
    props: { workerKind: "media-queue", queueDepth: 7 },
  });
  assert.equal(good.ok, true);

  const prompt = validateEvent({
    event: "error-occurred",
    at,
    props: {
      code: "generation-failed",
      prompt: "the user asked about their doctor visit",
    },
  });
  assert.equal(prompt.ok, false);
  assert.match((prompt as { reason: string }).reason, /not allowlisted/);

  const chatAsValue = validateEvent({
    event: "error-occurred",
    at,
    props: { code: "my chat text: I love you" },
  });
  assert.equal(chatAsValue.ok, false);

  const secretish = validateEvent({
    event: "provider-status",
    at,
    props: { providerKind: "openai sk-abcdef123456", ok: true },
  });
  assert.equal(secretish.ok, false);

  const unknown = validateEvent({
    event: "keystrokes",
    at,
    props: {},
  });
  assert.equal(unknown.ok, false);
});

test("consent off drops events before buffering — nothing to send", async () => {
  const sent: unknown[][] = [];
  const buffer = createAnalyticsBuffer({
    isConsented: () => false,
    transport: {
      async send(batch) {
        sent.push(batch);
      },
    },
  });
  const res = buffer.record({
    event: "app-launch",
    at,
    props: { appVersion: "1.3.0", platform: "ios" },
  });
  assert.deepEqual(res, { stored: false, reason: "consent-off" });
  assert.equal(buffer.pending(), 0);
  assert.equal(await buffer.flush(), 0);
  assert.equal(sent.length, 0);
});

test("consent on records allowlisted events and flushes in one batch", async () => {
  const sent: unknown[][] = [];
  let consent = false;
  const buffer = createAnalyticsBuffer({
    isConsented: (kind) => (kind === "benchmark" ? false : consent),
    transport: {
      async send(batch) {
        sent.push(batch);
      },
    },
  });
  buffer.record({ event: "session-length", at, props: { minutes: 12 } });
  assert.equal(buffer.pending(), 0);
  consent = true;
  buffer.record({ event: "session-length", at, props: { minutes: 3 } });
  // benchmark sharing is separately opt-in (AR-09) and still off:
  const bench = buffer.record({
    event: "benchmark-result",
    at,
    props: { modelClass: "q4-small", tokensPerSecond: 31, latencyMs: 900 },
  });
  assert.deepEqual(bench, { stored: false, reason: "consent-off" });
  assert.equal(await buffer.flush(), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.length, 1);
});

test("local counters aggregate real bumps", () => {
  let ms = 0;
  const collector = createMetricsCollector(() => new Date(ms));
  collector.bump("workers.active");
  collector.bump("workers.active", 2);
  collector.bump("errors.generation-failed", 3);
  collector.bump("workers.active", -1);
  const snap = collector.snapshot();
  assert.equal(snap.counters["workers.active"], 2);
  assert.equal(snap.counters["errors.generation-failed"], 3);
});

test("dashboard aggregates reflect the events given", () => {
  const empty = aggregateEvents([]);
  assert.deepEqual(empty.eventCounts, {});
  assert.equal(empty.lastSeenAt, null);

  const agg = aggregateEvents([
    {
      event: "worker-status",
      at,
      props: { workerKind: "media-queue", queueDepth: 3 },
    },
    {
      event: "worker-status",
      at: "2026-05-01T00:05:00.000Z",
      props: { workerKind: "media-queue", queueDepth: 7 },
    },
    {
      event: "error-occurred",
      at: "2026-05-01T00:04:00.000Z",
      props: { code: "model-load-failed" },
    },
    {
      event: "error-occurred",
      at: "2026-05-01T00:06:00.000Z",
      props: { code: "model-load-failed" },
    },
  ]);
  assert.equal(agg.eventCounts["worker-status"], 2);
  assert.equal(agg.workerMaxQueueDepth["media-queue"], 7);
  assert.equal(agg.errorCodeCounts["model-load-failed"], 2);
  assert.equal(agg.lastSeenAt, "2026-05-01T00:06:00.000Z");
});

test("support bundle keeps summaries but drops secrets", () => {
  const collector = createMetricsCollector();
  collector.bump("errors.total", 4);
  const line = `generate failed: model load error key=sk-abcdef1234567890abc id=${"0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"}`;
  const bundle = JSON.parse(
    buildSupportBundle({
      snapshot: collector.snapshot(),
      errors: [line, "a".repeat(300)],
    }),
  ) as {
    format: string;
    counters: Record<string, number>;
    errorSummaries: string[];
  };
  assert.equal(bundle.format, "LocalLab support bundle v1");
  assert.equal(bundle.counters["errors.total"], 4);
  assert.ok(!JSON.stringify(bundle).includes("sk-abcdef"));
  assert.ok(!JSON.stringify(bundle).includes("0f1e2d3c"));
  assert.ok(bundle.errorSummaries[1]!.length <= 121);
  assert.ok(bundle.errorSummaries.length === 2);
});
