import { expect, it } from "vitest";
import {
  RunEventBatchSchema,
  type RunEvent,
  type RunRequest,
} from "@locallab/contracts/run-events";
import type { ProviderPort } from "@locallab/contracts/ports";
import { WEB_FETCH_TOOL } from "./web-research";
import { WEB_SEARCH_TOOL } from "./web-research-tools";
import { withWebResearchToolSources } from "./web-research-tool-sources";

const request: RunRequest = {
  runId: "00000000-0000-7000-8000-000000000041",
  conversationId: "00000000-0000-7000-8000-000000000042",
  messageId: "00000000-0000-7000-8000-000000000043",
  providerConnectionId: "00000000-0000-7000-8000-000000000044",
  modelId: "tool-model",
  context: [{ kind: "user", value: "What changed this week?" }],
  parameters: {},
  permittedTools: [WEB_SEARCH_TOOL, WEB_FETCH_TOOL],
  attachmentRefs: [],
  reasoning: false,
  json: false,
};

function fakeProvider(payloads: Omit<RunEvent, "runId" | "sequence">[]) {
  return {
    listModels: async () => ({ ok: true, value: ["tool-model"] }),
    getCapabilities: async () => ({ ok: true, value: { tools: "yes" } }),
    async *startRun(input: RunRequest) {
      for (const [sequence, payload] of payloads.entries())
        yield { ...payload, runId: input.runId, sequence } as RunEvent;
    },
  } satisfies ProviderPort;
}

async function collect(provider: ProviderPort, run = request) {
  const events: RunEvent[] = [];
  for await (const event of provider.startRun(run, new AbortController().signal))
    events.push(event);
  RunEventBatchSchema.parse(events);
  return events;
}

const sources = [
  {
    url: "https://example.com/a",
    title: "Example A",
    text: "snippet",
    kind: "search-snippet",
  },
  {
    url: "https://example.com/b",
    text: "no title",
    kind: "search-snippet",
  },
];

it("derives deduplicated Source events after web tool results", async () => {
  const provider = withWebResearchToolSources(
    fakeProvider([
      { type: "RunStarted" },
      {
        type: "ToolCall",
        invocationId: "00000000-0000-7000-8000-000000000051",
        name: WEB_SEARCH_TOOL,
        input: { query: "this week" },
      },
      {
        type: "ToolResult",
        invocationId: "00000000-0000-7000-8000-000000000051",
        output: { results: sources },
      },
      {
        type: "ToolCall",
        invocationId: "00000000-0000-7000-8000-000000000052",
        name: WEB_FETCH_TOOL,
        input: { url: "https://example.com/a" },
      },
      {
        type: "ToolResult",
        invocationId: "00000000-0000-7000-8000-000000000052",
        output: { source: { ...sources[0]!, kind: "page-excerpt" } },
      },
      { type: "TextDelta", text: "Here is what changed." },
      { type: "RunCompleted", finishReason: "stop" },
    ]),
  );
  const events = await collect(provider);
  const webEvents = events.filter(
    (event) =>
      event.type === "Source" ||
      (event.type !== "ToolCall" && event.type !== "ToolResult"),
  );
  expect(webEvents.map((event) => event.type)).toEqual([
    "RunStarted",
    "Source",
    "Source",
    "TextDelta",
    "RunCompleted",
  ]);
  const emitted = events.filter((event) => event.type === "Source");
  expect(
    emitted.flatMap((event) =>
      event.type === "Source" ? [event.url] : [],
    ),
  ).toEqual(["https://example.com/a", "https://example.com/b"]);
  expect(events.filter((event) => event.type === "RunCompleted")).toHaveLength(
    1,
  );
  const sequences = events.map((event) => event.sequence);
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  expect(new Set(sequences).size).toBe(sequences.length);
});

it("ignores non-web tool results and invalid source shapes", async () => {
  const provider = withWebResearchToolSources(
    fakeProvider([
      { type: "RunStarted" },
      {
        type: "ToolResult",
        invocationId: "00000000-0000-7000-8000-000000000061",
        output: { results: sources },
      },
      {
        type: "ToolCall",
        invocationId: "00000000-0000-7000-8000-000000000062",
        name: WEB_SEARCH_TOOL,
        input: { query: "q" },
      },
      {
        type: "ToolResult",
        invocationId: "00000000-0000-7000-8000-000000000062",
        output: {
          results: [
            { url: "not-a-url", title: "bad" },
            { url: "ftp://example.com/x", title: "bad protocol" },
            { title: "missing url" },
          ],
        },
      },
      { type: "RunCompleted", finishReason: "stop" },
    ]),
  );
  const events = await collect(provider);
  expect(events.some((event) => event.type === "Source")).toBe(false);
});

it("re-emits saved sources for a replayed run", async () => {
  const provider = withWebResearchToolSources(
    fakeProvider([
      { type: "RunStarted" },
      { type: "TextDelta", text: "Recalled answer." },
      { type: "RunCompleted", finishReason: "stop" },
    ]),
  );
  const events = await collect(provider, {
    ...request,
    context: [
      ...request.context,
      {
        kind: "tool",
        value: {
          role: "tool",
          tool_call_id: "00000000-0000-7000-8000-000000000051",
          name: WEB_SEARCH_TOOL,
          content: JSON.stringify({ results: sources }),
        },
      },
      {
        kind: "tool",
        value: {
          role: "tool",
          tool_call_id: "00000000-0000-7000-8000-000000000061",
          name: "workspace_read_file",
          content: JSON.stringify({ results: sources }),
        },
      },
    ],
  });
  const emitted = events.filter((event) => event.type === "Source");
  expect(emitted).toHaveLength(2);
  expect(events[0]?.type).toBe("Source");
});

it("keeps exactly one terminal event after cancellation", async () => {
  const provider = withWebResearchToolSources(
    fakeProvider([
      { type: "RunStarted" },
      {
        type: "ToolCall",
        invocationId: "00000000-0000-7000-8000-000000000071",
        name: WEB_SEARCH_TOOL,
        input: { query: "q" },
      },
      { type: "RunCanceled", reason: "canceled" },
      { type: "TextDelta", text: "must not surface after the terminal" },
    ]),
  );
  const events = await collect(provider);
  expect(events.at(-1)?.type).toBe("RunCanceled");
  expect(events.filter((event) => event.type === "RunCanceled")).toHaveLength(
    1,
  );
  expect(events.some((event) => event.type === "TextDelta" && event.sequence > 1)).toBe(
    false,
  );
});

it("preserves participant identity on replayed events", async () => {
  const provider = withWebResearchToolSources({
    listModels: async () => ({ ok: true, value: ["tool-model"] }),
    getCapabilities: async () => ({ ok: true, value: { tools: "yes" } }),
    async *startRun(input: RunRequest) {
      yield {
        type: "TextDelta",
        text: "Arena turn",
        runId: input.runId,
        sequence: 0,
        participantId: "00000000-0000-7000-8000-000000000091",
      } as RunEvent;
      yield {
        type: "RunCompleted",
        finishReason: "stop",
        runId: input.runId,
        sequence: 1,
        participantId: "00000000-0000-7000-8000-000000000091",
      } as RunEvent;
    },
  } satisfies ProviderPort);
  const events = await collect(provider);
  const delta = events.find((event) => event.type === "TextDelta");
  expect(delta).toMatchObject({
    participantId: "00000000-0000-7000-8000-000000000091",
  });
});
