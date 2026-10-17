import { expect, it, vi } from "vitest";
import type { LlamaContext } from "llama.rn";
import type { ProviderPort } from "@locallab/contracts/ports";
import type { BlobStore } from "@locallab/storage-blobs";
import {
  RunEventBatchSchema,
  type RunEvent,
  type RunRequest,
} from "@locallab/contracts/run-events";
import { createGgufInferencePort } from "@locallab/gguf-ios";
import { ToolLoopEngine, ToolRegistry } from "@locallab/tools-engine";
import { createCurrentTimeTool } from "@locallab/tools-builtins";
import { createWebResearchTools } from "./web-research-tools";
import { resolveWebResearchPolicy } from "./web-research-settings";
import { createLocalChatPort } from "../../platform/local-chat-provider";

vi.mock("expo-file-system", () => ({
  File: class {},
  Paths: { document: "file:///private/" },
  FileMode: { ReadOnly: "r" },
}));

const id = "00000000-0000-7000-8000-000000000001";
const request = (): RunRequest => ({
  runId: id,
  conversationId: id,
  messageId: id,
  providerConnectionId: id,
  modelId: `blob:${id}`,
  context: [{ kind: "user", value: "Use your tools to answer." }],
  parameters: {},
  permittedTools: ["current_time", "web_search", "web_fetch"],
  attachmentRefs: [],
  reasoning: false,
  json: false,
});
const toolCall = (name: string, args: object) => ({
  content: "",
  tool_calls: [
    { type: "function", function: { name, arguments: JSON.stringify(args) } },
  ],
});

function nativeProvider(answer: (params: Record<string, unknown>) => object) {
  const completions: Record<string, unknown>[] = [];
  let released = 0;
  const inference = createGgufInferencePort({
    files: {
      async acquire() {
        return {
          uri: "file:///private/qwen.gguf",
          async release() {
            released++;
          },
        };
      },
    },
    runtime: {
      async initLlama() {
        return {
          parallel: {
            async completion(params: Record<string, unknown>) {
              completions.push(params);
              return {
                requestId: 1,
                promise: Promise.resolve(answer(params)),
                async stop() {},
              };
            },
          },
          async release() {
            released++;
          },
        } as unknown as LlamaContext;
      },
    },
  });
  const port: ProviderPort = {
    ...inference,
    listModels: async () => ({ ok: true, value: [] }),
    getCapabilities: async () => ({ ok: true, value: { tools: "yes" } }),
  };
  return { port, completions, released: () => released };
}

it("the iPhone adapter advertises tool support and admits automatic web research", async () => {
  const caps = await createLocalChatPort({} as BlobStore).getCapabilities(
    `blob:${id}`,
  );
  expect(caps.ok).toBe(true);
  if (!caps.ok) throw new Error("Missing capabilities");
  expect(caps.value.tools).toBe("yes");
  expect(
    resolveWebResearchPolicy({
      appWideMode: "auto",
      conversationOverride: null,
      capabilities: caps.value,
      text: "Search for NASA",
    }).automaticTools,
  ).toBe(true);
});

it("executes a native current_time call once, replays the result, and produces the follow-up answer", async () => {
  const time = createCurrentTimeTool({
    clock: () => Date.UTC(2026, 9, 16, 12),
    timeZone: "UTC",
  });
  const execute = vi.spyOn(time, "execute");
  const registry = new ToolRegistry();
  registry.register(time);
  const native = nativeProvider((params) => {
    const messages = params.messages as {
      role: string;
      content: string;
      tool_call_id?: string;
      tool_calls?: { id: string }[];
    }[];
    const result = messages.find((message) => message.role === "tool");
    if (!result) return toolCall("current_time", {});
    const call = messages.find((message) => message.role === "assistant")
      ?.tool_calls?.[0];
    expect(result.tool_call_id).toBe(call?.id);
    expect(result.content).toContain("2026-10-16T12:00:00.000Z");
    return { content: "It is noon UTC.", tool_calls: [] };
  });
  const loop = new ToolLoopEngine({ registry }).wrap(native.port, () => ({
    globalEnabled: true,
    capabilities: { tools: "yes" },
  }));
  const events: RunEvent[] = [];
  for await (const event of loop.startRun(
    request(),
    new AbortController().signal,
  ))
    events.push(event);
  RunEventBatchSchema.parse(events);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(events.filter((event) => event.type === "ToolCall")).toHaveLength(1);
  expect(events.filter((event) => event.type === "ToolResult")).toHaveLength(1);
  expect(
    events
      .filter((event) => event.type === "TextDelta")
      .map((event) => event.text)
      .join(""),
  ).toBe("It is noon UTC.");
  expect(events.at(-1)?.type).toBe("RunCompleted");
  expect(native.completions).toHaveLength(2);
  expect(native.released()).toBe(4);
});

it("runs native search, fetches its result, and passes the page content back into the local model", async () => {
  const url = "https://www.nasa.gov/mission/artemis-ii/";
  const client = {
    search: vi.fn(async () => [
      {
        url,
        title: "NASA Artemis II",
        text: "NASA search result",
        kind: "search-snippet" as const,
      },
    ]),
    fetchPage: vi.fn(async () => ({
      url,
      title: "NASA Artemis II",
      text: "The page says the mission lasts ten days.",
      kind: "page-excerpt" as const,
    })),
  };
  const registry = new ToolRegistry();
  for (const tool of createWebResearchTools(client)) registry.register(tool);
  const native = nativeProvider((params) => {
    const messages = params.messages as {
      role: string;
      content: string;
      name?: string;
    }[];
    const results = messages.filter((message) => message.role === "tool");
    if (!results.length)
      return toolCall("web_search", { query: "NASA Artemis II" });
    if (results.length === 1) {
      expect(results[0]?.content).toContain(url);
      return toolCall("web_fetch", { url });
    }
    expect(results[1]?.content).toContain("mission lasts ten days");
    return { content: "NASA says the mission lasts ten days.", tool_calls: [] };
  });
  const loop = new ToolLoopEngine({ registry }).wrap(native.port, () => ({
    globalEnabled: true,
    capabilities: { tools: "yes" },
  }));
  const events: RunEvent[] = [];
  for await (const event of loop.startRun(
    request(),
    new AbortController().signal,
  ))
    events.push(event);
  RunEventBatchSchema.parse(events);
  expect(client.search).toHaveBeenCalledTimes(1);
  expect(client.fetchPage).toHaveBeenCalledTimes(1);
  expect(
    events
      .filter((event) => event.type === "ToolCall")
      .map((event) => event.name),
  ).toEqual(["web_search", "web_fetch"]);
  expect(events.filter((event) => event.type === "ToolResult")).toHaveLength(2);
  expect(events.at(-1)?.type).toBe("RunCompleted");
  expect(native.released()).toBe(6);
});

it("turning tools off removes definitions and prevents execution in a downloaded-model turn", async () => {
  const time = createCurrentTimeTool();
  const execute = vi.spyOn(time, "execute");
  const registry = new ToolRegistry();
  registry.register(time);
  const native = nativeProvider((params) => {
    expect(params.tools).toBeUndefined();
    return { content: "Tools are off.", tool_calls: [] };
  });
  const loop = new ToolLoopEngine({ registry }).wrap(native.port, () => ({
    globalEnabled: false,
    capabilities: { tools: "yes" },
  }));
  const events: RunEvent[] = [];
  for await (const event of loop.startRun(
    request(),
    new AbortController().signal,
  ))
    events.push(event);
  expect(execute).not.toHaveBeenCalled();
  expect(events.at(-1)?.type).toBe("RunCompleted");
});
