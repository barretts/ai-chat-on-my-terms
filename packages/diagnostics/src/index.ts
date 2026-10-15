/** Consent-gated product analytics + local metrics (DA-04/UI-19/AR-09).
 * Invariants: anonymous events are dropped unless the matching consent
 * flag is on (consent-off means literally nothing to send), every event
 * is allowlist-validated — property keys are a fixed set per event type
 * and string values are slug-shaped, so prompts, chat text, audio data
 * and secrets cannot be represented — and the support bundle is redacted
 * summaries plus counters, never message content. */

export type ConsentKind = "product" | "benchmark";

export interface AnalyticsEvent {
  event: string;
  at: string;
  props: Record<string, string | number | boolean>;
}

/* Step 3: allowlisted event properties; values below are identifiers
 * and numbers only — there is no property that could hold a prompt,
 * transcript or key. */
export const EVENT_ALLOWLIST: Record<string, readonly string[]> = {
  "app-launch": ["appVersion", "platform"],
  "session-length": ["minutes"],
  "worker-status": ["workerKind", "queueDepth"],
  "error-occurred": ["code"],
  "provider-status": ["providerKind", "ok"],
  "benchmark-result": ["modelClass", "tokensPerSecond", "latencyMs"],
};

const SLUG_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SECRETISH = /(sk-[A-Za-z0-9]|api[_-]?key|secret|token|passw|bearer|private[_-]?key)/i;

export function validateEvent(
  raw: unknown,
): { ok: true; event: AnalyticsEvent } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null)
    return { ok: false, reason: "event must be an object" };
  const record = raw as Record<string, unknown>;
  const { event, at, props } = record;
  if (typeof event !== "string" || !(event in EVENT_ALLOWLIST))
    return { ok: false, reason: "unknown event name" };
  if (typeof at !== "string" || at.length > 40 || at.length === 0)
    return { ok: false, reason: "bad timestamp" };
  if (typeof props !== "object" || props === null)
    return { ok: false, reason: "props must be an object" };
  const allowed = EVENT_ALLOWLIST[event] ?? [];
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!allowed.includes(key))
      return { ok: false, reason: `property not allowlisted: ${key}` };
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 0 || value > 1e12)
        return { ok: false, reason: `bad numeric value for ${key}` };
      clean[key] = value;
    } else if (typeof value === "boolean") {
      clean[key] = value;
    } else if (typeof value === "string") {
      if (!SLUG_VALUE.test(value) || SECRETISH.test(value))
        return { ok: false, reason: `bad string value for ${key}` };
      clean[key] = value;
    } else {
      return { ok: false, reason: `bad value for ${key}` };
    }
  }
  return { ok: true, event: { event, at, props: clean } };
}

/* ---------- local counters (dashboard feeds on real values) ---------- */

export interface MetricsSnapshot {
  updatedAt: string;
  counters: Record<string, number>;
}

export interface MetricsCollector {
  bump(name: string, delta?: number): void;
  snapshot(): MetricsSnapshot;
}

const MAX_COUNTERS = 64;

export function createMetricsCollector(
  now: () => Date = () => new Date(),
): MetricsCollector {
  const counters = new Map<string, number>();
  return {
    bump(name, delta = 1) {
      if (!SLUG_VALUE.test(name) || name.length > 48) return;
      if (counters.size >= MAX_COUNTERS && !counters.has(name)) return;
      const current = counters.get(name) ?? 0;
      counters.set(name, current + delta);
    },
    snapshot() {
      return {
        updatedAt: now().toISOString(),
        counters: Object.fromEntries(counters),
      };
    },
  };
}

/* ---------- consent-gated buffer (step 2) ---------- */

export interface AnalyticsTransport {
  send(batch: AnalyticsEvent[]): Promise<void>;
}

export interface AnalyticsRecordResult {
  stored: boolean;
  reason: string | null;
}

export function consentKindFor(event: string): ConsentKind {
  return event === "benchmark-result" ? "benchmark" : "product";
}

export interface CreateAnalyticsBufferOptions {
  isConsented: (kind: ConsentKind) => boolean;
  transport: AnalyticsTransport;
}

export interface AnalyticsBuffer {
  record(raw: unknown): AnalyticsRecordResult;
  flush(): Promise<number>;
  pending(): number;
}

export function createAnalyticsBuffer(
  options: CreateAnalyticsBufferOptions,
): AnalyticsBuffer {
  const queue: AnalyticsEvent[] = [];
  return {
    record(raw) {
      const validated = validateEvent(raw);
      if (!validated.ok)
        return { stored: false, reason: validated.reason };
      // Consent gate: off means the event never enters the buffer, so a
      // network audit with consent off observes zero analytics.
      if (!options.isConsented(consentKindFor(validated.event.event)))
        return { stored: false, reason: "consent-off" };
      queue.push(validated.event);
      return { stored: true, reason: null };
    },
    async flush() {
      if (queue.length === 0) return 0;
      const batch = [...queue];
      queue.length = 0;
      await options.transport.send(batch);
      return batch.length;
    },
    pending() {
      return queue.length;
    },
  };
}

export interface DashboardAggregate {
  eventCounts: Record<string, number>;
  workerMaxQueueDepth: Record<string, number>;
  errorCodeCounts: Record<string, number>;
  lastSeenAt: string | null;
}

export function aggregateEvents(events: AnalyticsEvent[]): DashboardAggregate {
  const aggregate: DashboardAggregate = {
    eventCounts: {},
    workerMaxQueueDepth: {},
    errorCodeCounts: {},
    lastSeenAt: null,
  };
  for (const item of events) {
    aggregate.eventCounts[item.event] =
      (aggregate.eventCounts[item.event] ?? 0) + 1;
    if (aggregate.lastSeenAt === null || item.at > aggregate.lastSeenAt)
      aggregate.lastSeenAt = item.at;
    if (item.event === "worker-status") {
      const kind = String(item.props.workerKind ?? "unknown");
      const depth = Number(item.props.queueDepth ?? 0);
      aggregate.workerMaxQueueDepth[kind] = Math.max(
        aggregate.workerMaxQueueDepth[kind] ?? 0,
        depth,
      );
    }
    if (item.event === "error-occurred") {
      const code = String(item.props.code ?? "unknown");
      aggregate.errorCodeCounts[code] =
        (aggregate.errorCodeCounts[code] ?? 0) + 1;
    }
  }
  return aggregate;
}

/* ---------- redacted support bundle ---------- */

const SECRET_RUNS = [
  /sk-[A-Za-z0-9_-]{6,}/g,
  /\b[0-9a-f]{32,}\b/gi,
  /\b[A-Za-z0-9+/]{64,}={0,2}\b/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
];

export function redactBundleLine(line: string): string {
  let output = line;
  for (const pattern of SECRET_RUNS)
    output = output.replace(pattern, "[redacted]");
  return output.length > 120 ? `${output.slice(0, 120)}…` : output;
}

export interface SupportBundleInput {
  snapshot: MetricsSnapshot;
  errors: readonly string[];
}

export function buildSupportBundle(input: SupportBundleInput): string {
  return JSON.stringify(
    {
      format: "LocalLab support bundle v1",
      generatedAt: input.snapshot.updatedAt,
      counters: input.snapshot.counters,
      errorSummaries: input.errors
        .slice(0, 20)
        .map((line) => redactBundleLine(line)),
    },
    null,
    2,
  );
}
