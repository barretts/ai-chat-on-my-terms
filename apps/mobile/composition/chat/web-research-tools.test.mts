import { expect, it } from "vitest";
import { ToolRegistry, type ToolExecutionContext } from "@locallab/tools-engine";
import { WebResearchError, WEB_FETCH_TOOL } from "./web-research";
import {
  createWebResearchTools,
  WEB_SEARCH_TOOL,
  WEB_TOOL_LIMITS,
} from "./web-research-tools";

const context = (
  signal = new AbortController().signal,
): ToolExecutionContext => ({
  invocationId: "00000000-0000-7000-8000-000000000031",
  conversationId: "00000000-0000-7000-8000-000000000032",
  runId: "00000000-0000-7000-8000-000000000033",
  signal,
});

const client = (overrides: Partial<Record<string, unknown>> = {}) => ({
  search: async (query: string) => [
    {
      url: "https://example.com/a",
      title: "Example A",
      text: "Snippet for " + query,
      kind: "search-snippet" as const,
    },
  ],
  fetchPage: async (url: string) => ({
    url,
    title: "Page",
    text: "Page content",
    kind: "page-excerpt" as const,
  }),
  ...overrides,
});

it("registers under stable names with object schemas", () => {
  const registry = new ToolRegistry();
  for (const tool of createWebResearchTools(client())) registry.register(tool);
  const names = registry
    .snapshot(
      { globalEnabled: true, capabilities: { tools: "yes" } },
      [WEB_SEARCH_TOOL, WEB_FETCH_TOOL],
    )
    .map((tool) => tool.name);
  expect(names).toEqual([WEB_SEARCH_TOOL, WEB_FETCH_TOOL]);
});

it("rejects malformed arguments before any network access", () => {
  const tools = createWebResearchTools(client());
  const search = tools[0];
  expect(() => search?.parseInput({ q: "hi" })).toThrow(/complete JSON object/);
  expect(() => search?.parseInput({ query: "  " })).toThrow(/1 to 500/);
  expect(() => search?.parseInput({ query: "x".repeat(501) })).toThrow(
    /1 to 500/,
  );
  expect(search?.parseInput({ query: " Expo SDK " })).toEqual({
    query: "Expo SDK",
  });
  const fetch = tools[1];
  expect(() => fetch?.parseInput({ url: "" })).toThrow(/public http/);
  expect(() => fetch?.parseInput({ url: "x".repeat(2049) })).toThrow(
    /2048 characters/,
  );
});

it("caps searches per turn without failing the loop", async () => {
  const calls: string[] = [];
  const tools = createWebResearchTools({
    search: async (query: string) => {
      calls.push(query);
      return [
        {
          url: "https://example.com/a",
          title: "A",
          text: "one",
          kind: "search-snippet" as const,
        },
      ];
    },
    fetchPage: async () => {
      throw new Error("unused");
    },
  });
  const search = tools[0];
  if (!search) throw new Error("expected the search tool");
  for (let round = 0; round < WEB_TOOL_LIMITS.searchesPerTurn; round++)
    expect((await search.execute({ query: `q${round}` }, context())).ok).toBe(
      true,
    );
  const capped = await search.execute({ query: "q3" }, context());
  expect(capped.ok).toBe(true);
  if (!capped.ok) throw new Error("the limit must not fail the loop");
  expect(JSON.stringify(capped.value)).toContain("searches");
  expect(calls).toHaveLength(WEB_TOOL_LIMITS.searchesPerTurn);
});

it("caps page reads per turn", async () => {
  let fetches = 0;
  const tools = createWebResearchTools({
    search: async () => {
      throw new Error("unused");
    },
    fetchPage: async (url: string) => {
      fetches += 1;
      return {
        url,
        title: "Page",
        text: "content",
        kind: "page-excerpt" as const,
      };
    },
  });
  const fetch = tools[1];
  if (!fetch) throw new Error("expected the fetch tool");
  for (let round = 0; round < WEB_TOOL_LIMITS.fetchesPerTurn; round++)
    expect(
      (
        await fetch.execute(
          { url: `https://example.com/${round}` },
          context(),
        )
      ).ok,
    ).toBe(true);
  const capped = await fetch.execute(
    { url: "https://example.com/over" },
    context(),
  );
  expect(capped.ok).toBe(true);
  if (!capped.ok) throw new Error("the limit must not fail the loop");
  expect(JSON.stringify(capped.value)).toContain("pages");
  expect(fetches).toBe(WEB_TOOL_LIMITS.fetchesPerTurn);
});

it("refuses private or unsafe URLs before fetching", async () => {
  const tools = createWebResearchTools(client());
  const fetch = tools[1];
  if (!fetch) throw new Error("expected the fetch tool");
  const result = await fetch.execute({ url: "http://127.0.0.1/" }, context());
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("private URLs must be refused");
  expect(result.error.code).toBe("permission");
  expect(result.error.recoverable).toBe(true);
});

it("returns retrieval failures as structured recoverable results", async () => {
  const tools = createWebResearchTools({
    search: async () => {
      throw new WebResearchError(
        "Public search was blocked by browser verification.",
        "verification",
      );
    },
    fetchPage: async () => {
      throw new Error("unused");
    },
  });
  const search = tools[0];
  if (!search) throw new Error("expected the search tool");
  const result = await search.execute({ query: "anything" }, context());
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("failures must be reported");
  expect(result.error).toMatchObject({
    code: "offline",
    message: "Public search was blocked by browser verification.",
    recoverable: true,
  });
});

it("rethrows cancellation instead of hiding it as a result", async () => {
  const controller = new AbortController();
  controller.abort();
  const tools = createWebResearchTools(client());
  const search = tools[0];
  if (!search) throw new Error("expected the search tool");
  await expect(
    search.execute({ query: "never" }, context(controller.signal)),
  ).rejects.toThrow(WebResearchError);
});

it("bounds returned source fields", async () => {
  const long = "y".repeat(40_000);
  const tools = createWebResearchTools({
    search: async () => [
      {
        url: "https://example.com/long",
        title: "t".repeat(400),
        text: long,
        kind: "search-snippet" as const,
      },
    ],
    fetchPage: async () => ({
      url: "https://example.com/long",
      title: "t".repeat(400),
      text: long,
      kind: "page-excerpt" as const,
    }),
  });
  const fetch = tools[1];
  const search = tools[0];
  if (!fetch || !search) throw new Error("expected both tools");
  const fetched = await fetch.execute(
    { url: "https://example.com/long" },
    context(),
  );
  if (!fetched.ok) throw new Error("expected a successful read");
  const page = fetched.value;
  if (
    typeof page !== "object" ||
    page === null ||
    !("source" in page) ||
    typeof page.source !== "object" ||
    page.source === null ||
    !("text" in page.source) ||
    typeof page.source.text !== "string" ||
    !("title" in page.source) ||
    typeof page.source.title !== "string"
  )
    throw new Error("expected a bounded source result");
  expect(page.source.text.length).toBe(WEB_TOOL_LIMITS.pageCharacters);
  expect(page.source.title.length).toBe(200);
  const searched = await search.execute({ query: "long" }, context());
  if (!searched.ok) throw new Error("expected a successful search");
  const results = searched.value;
  if (
    typeof results !== "object" ||
    results === null ||
    !("results" in results) ||
    !Array.isArray(results.results)
  )
    throw new Error("expected a search results payload");
  const snippet = results.results[0];
  if (
    typeof snippet !== "object" ||
    snippet === null ||
    !("text" in snippet) ||
    typeof snippet.text !== "string"
  )
    throw new Error("expected a snippet payload");
  expect(snippet.text.length).toBe(WEB_TOOL_LIMITS.searchResultCharacters);
});
