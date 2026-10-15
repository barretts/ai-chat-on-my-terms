/** Device analytics glue (DA-04/AR-09/UI-19). Consent is off by
 * default: with consent off, events are dropped before buffering, so a
 * network audit shows zero analytics traffic. Trace entries feed real
 * counters — only operation codes are surfaced, never entry details. */

import {
  aggregateEvents,
  createAnalyticsBuffer,
  createMetricsCollector,
} from "@locallab/diagnostics";
import type {
  AnalyticsEvent,
  ConsentKind,
  DashboardAggregate,
  MetricsSnapshot,
} from "@locallab/diagnostics";

export interface ConsentState {
  product: boolean;
  benchmark: boolean;
}

export interface ConsentPort {
  load(): Promise<ConsentState>;
  save(state: ConsentState): Promise<void>;
}

export function memoryConsentPort(): ConsentPort {
  let state: ConsentState = { product: false, benchmark: false };
  return {
    async load() {
      return { ...state };
    },
    async save(next) {
      state = { ...next };
    },
  };
}

export interface AnalyticsClient {
  sendEvents(batch: AnalyticsEvent[]): Promise<void>;
  dashboard(): Promise<DashboardAggregate>;
}

export function createAnalyticsClient(options: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): AnalyticsClient {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async sendEvents(batch) {
      const response = await doFetch(`${options.baseUrl}/metrics/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batch }),
      });
      if (!response.ok) throw new Error("metrics intake rejected");
    },
    async dashboard() {
      const response = await doFetch(`${options.baseUrl}/metrics/dashboard`);
      if (!response.ok) throw new Error("metrics dashboard unavailable");
      return (await response.json()) as DashboardAggregate;
    },
  };
}

export interface TraceLikeSnapshot {
  entries: readonly {
    time: string;
    operation: string;
    phase: string;
    detail: { code?: string };
  }[];
}

export interface AnalyticsCoordinator {
  getConsents(): ConsentState;
  loadConsents(): Promise<void>;
  setConsent(kind: ConsentKind, on: boolean): Promise<void>;
  recordEvent(raw: unknown): { stored: boolean; reason: string | null };
  recordTrace(snapshot: TraceLikeSnapshot): number;
  flushAnalytics(): Promise<number>;
  localSnapshot(): MetricsSnapshot;
}

export function createAnalyticsCoordinator(options: {
  client?: AnalyticsClient;
  consent?: ConsentPort;
  now?: () => Date;
}): AnalyticsCoordinator {
  const consentPort = options.consent ?? memoryConsentPort();
  const now = options.now ?? (() => new Date());
  const collector = createMetricsCollector(now);
  let consents: ConsentState = { product: false, benchmark: false };
  let buffer = buildBuffer();

  function buildBuffer() {
    return createAnalyticsBuffer({
      isConsented: (kind) => consents[kind],
      transport: {
        async send(batch) {
          if (options.client === undefined)
            throw new Error("no metrics endpoint configured");
          await options.client.sendEvents(batch);
        },
      },
    });
  }


  return {
    getConsents() {
      return { ...consents };
    },
    async loadConsents() {
      consents = await consentPort.load();
    },
    async setConsent(kind, on) {
      consents = { ...consents, [kind]: on };
      await consentPort.save(consents);
      if (!on)
        // Revoking consent drops anything that had been queued.
        buffer = buildBuffer();
    },
    recordEvent(raw) {
      return buffer.record(raw);
    },
    recordTrace(snapshot) {
      let failures = 0;
      for (const entry of snapshot.entries) {
        collector.bump(`trace.${entry.phase}`);
        if (entry.phase === "failed") {
          failures += 1;
          const code = entry.detail.code ?? "unspecified";
          collector.bump(`trace.failed.${code}`);
          buffer.record({
            event: "error-occurred",
            at: entry.time,
            props: { code },
          });
        }
      }
      return failures;
    },
    async flushAnalytics() {
      return await buffer.flush();
    },
    localSnapshot() {
      return collector.snapshot();
    },
  };
}

export type {
  AnalyticsEvent,
  ConsentKind,
  DashboardAggregate,
  MetricsSnapshot,
} from "@locallab/diagnostics";

export { aggregateEvents };
