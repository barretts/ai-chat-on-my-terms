import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { memoryMetricsStore, registerMetricsRoutes } from "./index.js";

function build() {
  const app = Fastify();
  const store = memoryMetricsStore();
  registerMetricsRoutes(app, { store });
  return { app, store };
}

test("events round-trip into the dashboard aggregates", async () => {
  const { app } = build();
  const res = await app.inject({
    method: "POST",
    url: "/metrics/events",
    payload: {
      batch: [
        {
          event: "worker-status",
          at: "2026-05-01T00:01:00.000Z",
          props: { workerKind: "media-queue", queueDepth: 3 },
        },
        {
          event: "worker-status",
          at: "2026-05-01T00:02:00.000Z",
          props: { workerKind: "media-queue", queueDepth: 9 },
        },
        {
          event: "error-occurred",
          at: "2026-05-01T00:03:00.000Z",
          props: { code: "model-load-failed" },
        },
      ],
    },
  });
  assert.deepEqual(res.json(), { accepted: 3 });
  const dash = await app.inject({ method: "GET", url: "/metrics/dashboard" });
  const agg = dash.json();
  assert.equal(agg.workerMaxQueueDepth["media-queue"], 9);
  assert.equal(agg.errorCodeCounts["model-load-failed"], 1);
  assert.equal(agg.lastSeenAt, "2026-05-01T00:03:00.000Z");
});

test("empty store gives an empty dashboard, not fixtures", async () => {
  const { app } = build();
  const dash = await app.inject({ method: "GET", url: "/metrics/dashboard" });
  assert.deepEqual(dash.json(), {
    eventCounts: {},
    workerMaxQueueDepth: {},
    errorCodeCounts: {},
    lastSeenAt: null,
  });
});

test("events carrying prompt/chat fields are rejected and not stored", async () => {
  const { app, store } = build();
  const res = await app.inject({
    method: "POST",
    url: "/metrics/events",
    payload: {
      batch: [
        {
          event: "error-occurred",
          at: "2026-05-01T00:01:00.000Z",
          props: {
            code: "failed",
            lastMessage: "secret conversation content",
          },
        },
      ],
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "invalid-event");
  assert.equal((await store.allEvents()).length, 0);
});

test("oversized and malformed batches are refused", async () => {
  const { app } = build();
  const notArray = await app.inject({
    method: "POST",
    url: "/metrics/events",
    payload: { batch: { event: "app-launch" } },
  });
  assert.equal(notArray.statusCode, 400);
  const huge = await app.inject({
    method: "POST",
    url: "/metrics/events",
    payload: {
      batch: Array.from({ length: 201 }, () => ({
        event: "session-length",
        at: "2026-05-01T00:00:00.000Z",
        props: { minutes: 1 },
      })),
    },
  });
  assert.equal(huge.statusCode, 400);
});
