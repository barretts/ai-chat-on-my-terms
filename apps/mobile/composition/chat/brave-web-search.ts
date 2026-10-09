import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import { httpResponseError } from "@locallab/network-http";
import { registerDiagnosticSecret } from "../../features/diagnostics/sanitization";
import {
  boundedText,
  plainHtml,
  publicPageUrl,
  WebResearchError,
  type createWebResearchClient,
  type WebSource,
} from "./web-research";

export const BRAVE_SEARCH_ORIGIN = "https://api.search.brave.com";
export const BRAVE_SEARCH_HEADER = "x-subscription-token";

/** The optional official search API is separate from credential-free page reads. */
export function createBraveResearchClient(options: {
  publicClient: ReturnType<typeof createWebResearchClient>;
  fetcher: typeof fetch;
  secrets: SecretStore;
  credentialRef: SecretRef | null;
  timeoutMs?: number;
}): ReturnType<typeof createWebResearchClient> {
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
      if (!options.credentialRef)
        throw new WebResearchError(
          "Add and save your Brave Search API key in Web search settings, or choose Public search.",
        );
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs ?? 20_000);
      try {
        if (signal.aborted)
          throw new WebResearchError("Web research was canceled.", "canceled");
        let token: string | undefined;
        try {
          const headers = await options.secrets.resolveHeaders(
            BRAVE_SEARCH_ORIGIN,
            [options.credentialRef],
          );
          token = headers[BRAVE_SEARCH_HEADER];
          if (!token) throw new Error("Missing search token");
        } catch (cause) {
          throw new WebResearchError(
            "Your saved Brave Search key is unavailable. Enter and save it again in Web search settings, or choose Public search.",
            "request",
            { cause },
          );
        }
        if (controller.signal.aborted)
          throw new WebResearchError("Web research was canceled.", "canceled");
        registerDiagnosticSecret(token);
        const url = `${BRAVE_SEARCH_ORIGIN}/res/v1/web/search?q=${encodeURIComponent(normalized)}&count=5&extra_snippets=true`;
        const response = await options.fetcher(url, {
          method: "GET",
          headers: { accept: "application/json", [BRAVE_SEARCH_HEADER]: token },
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) {
          const cause = await httpResponseError(response, {
            signal: controller.signal,
            timeoutMs: 0,
          });
          throw new WebResearchError(
            response.status === 401 || response.status === 403
              ? "Brave Search rejected the API key. Check the key and active Search plan in its dashboard."
              : response.status === 429
                ? "Brave Search reached a rate or account quota limit. Wait or check your plan, then try again."
                : `Brave Search returned HTTP ${response.status}. Try again later or choose Public search.`,
            response.status === 429 ? "rate-limit" : "http",
            { cause },
          );
        }
        const body = await boundedText(response, controller.signal);
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch (cause) {
          throw new WebResearchError(
            "Brave Search returned an unreadable response. Try again later.",
            "unreadable",
            { responseBody: body, cause },
          );
        }
        if (
          !payload ||
          typeof payload !== "object" ||
          !("web" in payload) ||
          !payload.web ||
          typeof payload.web !== "object" ||
          !("results" in payload.web) ||
          !Array.isArray(payload.web.results)
        )
          throw new WebResearchError(
            "Brave Search returned no usable web result data. Try another question or check your Search plan.",
            "unreadable",
            { responseBody: body },
          );
        const sources: WebSource[] = [];
        const seen = new Set<string>();
        for (const item of payload.web.results) {
          if (!item || typeof item !== "object" || typeof item.url !== "string")
            continue;
          try {
            const url = publicPageUrl(item.url);
            if (seen.has(url)) continue;
            const snippets = [
              typeof item.description === "string" ? item.description : "",
              ...(Array.isArray(item.extra_snippets)
                ? item.extra_snippets.filter(
                    (value: unknown): value is string =>
                      typeof value === "string",
                  )
                : []),
            ];
            seen.add(url);
            sources.push({
              url,
              title:
                typeof item.title === "string"
                  ? plainHtml(item.title).slice(0, 200)
                  : new URL(url).hostname,
              text: [...new Set(snippets.map(plainHtml).filter(Boolean))]
                .join("\n")
                .slice(0, 2000),
              kind: "search-snippet",
            });
            if (sources.length === 5) break;
          } catch {
            /* Ignore invalid/non-public results, never invent replacement links. */
          }
        }
        return sources;
      } catch (cause) {
        if (signal.aborted)
          throw new WebResearchError("Web research was canceled.", "canceled");
        if (timedOut)
          throw new WebResearchError(
            "Brave Search timed out. Try again later or choose Public search.",
            "timeout",
            { cause },
          );
        if (cause instanceof WebResearchError) throw cause;
        throw new WebResearchError(
          "Brave Search could not be reached. Check your connection and try again.",
          "network",
          { cause },
        );
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
      }
    },
  };
}
