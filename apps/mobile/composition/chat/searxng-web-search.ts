import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import {
  normalizeSearxngBaseUrl,
  SearxngClient,
  type SearxngError,
  type SearxngSearchOutcome,
} from "@locallab/tools-searxng";
import {
  plainHtml,
  publicPageUrl,
  WebResearchError,
  type WebSource,
} from "./web-research";

/** The two methods the research tools and manual path actually call. */
export interface WebResearchClientLike {
  search(query: string, signal: AbortSignal): Promise<WebSource[]>;
  fetchPage(input: string, signal: AbortSignal): Promise<WebSource>;
}

/**
 * A configured self-hosted or public SearXNG instance. Page reads stay with
 * the credential-free public client; failures are reported honestly for this
 * service and never fall back to DuckDuckGo, Brave or the public path.
 */
export function createSearxngResearchClient(options: {
  publicClient: WebResearchClientLike;
  secrets: SecretStore;
  credentialRef: SecretRef | null;
  endpoint: string | null;
  fetcher: typeof fetch;
  timeoutMs?: number;
}): WebResearchClientLike {
  if (options.endpoint === null)
    throw new WebResearchError(
      "Save the SearXNG server address in Web search settings before choosing SearXNG.",
      "request",
    );
  const endpoint = normalizeSearxngBaseUrl(options.endpoint);
  return {
    fetchPage: options.publicClient.fetchPage.bind(options.publicClient),
    async search(query, signal): Promise<WebSource[]> {
      const normalized = query
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500)
        .split(" ")
        .slice(0, 75)
        .join(" ");
      if (!normalized)
        throw new WebResearchError("Write a search question before sending.");
      // The saved key is optional: instances may run without auth. A
      // reference saved for a different service resolves to no headers and
      // simply stays unused, so it is never sent to this address.
      let headers: Record<string, string> = {};
      if (options.credentialRef !== null)
        try {
          headers = await options.secrets.resolveHeaders(
            new URL(endpoint).origin,
            [options.credentialRef],
          );
        } catch {
          headers = {};
        }
      const client = new SearxngClient(
        {
          baseUrl: endpoint,
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
          ...(options.timeoutMs === undefined
            ? {}
            : { timeoutMs: options.timeoutMs }),
        },
        { fetch: options.fetcher },
      );
      let outcome: SearxngSearchOutcome;
      try {
        outcome = await client.search(normalized, signal);
      } catch (cause) {
        throw toWebResearchError(cause, endpoint);
      }
      const sources: WebSource[] = [];
      const seen = new Set<string>();
      for (const result of outcome.results) {
        try {
          const url = publicPageUrl(result.url);
          if (seen.has(url)) continue;
          seen.add(url);
          sources.push({
            url,
            title: plainHtml(result.title) || new URL(url).hostname,
            text: plainHtml(result.text).slice(0, 2000),
            kind: "search-snippet",
          });
          if (sources.length === 10) break;
        } catch {
          /* Ignore invalid/non-public results, never invent replacement links. */
        }
      }
      return sources;
    },
  };
}

function toWebResearchError(
  cause: unknown,
  endpoint: string,
): WebResearchError {
  if (cause instanceof WebResearchError) return cause;
  const code = isSearxngError(cause) ? cause.code : undefined;
  const message = cause instanceof Error ? cause.message : String(cause);
  switch (code) {
    case "canceled":
      return new WebResearchError("Web research was canceled.", "canceled", {
        cause,
      });
    case "timeout":
      return new WebResearchError(
        `SearXNG at ${endpoint} timed out. Try again later or choose another search service.`,
        "timeout",
        { cause },
      );
    case "auth":
      return new WebResearchError(
        "The SearXNG server rejected the saved key. Check the key in Web search settings.",
        "http",
        { cause },
      );
    case "ratelimited":
      return new WebResearchError(
        "The SearXNG server is rate limiting searches. Wait and try again.",
        "rate-limit",
        { cause },
      );
    case "offline":
      return new WebResearchError(
        `SearXNG at ${endpoint} could not be reached. Check that the server is running.`,
        "network",
        { cause },
      );
    case "malformed":
      return new WebResearchError(
        "The SearXNG server returned an unreadable response. Check the server configuration.",
        "unreadable",
        { cause },
      );
    case "unsupported":
      return new WebResearchError(
        "The SearXNG server does not allow the JSON search API. Enable format=json in its settings.",
        "unreadable",
        { cause },
      );
    default:
      return new WebResearchError(
        `SearXNG search failed: ${message}`,
        "request",
        { cause },
      );
  }
}

function isSearxngError(value: unknown): value is SearxngError {
  return (
    value instanceof Error &&
    "code" in value &&
    typeof (value as { code?: unknown }).code === "string"
  );
}
