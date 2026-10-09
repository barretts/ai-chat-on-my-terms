import { describe, expect, it } from "vitest";
import {
  RunEventBatchSchema,
  type RunRequest,
} from "@locallab/contracts/run-events";
import { createHttpTransport } from "@locallab/network-http";
import {
  createCompatibleLocalProvider,
  createCustomCompatiblePreset,
} from "../src/index";

const id = "0193f2a0-1234-7abc-8def-123456789abd";
const connection = createCustomCompatiblePreset("http://127.0.0.1:35961");
const request: RunRequest = {
  runId: id,
  conversationId: id,
  messageId: id,
  providerConnectionId: id,
  modelId: "qwen3.8-27b-sm89",
  parameters: {},
  attachmentRefs: [],
  reasoning: false,
  json: false,
  permittedTools: ["workspace_write_file"],
  context: [
    { kind: "user", value: "Save a Markdown note with XML and Unicode." },
    {
      kind: "tool-definitions",
      value: [
        {
          name: "workspace_write_file",
          description: "Save a text artifact",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
        { name: "unpermitted", parameters: { type: "object" } },
      ],
    },
  ],
};
const frames = (chunks: unknown[]) =>
  chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
  "data: [DONE]\n\n";
const collect = async (
  stream: ReturnType<
    ReturnType<typeof createCompatibleLocalProvider>["startRun"]
  >,
) => {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
};

describe("compatible local function tools", () => {
  it.each([undefined, false, true])(
    "maps reasoning only for explicitly verified NInfer thinking control %j",
    async (ninferThinkingControl) => {
      const bodies: Record<string, unknown>[] = [];
      const provider = createCompatibleLocalProvider({
        ...(ninferThinkingControl === undefined
          ? {}
          : { ninferThinkingControl }),
        resolveConnection: async () => connection,
        transport: createHttpTransport({
          policy: {
            authorizedOrigins: [connection.origin],
            cleartextLanOrigins: [connection.origin],
          },
          fetch: async (_url, init) => {
            bodies.push(JSON.parse(String(init?.body)));
            return new Response(
              frames([
                {
                  choices: [
                    { delta: { content: "done" }, finish_reason: "stop" },
                  ],
                },
              ]),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        }),
      });
      for (const reasoning of [false, true]) {
        const events = await collect(
          provider.startRun(
            { ...request, reasoning },
            new AbortController().signal,
          ),
        );
        expect(events.at(-1)?.type).toBe("RunCompleted");
      }
      expect(
        await provider.getCapabilities(connection, request.modelId),
      ).toMatchObject({
        value: {
          reasoning: ninferThinkingControl === true ? "yes" : "unknown",
        },
      });
      expect(bodies.map((body) => body.enable_thinking)).toEqual(
        ninferThinkingControl === true ? [false, true] : [undefined, undefined],
      );
      if (ninferThinkingControl !== true)
        expect(
          bodies.every((body) => !Object.hasOwn(body, "enable_thinking")),
        ).toBe(true);
    },
  );

  it("gives repeated server call IDs distinct UUIDs across child rounds in the same millisecond", async () => {
    const provider = createCompatibleLocalProvider({
      resolveConnection: async () => connection,
      transport: createHttpTransport({
        policy: {
          authorizedOrigins: [connection.origin],
          cleartextLanOrigins: [connection.origin],
        },
        fetch: async () =>
          new Response(
            frames([
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_0",
                          function: {
                            name: "workspace_write_file",
                            arguments: '{"path":"note.md","content":"fixture"}',
                          },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              },
            ]),
            { headers: { "content-type": "text/event-stream" } },
          ),
      }),
    });
    const ids: string[] = [];
    for (let round = 1; round <= 128; round++) {
      const events = await collect(
        provider.startRun(
          {
            ...request,
            runId: `0193f2a0-1234-7abc-8def-${round.toString(16).padStart(12, "0")}`,
          },
          new AbortController().signal,
        ),
      );
      expect(RunEventBatchSchema.safeParse(events).success).toBe(true);
      const call = events.find((event) => event.type === "ToolCall");
      if (!call || call.type !== "ToolCall") throw new Error("Missing call");
      ids.push(call.invocationId);
    }
    expect(new Set(ids).size).toBe(128);
  });

  it("advertises only permitted schemas and replays a streamed call/result before the final answer", async () => {
    const bodies: Record<string, unknown>[] = [];
    const argumentsValue = {
      path: "note.md",
      content: '# Note\n<xml value="yes">café 🌙</xml>\n',
    };
    const encoded = JSON.stringify(argumentsValue);
    const provider = createCompatibleLocalProvider({
      toolsEnabled: true,
      resolveConnection: async () => connection,
      transport: createHttpTransport({
        policy: {
          authorizedOrigins: [connection.origin],
          cleartextLanOrigins: [connection.origin],
        },
        fetch: async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response(
            frames(
              bodies.length === 1
                ? [
                    {
                      choices: [
                        {
                          delta: {
                            tool_calls: [
                              {
                                index: 0,
                                id: "call_native",
                                type: "function",
                                function: {
                                  name: "workspace_",
                                  arguments: encoded.slice(0, 25),
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                    {
                      choices: [
                        {
                          delta: {
                            tool_calls: [
                              {
                                index: 0,
                                function: {
                                  name: "write_file",
                                  arguments: encoded.slice(25),
                                },
                              },
                            ],
                          },
                          finish_reason: "tool_calls",
                        },
                      ],
                    },
                  ]
                : [
                    {
                      choices: [
                        {
                          delta: { content: "Saved note.md." },
                          finish_reason: "stop",
                        },
                      ],
                    },
                  ],
            ),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      }),
    });
    const first = await collect(
      provider.startRun(request, new AbortController().signal),
    );
    expect(RunEventBatchSchema.safeParse(first).success).toBe(true);
    const call = first.find((event) => event.type === "ToolCall");
    expect(call).toMatchObject({
      name: "workspace_write_file",
      input: argumentsValue,
    });
    expect(bodies[0]?.tools).toHaveLength(1);
    expect(bodies[0]?.tool_choice).toBe("auto");
    if (!call || call.type !== "ToolCall")
      throw new Error("Missing function call");
    const second = await collect(
      provider.startRun(
        {
          ...request,
          context: [
            ...request.context,
            {
              kind: "assistant",
              value: {
                content: "",
                tool_calls: [
                  {
                    id: call.invocationId,
                    type: "function",
                    function: { name: call.name, arguments: call.input },
                  },
                ],
              },
            },
            {
              kind: "tool",
              value: {
                tool_call_id: call.invocationId,
                content: JSON.stringify({ path: "note.md", saved: true }),
              },
            },
          ],
        },
        new AbortController().signal,
      ),
    );
    expect(second.at(-1)).toMatchObject({
      type: "RunCompleted",
      finishReason: "stop",
    });
    const messages = bodies[1]?.messages as Record<string, unknown>[];
    expect(messages.at(-2)).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: call.invocationId,
          type: "function",
          function: { name: call.name, arguments: encoded },
        },
      ],
    });
    expect(messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: call.invocationId,
      content: '{"path":"note.md","saved":true}',
    });
    expect(
      await provider.getCapabilities(connection, request.modelId),
    ).toMatchObject({ value: { tools: "yes" } });
  });

  it.each(["[]", "{broken", ""])(
    "rejects incomplete or non-object call arguments %j",
    async (argumentsValue) => {
      const provider = createCompatibleLocalProvider({
        resolveConnection: async () => connection,
        transport: createHttpTransport({
          policy: {
            authorizedOrigins: [connection.origin],
            cleartextLanOrigins: [connection.origin],
          },
          fetch: async () =>
            new Response(
              frames([
                {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            function: {
                              name: "workspace_write_file",
                              arguments: argumentsValue,
                            },
                          },
                        ],
                      },
                      finish_reason: "tool_calls",
                    },
                  ],
                },
              ]),
              { headers: { "content-type": "text/event-stream" } },
            ),
        }),
      });
      const events = await collect(
        provider.startRun(request, new AbortController().signal),
      );
      expect(events.some((event) => event.type === "ToolCall")).toBe(false);
      expect(events.at(-1)).toMatchObject({
        type: "RunFailed",
        error: { code: "malformed" },
      });
    },
  );
});
