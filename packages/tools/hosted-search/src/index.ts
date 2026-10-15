/** Structured failure codes; never free-form exceptions, so callers can
 * branch without string matching and no provider payload is echoed. */
export type HostedSearchErrorCode =
  | "not-configured"
  | "disabled"
  | "limit-reached"
  | "malformed-query"
  | "upstream"
  | "canceled";

export class HostedSearchError extends Error {
  constructor(
    readonly code: HostedSearchErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HostedSearchError";
  }
}

/** One normalized search source. URLs are http(s) only; texts are
 * control-character-free and length-bounded by the facade. */
export interface HostedSearchSource {
  title: string;
  url: string;
  snippet: string;
}

export interface HostedSearchUpstreamResponse {
  sources: readonly Partial<HostedSearchSource>[];
  /** True when the upstream truncated results before sending them. */
  upstreamTruncated?: boolean;
}

export interface HostedSearchUpstream {
  readonly name: string;
  search(
    query: string,
    options: { maxResults: number; signal?: AbortSignal },
  ): Promise<HostedSearchUpstreamResponse>;
}

export interface HostedSearchConfig {
  /** Hosted search is opt-in; disabled never falls back to anything. */
  enabled: false | true;
  /** Bring-your-own upstream adapter; absent + enabled = not-configured. */
  upstream?: HostedSearchUpstream;
  /** Account limit window enforced locally before calling upstream. */
  maxRequestsPerWindow?: number;
  windowMs?: number;
  /** Upper bound on kept results; default 10, hard cap 25. */
  maxResults?: number;
}

export interface HostedSearchOutcome {
  provider: string;
  sources: HostedSearchSource[];
  /** Normalized entries dropped (bad URL, empty title+snippet). */
  dropped: number;
  upstreamTruncated: boolean;
}

const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_CAP = 25;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 10;
const MAX_QUERY_CHARS = 400;
const MAX_TITLE_CHARS = 200;
const MAX_SNIPPET_CHARS = 800;

const NOT_CONFIGURED_MESSAGE =
  "Hosted search is enabled but no upstream is configured. Add a hosted " +
  "search upstream in Connections settings first; no search was performed.";

/** A deterministic mock upstream for local development and fixtures:
 * exact-query table lookup, no network, no randomness. Unknown queries
 * return zero sources rather than guessing. */
export function createMockHostedSearchUpstream(
  fixtures: Record<string, readonly Partial<HostedSearchSource>[]>,
  name = "mock",
): HostedSearchUpstream {
  const table: Record<string, readonly Partial<HostedSearchSource>[]> = {
    ...fixtures,
  };
  return {
    name,
    async search(query, { maxResults, signal }) {
      if (signal?.aborted)
        throw new HostedSearchError("canceled", "Search was canceled.");
      const rows = table[query.trim().toLocaleLowerCase()] ?? [];
      return { sources: rows.slice(0, maxResults) };
    },
  };
}

function sanitizeChars(value: string, maxChars: number): string {
  let text = "";
  for (const char of value) {
    const point = char.codePointAt(0) ?? 0xfffd;
    if (point < 0x20 || (point >= 0x7f && point <= 0x9f)) text += " ";
    else text += char;
  }
  return [...text].slice(0, maxChars).join("").trim();
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Authenticated configurable hosted search facade (TO-16, TO-17, TO-19).
 * The caller owns authentication; this package receives a resolved
 * upstream adapter and enforces account limits locally. Nothing here logs
 * queries or upstream payloads — verified by the test console spy.
 */
export class HostedSearchService {
  private requestTimes: number[] = [];
  private readonly maxResults: number;
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(private readonly config: HostedSearchConfig) {
    this.maxResults = Math.min(
      MAX_RESULTS_CAP,
      Math.max(1, config.maxResults ?? DEFAULT_MAX_RESULTS),
    );
    this.maxRequests = Math.max(
      1,
      config.maxRequestsPerWindow ?? DEFAULT_MAX_REQUESTS,
    );
    this.windowMs = Math.max(1_000, config.windowMs ?? DEFAULT_WINDOW_MS);
  }

  status(): {
    enabled: boolean;
    configured: boolean;
    provider: string | null;
  } {
    return {
      enabled: this.config.enabled === true,
      configured: this.config.enabled === true && !!this.config.upstream,
      provider: this.config.upstream?.name ?? null,
    };
  }

  async search(
    query: string,
    options?: { signal?: AbortSignal },
  ): Promise<HostedSearchOutcome> {
    if (this.config.enabled !== true)
      throw new HostedSearchError(
        "disabled",
        "Hosted search is disabled in settings; enable it explicitly to use it.",
      );
    if (!this.config.upstream)
      throw new HostedSearchError("not-configured", NOT_CONFIGURED_MESSAGE);
    const trimmed = query.trim();
    if (trimmed === "")
      throw new HostedSearchError(
        "malformed-query",
        "The search query is empty.",
      );
    const bounded = [...trimmed].slice(0, MAX_QUERY_CHARS).join("");
    this.consumeBudget();
    let response: HostedSearchUpstreamResponse;
    try {
      response = await this.config.upstream.search(bounded, {
        maxResults: this.maxResults,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    } catch (cause) {
      if (cause instanceof HostedSearchError && cause.code === "canceled")
        throw cause;
      throw new HostedSearchError(
        "upstream",
        `The hosted search upstream failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    const sources: HostedSearchSource[] = [];
    let dropped = 0;
    for (const row of response.sources) {
      const url = typeof row.url === "string" ? row.url.trim() : "";
      const title = sanitizeChars(row.title ?? "", MAX_TITLE_CHARS);
      const snippet = sanitizeChars(row.snippet ?? "", MAX_SNIPPET_CHARS);
      if (!isHttpUrl(url) || (title === "" && snippet === "")) {
        dropped += 1;
        continue;
      }
      sources.push({ title, url, snippet });
      if (sources.length >= this.maxResults) break;
    }
    return {
      provider: this.config.upstream.name,
      sources,
      dropped,
      upstreamTruncated: response.upstreamTruncated === true,
    };
  }

  private consumeBudget(): void {
    const now = Date.now();
    this.requestTimes = this.requestTimes.filter(
      (time) => now - time < this.windowMs,
    );
    if (this.requestTimes.length >= this.maxRequests) {
      const waitMs = this.windowMs - (now - this.requestTimes[0]!);
      throw new HostedSearchError(
        "limit-reached",
        `The hosted search account limit (${this.maxRequests} requests per ` +
          `${this.windowMs / 1000}s) is reached. Try again in about ` +
          `${Math.ceil(waitMs / 1000)}s.`,
        Math.max(1, waitMs),
      );
    }
    this.requestTimes.push(now);
  }
}
