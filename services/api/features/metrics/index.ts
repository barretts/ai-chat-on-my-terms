/** Metrics intake + analytics dashboard (UI-19/DA-04/AR-09). Events are
 * validated against the shared allowlist from `@locallab/diagnostics`
 * before storage, so prompts/chat text/secrets can never enter the
 * store; the dashboard aggregates stored events only — an empty store
 * renders an empty dashboard, never fixture numbers. */

import type { FastifyInstance } from "fastify";
import {
  aggregateEvents,
  validateEvent,
  type AnalyticsEvent,
} from "@locallab/diagnostics";

export interface MetricsStore {
  insertEvents(events: AnalyticsEvent[]): Promise<void>;
  allEvents(): Promise<AnalyticsEvent[]>;
}

export function memoryMetricsStore(): MetricsStore {
  const events: AnalyticsEvent[] = [];
  return {
    async insertEvents(batch) {
      events.push(...batch);
    },
    async allEvents() {
      return [...events];
    },
  };
}

export interface RegisterMetricsOptions {
  store: MetricsStore;
}

export function registerMetricsRoutes(
  app: FastifyInstance,
  options: RegisterMetricsOptions,
): void {
  app.post("/metrics/events", async (request, reply) => {
    const body = request.body as { batch?: unknown };
    if (!Array.isArray(body.batch) || body.batch.length > 200)
      return reply.code(400).send({ code: "bad-batch" });
    const clean: AnalyticsEvent[] = [];
    for (const raw of body.batch) {
      const validated = validateEvent(raw);
      if (!validated.ok)
        return reply
          .code(400)
          .send({ code: "invalid-event", reason: validated.reason });
      clean.push(validated.event);
    }
    await options.store.insertEvents(clean);
    return reply.code(200).send({ accepted: clean.length });
  });

  // Step 1: the dashboard reports real workers/errors from stored
  // events; nothing is synthesized.
  app.get("/metrics/dashboard", async () => {
    return aggregateEvents(await options.store.allEvents());
  });
}
