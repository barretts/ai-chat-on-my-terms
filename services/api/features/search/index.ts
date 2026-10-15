import type { FastifyInstance } from "fastify";
import {
  HostedSearchError,
  type HostedSearchErrorCode,
  type HostedSearchService,
} from "@locallab/tools-hosted-search";

const statusByCode: Record<HostedSearchErrorCode, number> = {
  "not-configured": 409,
  disabled: 403,
  "limit-reached": 429,
  "malformed-query": 400,
  upstream: 502,
  canceled: 499,
};

/**
 * Hosted search feature route (TO-16). Authentication is owned by the
 * service layer in front of this route; the handler only maps the
 * facade's structured codes to HTTP statuses. Query text and source
 * payloads are returned to the caller and never logged here.
 */
export function registerHostedSearchRoute(
  app: FastifyInstance,
  service: HostedSearchService,
): void {
  app.get("/search", async (request, reply) => {
    const query = (request.query as { q?: unknown } | undefined)?.q;
    try {
      const outcome = await service.search(
        typeof query === "string" ? query : "",
      );
      return { ok: true, ...outcome };
    } catch (error) {
      if (error instanceof HostedSearchError) {
        void reply.status(statusByCode[error.code]);
        return {
          ok: false,
          code: error.code,
          message: error.message,
          ...(error.retryAfterMs !== undefined
            ? { retryAfterMs: error.retryAfterMs }
            : {}),
        };
      }
      void reply.status(500);
      return {
        ok: false,
        code: "upstream",
        message: "Hosted search failed unexpectedly.",
      };
    }
  });
}
