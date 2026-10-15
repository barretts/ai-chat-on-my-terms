import type { FastifyInstance } from "fastify";
import {
  HostedSearchError,
  type HostedSearchErrorCode,
  type HostedSearchOutcome,
} from "@locallab/tools-hosted-search";

const statusByCode: Record<HostedSearchErrorCode, number> = {
  "not-configured": 409,
  disabled: 403,
  "limit-reached": 429,
  "malformed-query": 400,
  upstream: 502,
  canceled: 499,
};

export interface NewsBriefing {
  query: string;
  /** Composed from the top sources only — never invented content. */
  summary: string;
  provider: string;
  sources: HostedSearchOutcome["sources"];
  generatedAt: number;
}

/**
 * News briefings (T117H): live sources come ONLY from the enabled
 * hosted-search provider (a disabled provider surfaces 403, never a
 * silent fallback); briefings are cached with a source-freshness
 * stamp and served fresh until they expire.
 */
export class NewsBriefingService {
  private readonly cache = new Map<string, NewsBriefing>();

  constructor(
    private readonly search: {
      search(query: string): Promise<HostedSearchOutcome>;
    },
    private readonly options: { maxAgeMs: number; now(): number },
  ) {}

  async brief(
    query: string,
  ): Promise<{ cached: boolean; briefing: NewsBriefing }> {
    const q = query.trim();
    if (q.length === 0 || q.length > 200)
      throw new HostedSearchError(
        "malformed-query",
        "Briefing query must be 1-200 characters.",
      );
    const key = q.toLocaleLowerCase();
    const hit = this.cache.get(key);
    if (hit !== undefined && this.options.now() - hit.generatedAt <= this.options.maxAgeMs)
      return { cached: true, briefing: hit };
    const outcome = await this.search.search(q);
    const briefing: NewsBriefing = {
      query: q,
      summary: outcome.sources
        .slice(0, 3)
        .map((s) => `${s.title}: ${s.snippet}`)
        .join("\n"),
      provider: outcome.provider,
      sources: outcome.sources,
      generatedAt: this.options.now(),
    };
    this.cache.set(key, briefing);
    return { cached: false, briefing };
  }
}

export function registerNewsBriefingRoute(
  app: FastifyInstance,
  service: NewsBriefingService,
): void {
  app.get("/news/brief", async (request, reply) => {
    const query = (request.query as { q?: unknown } | undefined)?.q;
    try {
      const result = await service.brief(
        typeof query === "string" ? query : "",
      );
      return { ok: true, ...result };
    } catch (error) {
      if (error instanceof HostedSearchError) {
        void reply.status(statusByCode[error.code]);
        return { ok: false, code: error.code, message: error.message };
      }
      void reply.status(500);
      return {
        ok: false,
        code: "upstream",
        message: "News briefing failed unexpectedly.",
      };
    }
  });
}
