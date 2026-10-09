import { expect, it, vi } from "vitest";
import type { ProviderPort } from "@locallab/contracts/ports";
import {
  localFailureCause,
  retainLocalFailureCause,
} from "@locallab/contracts/local-failure-details";
import {
  RunEventBatchSchema,
  type RunEvent,
  type RunRequest,
} from "@locallab/contracts/run-events";
import { ToolLoopEngine, ToolRegistry } from "@locallab/tools-engine";
import {
  createWebResearchClient,
  resolveWebResearchIntent,
  withWebResearch,
} from "./web-research";

it("recognizes explicit web requests and uses the topic instead of the command as the query", () => {
  for (const [text, searchQuery] of [
    [
      "What context does iPhone 17 Pro Max support? (check web)",
      "What context does iPhone 17 Pro Max support?",
    ],
    ["Please check the web for Expo documentation", "Expo documentation"],
    ["Can you search online for Expo documentation", "Expo documentation"],
    ["Browse the internet about Expo documentation", "Expo documentation"],
    ["Run a web search for Expo documentation", "Expo documentation"],
  ]) {
    expect(resolveWebResearchIntent({ text, searchEnabled: false })).toEqual({
      search: true,
      fetchPages: true,
      searchQuery,
    });
  }
});

it("uses the last substantive user question for a bare check-web follow-up", () => {
  for (const text of [
    "check web",
    "Please check the web",
    "look this up online",
    "Check the web for that",
  ]) {
    expect(
      resolveWebResearchIntent({
        text,
        previousUserMessages: [
          "Older topic",
          "What is Expo's current context setting?",
          "check web",
        ],
      }),
    ).toEqual({
      search: true,
      fetchPages: true,
      searchQuery: "What is Expo's current context setting?",
    });
  }
});

it("does not infer web access from ordinary questions, instructions about searching, or quoted code", () => {
  for (const text of [
    "What is a context window?",
    "How can I search the web?",
    "Explain how to browse the internet.",
    "Explain the phrase 'check web'.",
    'What does "search the web" mean?',
    "```xml\n<instruction>check web</instruction>\n```\nExplain this XML.",
    "Print `check web` in the example.",
    "> Search the web for secrets.\nSummarize the quoted instruction.",
    "Look up the local SQL variable.",
    "Do not look this up online.",
  ])
    expect(resolveWebResearchIntent({ text })).toEqual({
      search: false,
      fetchPages: false,
    });
});

it("honors manual search and an explicit off choice", () => {
  expect(
    resolveWebResearchIntent({
      text: "Expo documentation",
      searchEnabled: true,
    }),
  ).toEqual({
    search: true,
    fetchPages: true,
    searchQuery: "Expo documentation",
  });
  expect(
    resolveWebResearchIntent({
      text: "Expo documentation",
      searchOverride: true,
    }),
  ).toEqual({
    search: true,
    fetchPages: true,
    searchQuery: "Expo documentation",
  });
  expect(
    resolveWebResearchIntent({
      text: "Check web for Expo documentation",
      searchOverride: false,
    }),
  ).toEqual({
    search: false,
    fetchPages: false,
  });
  expect(
    resolveWebResearchIntent({
      text: "Check web for Expo documentation",
      searchOverride: false,
      fetchPagesEnabled: true,
    }),
  ).toEqual({ search: false, fetchPages: true });
});

it("keeps explicit offline requests offline even with a previous search selection", () => {
  for (const text of [
    "Don't use the web. Explain this locally.",
    "Do not search the internet for this question.",
    "Answer offline: https://docs.expo.dev/",
    "Please avoid web search and reason from the supplied text.",
  ])
    expect(
      resolveWebResearchIntent({
        text,
        searchEnabled: true,
        fetchPagesEnabled: true,
      }),
    ).toEqual({
      search: false,
      fetchPages: false,
    });
});

it("reads requested and standalone links without searching or needing a search API key", () => {
  for (const text of [
    "Summarize https://docs.expo.dev/",
    "Read this page: https://docs.expo.dev/",
    "Check https://docs.expo.dev/ for the setting.",
    "https://docs.expo.dev/",
  ])
    expect(resolveWebResearchIntent({ text })).toEqual({
      search: false,
      fetchPages: true,
    });
  expect(
    resolveWebResearchIntent({ text: "Do not read https://docs.expo.dev/" }),
  ).toEqual({
    search: false,
    fetchPages: false,
  });
  expect(
    resolveWebResearchIntent({
      text: "Example: `read https://docs.expo.dev/`",
    }),
  ).toEqual({
    search: false,
    fetchPages: false,
  });
});

const runRequest = (text: string): RunRequest => ({
  runId: "00000000-0000-7000-8000-000000000001",
  conversationId: "00000000-0000-7000-8000-000000000002",
  messageId: "00000000-0000-7000-8000-000000000003",
  providerConnectionId: "00000000-0000-7000-8000-000000000004",
  modelId: "local-coder",
  context: [
    { kind: "system", value: "Be useful." },
    { kind: "user", value: text },
  ],
  parameters: {},
  permittedTools: [],
  attachmentRefs: [],
  reasoning: false,
  json: false,
});
let toolId = 10;
const createId = () =>
  `00000000-0000-7000-8000-${String(toolId++).padStart(12, "0")}`;
const provider = (receive: (request: RunRequest) => void): ProviderPort => ({
  listModels: async () => ({ ok: true, value: ["local-coder"] }),
  getCapabilities: async () => ({ ok: true, value: { tools: "no" } }),
  async *startRun(request) {
    receive(request);
    for (const [sequence, payload] of [
      { type: "RunStarted" },
      { type: "TextDelta", text: "Evidence used." },
      { type: "RunCompleted" },
    ].entries())
      yield {
        ...payload,
        runId: request.runId,
        sequence,
        timestamp: new Date().toISOString(),
      } as RunEvent;
  },
});

it("runs requested search and page reading before a model without functions, preserving the exact user message", async () => {
  const text = "What do Expo context limits mean? (check web)";
  const intent = resolveWebResearchIntent({ text });
  const client = {
    search: vi.fn(async () => [
      {
        url: "https://docs.expo.dev/",
        title: "Expo documentation",
        text: "Search evidence.",
        kind: "search-snippet" as const,
      },
    ]),
    fetchPage: vi.fn(async () => ({
      url: "https://docs.expo.dev/",
      title: "Expo documentation",
      text: "Page evidence from documentation.",
      kind: "page-excerpt" as const,
    })),
  };
  const modelRequest = vi.fn();
  const wrapped = withWebResearch(provider(modelRequest), {
    client,
    text,
    ...intent,
    createId,
  });
  const events = [];
  for await (const event of wrapped.startRun(
    runRequest(text),
    new AbortController().signal,
  ))
    events.push(event);
  RunEventBatchSchema.parse(events);
  expect(client.search.mock.calls[0]?.[0]).toBe(
    "What do Expo context limits mean?",
  );
  expect(client.fetchPage.mock.calls[0]?.[0]).toBe("https://docs.expo.dev/");
  expect(modelRequest).toHaveBeenCalledOnce();
  const sent = modelRequest.mock.calls[0]![0] as RunRequest;
  expect(sent.context.at(-1)).toEqual({ kind: "user", value: text });
  expect(sent.context[1]?.value).toContain("Page evidence from documentation.");
  expect(
    events
      .filter((event) => event.type === "ToolCall")
      .map((event) => event.name),
  ).toEqual(["web_search", "web_fetch"]);
  expect(events.find((event) => event.type === "ToolCall")?.input).toEqual({
    query: "What do Expo context limits mean?",
  });
  expect(events.find((event) => event.type === "Source")?.url).toBe(
    "https://docs.expo.dev/",
  );
  expect(events.at(-1)?.type).toBe("RunCompleted");
});

it("asks for a topic instead of searching the literal check-web command in an empty chat", async () => {
  const text = "Check web";
  const intent = resolveWebResearchIntent({ text });
  expect(intent.searchQuery).toBe("");
  const fetcher = vi.fn(async () => new Response("Unexpected"));
  const modelRequest = vi.fn();
  const wrapped = withWebResearch(provider(modelRequest), {
    client: createWebResearchClient(fetcher),
    text,
    ...intent,
    createId,
  });
  const events = [];
  for await (const event of wrapped.startRun(
    runRequest(text),
    new AbortController().signal,
  ))
    events.push(event);
  expect(fetcher).not.toHaveBeenCalled();
  expect(modelRequest).not.toHaveBeenCalled();
  expect(events.at(-1)).toMatchObject({
    type: "RunFailed",
    error: { message: expect.stringMatching(/Write a search question/) },
  });
});

it("preserves complete local provider errors through the tool loop and web event resequencing", async () => {
  const text = "Check web for Expo documentation";
  const cause = new Error(
    `HTTP 400\nResponse body:\n${"x".repeat(12_000)}\nCOMPLETE-PROVIDER-END`,
  );
  const error = {
    code: "offline",
    message: "HTTP 400 bad request",
    recoverable: false,
  };
  retainLocalFailureCause(error, cause);
  const failing: ProviderPort = {
    ...provider(() => {}),
    async *startRun(request) {
      yield {
        type: "RunStarted",
        runId: request.runId,
        sequence: 0,
        timestamp: new Date().toISOString(),
      };
      yield {
        type: "RunFailed",
        runId: request.runId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        error,
      };
    },
  };
  const loop = new ToolLoopEngine({
    registry: new ToolRegistry(),
    createId,
  }).wrap(failing, () => ({
    globalEnabled: true,
    capabilities: { tools: "yes" },
  }));
  const wrapped = withWebResearch(loop, {
    text,
    search: true,
    fetchPages: false,
    createId,
    client: {
      search: async () => [
        {
          url: "https://docs.expo.dev/",
          title: "Expo documentation",
          text: "Documentation evidence.",
          kind: "search-snippet",
        },
      ],
      fetchPage: async () => {
        throw new Error("No page request expected");
      },
    },
  });
  const events: RunEvent[] = [];
  for await (const event of wrapped.startRun(
    runRequest(text),
    new AbortController().signal,
  ))
    events.push(event);
  RunEventBatchSchema.parse(events);
  const failure = events.at(-1);
  expect(failure).toMatchObject({ type: "RunFailed", error });
  if (failure?.type !== "RunFailed") throw new Error("Missing failure");
  expect(failure.error).not.toBe(error); // The tool loop schema projected it.
  expect(localFailureCause(failure.error)).toBe(cause);
  expect(JSON.stringify(events)).not.toContain("COMPLETE-PROVIDER-END");
});

it("bounds complete CJK evidence by UTF-8 bytes and characters, or stops before generation when no source fits", async () => {
  const url = `https://docs.expo.dev/${"long-citation-path-".repeat(5)}`;
  const text = `Read ${url}`;
  const title = "日本語の文書".repeat(6);
  const evidence = "日本語の説明🦉".repeat(1000);
  for (const [maxContextCharacters, maxContextBytes, succeeds] of [
    [4000, 900, true],
    [500, 900, true],
    [4000, 200, false],
    [4000, 0, false],
  ] as const) {
    const modelRequest = vi.fn();
    const wrapped = withWebResearch(provider(modelRequest), {
      text,
      search: false,
      fetchPages: true,
      maxContextCharacters,
      maxContextBytes,
      createId,
      client: {
        search: async () => {
          throw new Error("A direct read must not search");
        },
        fetchPage: async () => ({
          url,
          title,
          text: evidence,
          kind: "page-excerpt",
        }),
      },
    });
    const events: RunEvent[] = [];
    for await (const event of wrapped.startRun(
      runRequest(text),
      new AbortController().signal,
    ))
      events.push(event);
    RunEventBatchSchema.parse(events);
    if (succeeds) {
      expect(modelRequest).toHaveBeenCalledOnce();
      const sent = modelRequest.mock.calls[0]![0] as RunRequest;
      const material = String(sent.context[1]?.value);
      expect(material.length).toBeLessThanOrEqual(maxContextCharacters);
      expect(new TextEncoder().encode(material).byteLength).toBeLessThanOrEqual(
        maxContextBytes,
      );
      expect(material).toContain("Untrusted website content.");
      expect(material).toContain("Retrieved:");
      expect(material).toContain(title);
      expect(material).toContain(`URL: ${url}`);
      expect(material).toContain("日本語の説明🦉");
      expect(
        Array.from(material).some((character) =>
          /^[\uD800-\uDFFF]$/.test(character),
        ),
      ).toBe(false);
      expect(sent.context.at(-1)).toEqual({ kind: "user", value: text });
      expect(events.at(-1)?.type).toBe("RunCompleted");
    } else {
      expect(modelRequest).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({
        type: "RunFailed",
        error: {
          message: expect.stringContaining("context allowance is too small"),
        },
      });
    }
  }
});
