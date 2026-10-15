import { describe, expect, it, vi } from "vitest";
import {
  createAnalyticsClient,
  createAnalyticsCoordinator,
} from "./analytics.ts";

const at = "2026-05-01T00:00:00.000Z";

function clientDouble() {
  const client = {
    sent: [] as unknown[][],
    dashboardCalls: 0,
    async sendEvents(batch: unknown[]) {
      client.sent.push(batch);
    },
    async dashboard() {
      client.dashboardCalls += 1;
      return {
        eventCounts: {},
        workerMaxQueueDepth: {},
        errorCodeCounts: {},
        lastSeenAt: null,
      };
    },
  };
  return client;
}

describe("analytics consent gate", () => {
  it("drops everything and touches the network zero times with consent off", async () => {
    const client = clientDouble();
    const coordinator = createAnalyticsCoordinator({ client });
    const res = coordinator.recordEvent({
      event: "app-launch",
      at,
      props: { appVersion: "1.3.0", platform: "ios" },
    });
    expect(res).toEqual({ stored: false, reason: "consent-off" });
    coordinator.recordTrace({
      entries: [
        {
          time: at,
          operation: "generate",
          phase: "failed",
          detail: { code: "model-load-failed" },
        },
      ],
    });
    expect(await coordinator.flushAnalytics()).toBe(0);
    expect(client.sent).toHaveLength(0);
    expect(client.dashboardCalls).toBe(0);
  });

  it("counts real trace failures even without consent", () => {
    const coordinator = createAnalyticsCoordinator({});
    const failures = coordinator.recordTrace({
      entries: [
        {
          time: at,
          operation: "generate",
          phase: "failed",
          detail: { code: "model-load-failed" },
        },
        {
          time: at,
          operation: "generate",
          phase: "failed",
          detail: { code: "model-load-failed" },
        },
        { time: at, operation: "generate", phase: "info", detail: {} },
      ],
    });
    expect(failures).toBe(2);
    const snap = coordinator.localSnapshot();
    expect(snap.counters["trace.failed.model-load-failed"]).toBe(2);
    expect(snap.counters["trace.info"]).toBe(1);
  });

  it("sends allowlisted events once product consent is on", async () => {
    const client = clientDouble();
    const coordinator = createAnalyticsCoordinator({ client });
    coordinator.recordTrace({
      entries: [
        {
          time: at,
          operation: "generate",
          phase: "failed",
          detail: { code: "model-load-failed" },
        },
      ],
    });
    await coordinator.setConsent("product", true);
    // events recorded before consent were dropped; record one now
    coordinator.recordEvent({
      event: "error-occurred",
      at,
      props: { code: "model-load-failed" },
    });
    expect(await coordinator.flushAnalytics()).toBe(1);
    expect(client.sent).toHaveLength(1);
    const batch = client.sent[0] as { props: Record<string, unknown> }[];
    expect(batch[0]?.props).toEqual({ code: "model-load-failed" });
  });

  it("benchmark sharing is gated separately from product analytics", async () => {
    const client = clientDouble();
    const coordinator = createAnalyticsCoordinator({ client });
    await coordinator.setConsent("product", true);
    const bench = coordinator.recordEvent({
      event: "benchmark-result",
      at,
      props: { modelClass: "q4-small", tokensPerSecond: 31, latencyMs: 900 },
    });
    expect(bench).toEqual({ stored: false, reason: "consent-off" });
    expect(await coordinator.flushAnalytics()).toBe(0);
    await coordinator.setConsent("benchmark", true);
    coordinator.recordEvent({
      event: "benchmark-result",
      at,
      props: { modelClass: "q4-small", tokensPerSecond: 31, latencyMs: 900 },
    });
    expect(await coordinator.flushAnalytics()).toBe(1);
    expect(client.sent).toHaveLength(1);
  });

  it("revoking consent drops queued events", async () => {
    const client = clientDouble();
    const coordinator = createAnalyticsCoordinator({ client });
    await coordinator.setConsent("product", true);
    coordinator.recordEvent({
      event: "session-length",
      at,
      props: { minutes: 10 },
    });
    await coordinator.setConsent("product", false);
    expect(await coordinator.flushAnalytics()).toBe(0);
    expect(client.sent).toHaveLength(0);
  });
});

describe("analytics client", () => {
  it("posts batches to /metrics/events and reads /metrics/dashboard", async () => {
    const calls: { path: string; method: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      calls.push({
        path: parsed.pathname,
        method: init?.method ?? "GET",
      });
      return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
    }) as typeof fetch;
    const client = createAnalyticsClient({
      baseUrl: "http://srv.test",
      fetchImpl,
    });
    await client.sendEvents([
      { event: "session-length", at, props: { minutes: 4 } },
    ]);
    await client.dashboard();
    expect(calls).toEqual([
      { path: "/metrics/events", method: "POST" },
      { path: "/metrics/dashboard", method: "GET" },
    ]);
  });
});
