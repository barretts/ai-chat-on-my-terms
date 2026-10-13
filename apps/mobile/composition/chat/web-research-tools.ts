import type { PortResult } from "@locallab/contracts/ports";
import type {
  RegisteredTool,
  ToolExecutionContext,
} from "@locallab/tools-engine";
import {
  publicPageUrl,
  WEB_FETCH_TOOL,
  WebResearchError,
  type WebSource,
} from "./web-research";

export const WEB_SEARCH_TOOL = "web_search";
/** Stable identity for the built-in research server; it never changes per run. */
export const WEB_TOOL_SERVER_ID = "00000000-0000-7000-8000-000000000086";
export const WEB_TOOL_LIMITS = Object.freeze({
  searchesPerTurn: 2,
  fetchesPerTurn: 4,
  searchResultCharacters: 800,
  searchResults: 8,
  pageCharacters: 12_000,
});

function object(
  input: unknown,
  allowedKeys: readonly string[],
  toolName: string,
): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Object.keys(input).some((key) => !allowedKeys.includes(key))
  )
    throw new Error(
      `The ${toolName} arguments must be a complete JSON object with only the documented fields.`,
    );
  return input as Record<string, unknown>;
}

function searchInput(input: unknown): { query: string } {
  const value = object(input, ["query"], WEB_SEARCH_TOOL);
  if (typeof value.query !== "string")
    throw new Error(`${WEB_SEARCH_TOOL} requires query text.`);
  const query = value.query.replace(/\s+/g, " ").trim();
  if (!query || query.length > 500)
    throw new Error(
      `${WEB_SEARCH_TOOL} needs a search query of 1 to 500 characters.`,
    );
  return { query };
}

function fetchInput(input: unknown): { url: string } {
  const value = object(input, ["url"], WEB_FETCH_TOOL);
  if (typeof value.url !== "string" || !value.url || value.url.length > 2048)
    throw new Error(
      `${WEB_FETCH_TOOL} requires a public http(s) URL of at most 2048 characters.`,
    );
  return { url: value.url };
}

function compactSource(source: WebSource): {
  url: string;
  title: string;
  text: string;
  kind: WebSource["kind"];
} {
  return {
    url: source.url,
    title: source.title.slice(0, 200),
    text: source.text.slice(
      0,
      source.kind === "page-excerpt"
        ? WEB_TOOL_LIMITS.pageCharacters
        : WEB_TOOL_LIMITS.searchResultCharacters,
    ),
    kind: source.kind,
  };
}

function researchFailure(cause: unknown): PortResult<unknown> {
  const message =
    cause instanceof WebResearchError
      ? cause.message
      : "Web research could not finish. Try a different query or public link.";
  return {
    ok: false,
    error: { code: "offline", message, recoverable: true },
  };
}

/** One client per turn so search/read counters are per answer, not per app. */
export function createWebResearchTools(
  client: {
    search(query: string, signal: AbortSignal): Promise<WebSource[]>;
    fetchPage(url: string, signal: AbortSignal): Promise<WebSource>;
  },
): readonly RegisteredTool[] {
  let searches = 0;
  let fetches = 0;
  return [
    {
      name: WEB_SEARCH_TOOL,
      serverId: WEB_TOOL_SERVER_ID,
      description:
        "Search the public web for current, changing, or uncertain facts. Returns up to " +
        `${WEB_TOOL_LIMITS.searchResults} results with url, title and a short snippet. Search at most ${WEB_TOOL_LIMITS.searchesPerTurn} times per answer; refine one question instead of repeating it.`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            description: "A focused search question.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      enabled: true,
      parseInput: (input) => searchInput(input),
      execute: async (
        input,
        context,
      ): Promise<PortResult<unknown>> => {
        const { query } = input as { query: string };
        if (searches >= WEB_TOOL_LIMITS.searchesPerTurn)
          return {
            ok: true,
            value: {
              results: [],
              message: `This answer already used its ${WEB_TOOL_LIMITS.searchesPerTurn} searches. Answer with the evidence you have or read one of the listed URLs.`,
            },
          };
        searches += 1;
        try {
          if (context.signal.aborted)
            throw new WebResearchError(
              "Web research was canceled.",
              "canceled",
            );
          const results = await client.search(query, context.signal);
          return {
            ok: true,
            value: {
              results: results
                .slice(0, WEB_TOOL_LIMITS.searchResults)
                .map(compactSource),
              ...(results.length
                ? {}
                : {
                    message:
                      "No search results found. Try a more specific question or read a public link.",
                  }),
            },
          };
        } catch (cause) {
          if (context.signal.aborted) throw cause;
          return researchFailure(cause);
        }
      },
    },
    {
      name: WEB_FETCH_TOOL,
      serverId: WEB_TOOL_SERVER_ID,
      description:
        "Read one public web page as text. Use it on a promising search result URL to confirm details before answering. Public articles only; sign-in, local and challenge pages fail. Read at most " +
        `${WEB_TOOL_LIMITS.fetchesPerTurn} pages per answer.`,
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            minLength: 1,
            maxLength: 2048,
            description: "A public http(s) URL to read.",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
      enabled: true,
      parseInput: (input) => fetchInput(input),
      execute: async (
        input,
        context,
      ): Promise<PortResult<unknown>> => {
        const { url } = input as { url: string };
        if (fetches >= WEB_TOOL_LIMITS.fetchesPerTurn)
          return {
            ok: true,
            value: {
              message: `This answer already read its ${WEB_TOOL_LIMITS.fetchesPerTurn} pages. Answer with the evidence you have.`,
            },
          };
        let validatedUrl: string;
        try {
          validatedUrl = publicPageUrl(url);
        } catch (cause) {
          return cause instanceof WebResearchError
            ? {
                ok: false,
                error: {
                  code: "permission",
                  message: cause.message,
                  recoverable: true,
                },
              }
            : researchFailure(cause);
        }
        fetches += 1;
        try {
          if (context.signal.aborted)
            throw new WebResearchError(
              "Web research was canceled.",
              "canceled",
            );
          const source = await client.fetchPage(validatedUrl, context.signal);
          return {
            ok: true,
            value: { source: compactSource(source) },
          };
        } catch (cause) {
          if (context.signal.aborted) throw cause;
          return researchFailure(cause);
        }
      },
    },
  ];
}
