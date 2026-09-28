import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import type { ProviderPort } from "@locallab/contracts/ports";
import {
  RunEventBatchSchema,
  type RunEvent,
  type RunRequest,
} from "@locallab/contracts/run-events";
import { createHttpTransport, type FetchLike } from "@locallab/network-http";
import { createOllamaChatProvider } from "@locallab/provider-ollama-chat";
import {
  SQLiteToolInvocationStore,
  ToolLoopEngine,
  ToolRegistry,
  type RegisteredTool,
  type ToolLoopClock,
  type ToolRunPolicy,
} from "../src/index";
import { sharedMobileDatabase } from "../../../../apps/mobile/platform/database";

const id = (n: number) =>
  `0193f2a0-1234-7abc-8def-${n.toString(16).padStart(12, "0")}`;
const timestamp = "2026-09-26T12:00:00.000Z";
const request: RunRequest = {
  runId: id(1),
  conversationId: id(2),
  messageId: id(3),
  providerConnectionId: id(4),
  modelId: "fixture-model",
  context: [{ kind: "user", value: "What is the weather?" }],
  parameters: { temperature: 0.2 },
  permittedTools: ["weather"],
  attachmentRefs: [],
  reasoning: false,
  json: false,
};
const policy: ToolRunPolicy = {
  globalEnabled: true,
  capabilities: { tools: "yes" },
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function adapter(database: DatabaseSync): SQLiteDatabasePort {
  return {
    execAsync: async (sql) => database.exec(sql),
    runAsync: async (sql, ...params: SqliteBindValue[]) =>
      database.prepare(sql).run(...params),
    getFirstAsync: async <T>(sql: string, ...params: SqliteBindValue[]) =>
      (database.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T>(sql: string, ...params: SqliteBindValue[]) =>
      database.prepare(sql).all(...params) as T[],
    withTransactionAsync: async (work) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        await work();
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
async function durable() {
  const dir = await mkdtemp(join(tmpdir(), "locallab-tools-"));
  const path = join(dir, "tools.sqlite");
  let database = new DatabaseSync(path);
  cleanup.push(async () => {
    database.close();
    await rm(dir, { recursive: true, force: true });
  });
  let store = new SQLiteToolInvocationStore(
    adapter(database),
    id(20),
    () => timestamp,
  );
  await store.initialize();
  return {
    get store() {
      return store;
    },
    async reopen() {
      database.close();
      database = new DatabaseSync(path);
      store = new SQLiteToolInvocationStore(
        adapter(database),
        id(20),
        () => timestamp,
      );
      await store.initialize();
      return store;
    },
  };
}
function registry(
  execute: RegisteredTool["execute"] = async () => ({
    ok: true,
    value: { temperature: 12 },
  }),
) {
  const tools = new ToolRegistry();
  tools.register({
    name: "weather",
    serverId: id(10),
    description: "Read current weather",
    enabled: true,
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
    parseInput(value) {
      if (
        !value ||
        typeof value !== "object" ||
        typeof (value as { city?: unknown }).city !== "string"
      )
        throw new Error("bad arguments");
      return { city: (value as { city: string }).city };
    },
    execute,
  });
  return tools;
}
async function collect(source: AsyncIterable<RunEvent>) {
  const events: RunEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}
function fakeProvider(
  round: (request: RunRequest, round: number) => Array<Record<string, unknown>>,
) {
  const seen: RunRequest[] = [];
  return {
    seen,
    port: {
      async *startRun(child: RunRequest) {
        seen.push(child);
        for (const [sequence, event] of round(child, seen.length).entries())
          yield {
            ...event,
            runId: child.runId,
            sequence,
            timestamp,
          } as RunEvent;
      },
    },
  };
}
function calls(child: RunRequest) {
  return [
    { type: "RunStarted" },
    { type: "TextDelta", text: "Checking. " },
    {
      type: "ToolCall",
      invocationId: child.runId,
      name: "weather",
      input: { city: "Oslo" },
    },
    { type: "RunCompleted" },
  ];
}
function engine(
  tools: ToolRegistry,
  extra: Partial<ConstructorParameters<typeof ToolLoopEngine>[0]> = {},
) {
  let next = 100;
  return new ToolLoopEngine({
    registry: tools,
    createId: () => id(next++),
    ...extra,
  });
}
function terminal(events: RunEvent[]) {
  return events.filter((event) =>
    ["RunCompleted", "RunFailed", "RunCanceled"].includes(event.type),
  );
}

test("real Ollama HTTP adapter executes and durably replays a registered tool with exact binding", async () => {
  const disk = await durable();
  const bodies: Array<Record<string, any>> = [],
    connections: string[] = [],
    executions: unknown[] = [];
  const fetch: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const frames =
      bodies.length === 1
        ? [
            { message: { content: "Checking. " } },
            {
              message: {
                tool_calls: [
                  {
                    function: { name: "weather", arguments: { city: "Oslo" } },
                  },
                ],
              },
            },
            { done: true },
          ]
        : [{ message: { content: "It is 12 degrees." } }, { done: true }];
    return new Response(
      frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n",
      { headers: { "content-type": "application/x-ndjson" } },
    );
  };
  const port = createOllamaChatProvider({
    transport: createHttpTransport({
      fetch,
      policy: {
        authorizedOrigins: ["http://127.0.0.1:11434"],
        cleartextLanOrigins: ["http://127.0.0.1:11434"],
      },
    }),
    resolveConnection: async (connectionId) => {
      connections.push(connectionId);
      return { baseUrl: "http://127.0.0.1:11434" };
    },
  });
  const tools = registry(async (input, context) => {
    executions.push({ input, context });
    return { ok: true, value: { temperature: 12 } };
  });
  const original = JSON.stringify(request);
  const events = await collect(
    engine(tools, { store: disk.store }).startRun(
      request,
      port,
      { ...policy, participantId: id(9) },
      new AbortController().signal,
    ),
  );
  expect(terminal(events).map((event) => event.type)).toEqual(["RunCompleted"]);
  expect(RunEventBatchSchema.safeParse(events).success).toBe(true);
  expect(
    events.every(
      (event) => event.runId === request.runId && event.participantId === id(9),
    ),
  ).toBe(true);
  expect(JSON.stringify(request)).toBe(original);
  expect(connections).toEqual([
    request.providerConnectionId,
    request.providerConnectionId,
  ]);
  expect(bodies.every((body) => body.model === request.modelId)).toBe(true);
  expect(bodies[0]?.tools.map((tool: any) => tool.function.name)).toEqual([
    "weather",
  ]);
  expect(bodies[0]?.messages).toEqual([
    { role: "user", content: "What is the weather?" },
  ]);
  expect(bodies[1]?.messages.at(-2).tool_calls[0].function.arguments).toEqual({
    city: "Oslo",
  });
  expect(bodies[1]?.messages.at(-1)).toMatchObject({
    role: "tool",
    name: "weather",
    content: '{"temperature":12}',
  });
  expect(executions).toHaveLength(1);
  const saved = (await disk.store.list(request.runId))[0]!;
  expect(saved).toMatchObject({
    runId: request.runId,
    conversationId: request.conversationId,
    participantId: id(9),
    serverId: id(10),
    state: "completed",
    output: { temperature: 12 },
  });
  expect((await (await disk.reopen()).get(saved.id))?.revision).toEqual(
    saved.revision,
  );
});

test("unknown or denied capabilities strip injected schemas and block unpermitted dispatch", async () => {
  let executions = 0;
  for (const capability of ["unknown", "no"] as const) {
    const tools = registry(async () => {
      executions++;
      return { ok: true, value: null };
    });
    const provider = fakeProvider(calls);
    const events = await collect(
      engine(tools).startRun(
        {
          ...request,
          parameters: { tools: [{ injected: true }], function_call: "weather" },
          context: [
            ...request.context,
            { kind: "tool-definitions", value: [{ name: "injected" }] },
          ],
        },
        provider.port,
        { ...policy, capabilities: { tools: capability } },
        new AbortController().signal,
      ),
    );
    expect(provider.seen[0]?.parameters).toEqual({});
    expect(provider.seen[0]?.context).toEqual(request.context);
    expect(provider.seen[0]?.permittedTools).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: "RunFailed",
      error: { code: "permission" },
    });
  }
  expect(executions).toBe(0);
});

test("participant and chat overrides resolve once and registry edits affect the next run", async () => {
  const tools = registry();
  expect(
    tools.snapshot({ ...policy, globalEnabled: false, chatEnabled: true }, [
      "weather",
    ]),
  ).toHaveLength(1);
  expect(
    tools.snapshot(
      { ...policy, chatEnabled: true, participantEnabled: false },
      ["weather"],
    ),
  ).toHaveLength(0);
  expect(
    tools.snapshot(
      { ...policy, chatEnabled: false, participantEnabled: true },
      ["weather"],
    ),
  ).toHaveLength(1);
  const provider = fakeProvider((child, round) => {
    if (round === 1) {
      tools.setEnabled("weather", false);
      return calls(child);
    }
    return [
      { type: "RunStarted" },
      { type: "TextDelta", text: "Finished" },
      { type: "RunCompleted" },
    ];
  });
  const events = await collect(
    engine(tools).startRun(
      request,
      provider.port,
      policy,
      new AbortController().signal,
    ),
  );
  expect(events.at(-1)?.type).toBe("RunCompleted");
  expect(provider.seen[1]?.permittedTools).toEqual(["weather"]);
  expect(tools.snapshot(policy, ["weather"])).toEqual([]);
});

test("default eight rounds stop a looping provider; unlimited rounds retain the call budget", async () => {
  const provider = fakeProvider(calls);
  const events = await collect(
    engine(registry()).startRun(
      request,
      provider.port,
      policy,
      new AbortController().signal,
    ),
  );
  expect(provider.seen).toHaveLength(8);
  expect(events.at(-1)).toMatchObject({
    type: "RunFailed",
    error: { code: "quota" },
  });
  const unlimited = fakeProvider(calls);
  const capped = await collect(
    engine(registry()).startRun(
      request,
      unlimited.port,
      { ...policy, roundLimit: null, maxToolCalls: 10 },
      new AbortController().signal,
    ),
  );
  expect(unlimited.seen).toHaveLength(11);
  expect(capped.filter((event) => event.type === "ToolResult")).toHaveLength(
    10,
  );
  expect(capped.at(-1)).toMatchObject({
    type: "RunFailed",
    error: { code: "quota" },
  });
});

test("canceling an in-flight executor persists cancellation and keeps earlier text", async () => {
  const disk = await durable(),
    parent = new AbortController();
  let toolSignal: AbortSignal | undefined;
  const tools = registry(async (_input, context) => {
    toolSignal = context.signal;
    parent.abort();
    return new Promise(() => {});
  });
  const provider = fakeProvider(calls);
  const events = await collect(
    engine(tools, { store: disk.store }).startRun(
      request,
      provider.port,
      policy,
      parent.signal,
    ),
  );
  expect(events.find((event) => event.type === "TextDelta")).toMatchObject({
    text: "Checking. ",
  });
  expect(terminal(events).map((event) => event.type)).toEqual(["RunCanceled"]);
  expect(toolSignal?.aborted).toBe(true);
  expect(provider.seen).toHaveLength(1);
  expect((await disk.store.list())[0]?.state).toBe("canceled");
});

test("deadline settles a noncooperative provider without waiting for its next event", async () => {
  let expire!: () => void,
    stopped = false;
  const clock: ToolLoopClock = {
    now: () => 0,
    timestamp: () => timestamp,
    schedule: (_ms, callback) => {
      expire = callback;
      return () => {
        stopped = true;
      };
    },
  };
  const provider = {
    startRun: () => ({
      [Symbol.asyncIterator]() {
        return { next: () => new Promise<IteratorResult<RunEvent>>(() => {}) };
      },
    }),
  };
  const iterator = engine(registry(), { clock })
    .startRun(request, provider, policy, new AbortController().signal)
    [Symbol.asyncIterator]();
  expect((await iterator.next()).value.type).toBe("RunStarted");
  const next = iterator.next();
  expire();
  expect((await next).value).toMatchObject({
    type: "RunFailed",
    error: { code: "timeout" },
  });
  expect((await iterator.next()).done).toBe(true);
  expect(stopped).toBe(true);
});

test("invalid tool input never dispatches; executor and result failures persist safe messages", async () => {
  const disk = await durable();
  let executions = 0;
  const invalid = fakeProvider((child) =>
    calls(child).map((event) =>
      event.type === "ToolCall" ? { ...event, input: { city: 3 } } : event,
    ),
  );
  const bad = await collect(
    engine(
      registry(async () => {
        executions++;
        return { ok: true, value: null };
      }),
    ).startRun(request, invalid.port, policy, new AbortController().signal),
  );
  expect(executions).toBe(0);
  expect(bad.at(-1)).toMatchObject({
    type: "RunFailed",
    error: { code: "malformed" },
  });
  const secret = "Bearer sk-secret-must-not-be-saved";
  const provider = fakeProvider((child, round) =>
    round === 1 ? calls(child) : [{ type: "RunCompleted" }],
  );
  await collect(
    engine(
      registry(async () => {
        throw new Error(secret);
      }),
      { store: disk.store },
    ).startRun(request, provider.port, policy, new AbortController().signal),
  );
  expect(JSON.stringify(await disk.store.list())).not.toContain(secret);
  expect((await disk.store.list())[0]).toMatchObject({
    state: "failed",
    output: { error: { code: "tool-error" } },
  });
  const large = fakeProvider((child, round) =>
    round === 1 ? calls(child) : [{ type: "RunCompleted" }],
  );
  const events = await collect(
    engine(
      registry(async () => ({ ok: true, value: "x".repeat(300) })),
    ).startRun(
      request,
      large.port,
      { ...policy, maxResultBytes: 100 },
      new AbortController().signal,
    ),
  );
  expect(events.find((event) => event.type === "ToolResult")).toMatchObject({
    output: { error: { code: "quota" } },
  });
});

test("SQLite reopen recovers unfinished work and preserves completed invocation identity", async () => {
  const disk = await durable();
  const binding = {
    id: id(40),
    runId: request.runId,
    conversationId: request.conversationId,
    serverId: id(10),
    toolName: "weather",
    input: { city: "Oslo" },
  };
  await disk.store.begin(binding);
  await disk.store.claimExecution(binding.id);
  const reopened = await disk.reopen();
  expect(await reopened.get(binding.id)).toMatchObject({
    state: "failed",
    output: { error: { code: "interrupted" } },
  });
  const completed = { ...binding, id: id(41) };
  await reopened.begin(completed);
  const saved = await reopened.finish(completed.id, "completed", {
    temperature: 12,
  });
  expect(await reopened.begin(completed)).toEqual(saved);
  expect(await reopened.finish(completed.id, "failed", null)).toEqual(saved);
  await expect(
    reopened.begin({ ...completed, input: { city: "Paris" } }),
  ).rejects.toThrow("binding");
});

test("invalid provider sequence fails after retaining earlier partial text", async () => {
  const provider = {
    async *startRun(child: RunRequest) {
      yield {
        type: "TextDelta",
        text: "partial",
        runId: child.runId,
        sequence: 1,
        timestamp,
      } as RunEvent;
      yield {
        type: "RunCompleted",
        runId: child.runId,
        sequence: 0,
        timestamp,
      } as RunEvent;
    },
  };
  const events = await collect(
    engine(registry()).startRun(
      request,
      provider,
      policy,
      new AbortController().signal,
    ),
  );
  expect(events[1]).toMatchObject({ type: "TextDelta", text: "partial" });
  expect(events.at(-1)).toMatchObject({
    type: "RunFailed",
    error: { code: "malformed" },
  });
  expect(RunEventBatchSchema.safeParse(events).success).toBe(true);
});

test("wrapper preserves class provider methods and disposal receiver", async () => {
  class Provider implements ProviderPort {
    private readonly model = request.modelId;
    async listModels() {
      return { ok: true as const, value: [this.model] };
    }
    async getCapabilities() {
      return { ok: true as const, value: { tools: "yes" as const } };
    }
    async *startRun(child: RunRequest) {
      yield {
        type: "RunCompleted",
        runId: child.runId,
        sequence: 0,
        timestamp,
      } as RunEvent;
    }
    dispose() {
      this.listModels();
    }
  }
  const wrapped = engine(registry()).wrap(new Provider(), () => policy);
  expect(await wrapped.listModels(null)).toEqual({
    ok: true,
    value: [request.modelId],
  });
  expect(await wrapped.getCapabilities(null, request.modelId)).toMatchObject({
    value: { tools: "yes" },
  });
  expect(
    (await collect(wrapped.startRun(request, new AbortController().signal))).at(
      -1,
    )?.type,
  ).toBe("RunCompleted");
  await wrapped.dispose?.();
});

test("closing after RunStarted clears the deadline before starting a provider", async () => {
  let stopped = false;
  const clock: ToolLoopClock = {
    now: () => 0,
    timestamp: () => timestamp,
    schedule: () => () => {
      stopped = true;
    },
  };
  const provider = fakeProvider(() => [{ type: "RunCompleted" }]);
  const iterator = engine(registry(), { clock })
    .startRun(request, provider.port, policy, new AbortController().signal)
    [Symbol.asyncIterator]();
  expect((await iterator.next()).value.type).toBe("RunStarted");
  await iterator.return?.();
  expect(stopped).toBe(true);
  expect(provider.seen).toHaveLength(0);
});

test("durable invocation binding includes participant identity, including omission", async () => {
  const disk = await durable();
  const binding = {
    id: id(40),
    runId: request.runId,
    conversationId: request.conversationId,
    serverId: id(10),
    toolName: "weather",
    input: { city: "Oslo" },
    participantId: id(9),
  };
  await disk.store.begin(binding);
  const claimed = await disk.store.claimExecution(binding.id);
  expect(claimed.claimed).toBe(true);
  expect((await disk.store.claimExecution(binding.id)).claimed).toBe(false);
  await disk.store.finish(binding.id, "completed", { temperature: 12 });
  await expect(
    disk.store.begin({ ...binding, participantId: id(8) }),
  ).rejects.toThrow("binding");
  const { participantId: _participant, ...withoutSpeaker } = binding;
  await expect(disk.store.begin(withoutSpeaker)).rejects.toThrow("binding");
  expect((await disk.store.claimExecution(binding.id)).record.state).toBe(
    "completed",
  );
});

test("concurrent loops claim a pending invocation once and loser cleanup leaves winner running", async () => {
  const disk = await durable();
  let releaseBegins!: () => void;
  const bothBegun = new Promise<void>((resolve) => {
    releaseBegins = resolve;
  });
  let began = 0;
  const store = {
    async begin(input: Parameters<typeof disk.store.begin>[0]) {
      const record = await disk.store.begin(input);
      if (++began === 2) releaseBegins();
      await bothBegun;
      return record;
    },
    claimExecution: (invocationId: string) =>
      disk.store.claimExecution(invocationId),
    finish: (...args: Parameters<typeof disk.store.finish>) =>
      disk.store.finish(...args),
  };
  let started!: () => void,
    finish!: () => void,
    executions = 0;
  let winnerSignal: AbortSignal | undefined;
  const executing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const finishExecution = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const tools = registry(async (_input, context) => {
    executions++;
    winnerSignal = context.signal;
    started();
    await finishExecution;
    return { ok: true, value: { temperature: 12 } };
  });
  const makeProvider = () =>
    fakeProvider((child, round) =>
      round === 1
        ? calls(child).map((event) =>
            event.type === "ToolCall"
              ? { ...event, invocationId: id(40) }
              : event,
          )
        : [{ type: "RunCompleted" }],
    );
  const first = collect(
    engine(tools, { store }).startRun(
      request,
      makeProvider().port,
      policy,
      new AbortController().signal,
    ),
  );
  const second = collect(
    engine(tools, { store }).startRun(
      request,
      makeProvider().port,
      policy,
      new AbortController().signal,
    ),
  );
  await executing;
  const loser = await Promise.race([first, second]);
  expect(loser.at(-1)).toMatchObject({
    type: "RunFailed",
    error: { code: "malformed" },
  });
  expect((await disk.store.get(id(40)))?.state).toBe("running");
  expect(winnerSignal?.aborted).toBe(false);
  finish();
  const all = await Promise.all([first, second]);
  expect(all.map((events) => events.at(-1)?.type).sort()).toEqual([
    "RunCompleted",
    "RunFailed",
  ]);
  expect(executions).toBe(1);
  expect((await disk.store.get(id(40)))?.state).toBe("completed");
});

test("cancellation after begin commits settles the pending call before any dispatch", async () => {
  const disk = await durable(),
    parent = new AbortController();
  let executions = 0;
  const store = {
    async begin(input: Parameters<typeof disk.store.begin>[0]) {
      const record = await disk.store.begin(input);
      parent.abort();
      return record;
    },
    claimExecution: (invocationId: string) =>
      disk.store.claimExecution(invocationId),
    finish: (...args: Parameters<typeof disk.store.finish>) =>
      disk.store.finish(...args),
  };
  const provider = fakeProvider(calls);
  const events = await collect(
    engine(
      registry(async () => {
        executions++;
        return { ok: true, value: null };
      }),
      { store },
    ).startRun(request, provider.port, policy, parent.signal),
  );
  expect(events.at(-1)?.type).toBe("RunCanceled");
  expect(events.some((event) => event.type === "ToolCall")).toBe(false);
  expect(executions).toBe(0);
  expect((await disk.store.list())[0]?.state).toBe("canceled");
});

test("tool schemas, parameters and transformed arguments obey byte limits before dispatch", async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: "weather",
    serverId: id(10),
    enabled: true,
    description: "x".repeat(1000),
    parameters: { type: "object" },
    parseInput: (value) => value,
    execute: async () => ({ ok: true, value: null }),
  });
  const provider = fakeProvider(calls);
  const oversizedSchema = await collect(
    engine(tools).startRun(
      request,
      provider.port,
      { ...policy, maxContextBytes: 512 },
      new AbortController().signal,
    ),
  );
  expect(oversizedSchema.at(-1)).toMatchObject({
    type: "RunFailed",
    error: { code: "quota" },
  });
  expect(provider.seen).toHaveLength(0);
  const hugeParameters = await collect(
    engine(registry()).startRun(
      { ...request, parameters: { extra: "x".repeat(2000) } },
      provider.port,
      { ...policy, maxContextBytes: 1024 },
      new AbortController().signal,
    ),
  );
  expect(hugeParameters.at(-1)).toMatchObject({
    type: "RunFailed",
    error: { code: "quota" },
  });
  expect(provider.seen).toHaveLength(0);
  let executions = 0;
  const transformed = new ToolRegistry();
  transformed.register({
    name: "weather",
    serverId: id(10),
    enabled: true,
    description: "Expand fixture input",
    parameters: { type: "object" },
    parseInput: () => ({ city: "x".repeat(500) }),
    execute: async () => {
      executions++;
      return { ok: true, value: null };
    },
  });
  const events = await collect(
    engine(transformed).startRun(
      request,
      provider.port,
      { ...policy, maxArgumentBytes: 64 },
      new AbortController().signal,
    ),
  );
  expect(events.at(-1)).toMatchObject({
    type: "RunFailed",
    error: { code: "quota" },
  });
  expect(executions).toBe(0);
});

test("metadata event bytes and total event count have independent resource budgets", async () => {
  const huge = fakeProvider(() => [
    { type: "RunStarted" },
    { type: "PromptProgress", fraction: 0.2, detail: "x".repeat(2000) },
    { type: "RunCompleted" },
  ]);
  const oversized = await collect(
    engine(registry()).startRun(
      request,
      huge.port,
      { ...policy, maxEventBytes: 1024 },
      new AbortController().signal,
    ),
  );
  expect(oversized.at(-1)).toMatchObject({
    type: "RunFailed",
    error: { code: "quota" },
  });
  expect(oversized.some((event) => event.type === "PromptProgress")).toBe(
    false,
  );
  const many = fakeProvider(() => [
    { type: "RunStarted" },
    ...Array.from({ length: 20 }, () => ({
      type: "Source",
      url: "https://example.invalid/fixture",
      title: "Fixture source",
    })),
    { type: "RunCompleted" },
  ]);
  const crowded = await collect(
    engine(registry()).startRun(
      request,
      many.port,
      { ...policy, maxEvents: 5 },
      new AbortController().signal,
    ),
  );
  expect(crowded).toHaveLength(5);
  expect(crowded.at(-1)).toMatchObject({
    type: "RunFailed",
    error: { code: "quota" },
  });
  expect(RunEventBatchSchema.safeParse(crowded).success).toBe(true);
});

test("policy edits after RunStarted affect the next run and retain original participant binding", async () => {
  const mutablePolicy = {
    ...policy,
    participantId: id(9),
    maxToolCalls: 128,
    capabilities: { tools: "yes" as "yes" | "no" },
  };
  const provider = fakeProvider((child, round) =>
    round === 1 ? calls(child) : [{ type: "RunCompleted" }],
  );
  const iterator = engine(registry())
    .startRun(
      request,
      provider.port,
      mutablePolicy,
      new AbortController().signal,
    )
    [Symbol.asyncIterator]();
  const first = (await iterator.next()).value;
  mutablePolicy.participantId = id(8);
  mutablePolicy.maxToolCalls = 0;
  mutablePolicy.capabilities.tools = "no";
  const events: RunEvent[] = [first];
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
  }
  expect(events.at(-1)?.type).toBe("RunCompleted");
  expect(events.every((event) => event.participantId === id(9))).toBe(true);
  expect(provider.seen[0]?.permittedTools).toEqual(["weather"]);
});

test("wrapper cancels and deadlines a noncooperative async policy before any provider starts", async () => {
  for (const action of ["cancel", "timeout"] as const) {
    const parent = new AbortController();
    let expire!: () => void,
      started!: () => void,
      stopped = false;
    const resolving = new Promise<void>((resolve) => {
      started = resolve;
    });
    const clock: ToolLoopClock = {
      now: () => 0,
      timestamp: () => timestamp,
      schedule: (_milliseconds, callback) => {
        expire = callback;
        return () => {
          stopped = true;
        };
      },
    };
    const provider = fakeProvider(() => [{ type: "RunCompleted" }]);
    const completePort: ProviderPort = {
      ...provider.port,
      listModels: async () => ({ ok: true, value: [request.modelId] }),
      getCapabilities: async () => ({ ok: true, value: { tools: "yes" } }),
    };
    const wrapped = engine(registry(), { clock }).wrap(completePort, () => {
      started();
      return new Promise<ToolRunPolicy>(() => {});
    });
    const iterator = wrapped
      .startRun(request, parent.signal)
      [Symbol.asyncIterator]();
    const first = iterator.next();
    await resolving;
    if (action === "cancel") parent.abort();
    else expire();
    expect((await first).value.type).toBe("RunStarted");
    expect((await iterator.next()).value).toMatchObject(
      action === "cancel"
        ? { type: "RunCanceled" }
        : { type: "RunFailed", error: { code: "timeout" } },
    );
    expect((await iterator.next()).done).toBe(true);
    expect(provider.seen).toHaveLength(0);
    expect(stopped).toBe(true);
  }
});

test("wrapper rejects malformed tool switches before dispatch with a safe terminal failure", async () => {
  const provider = fakeProvider(() => [{ type: "RunCompleted" }]);
  const completePort: ProviderPort = {
    ...provider.port,
    listModels: async () => ({ ok: true, value: [request.modelId] }),
    getCapabilities: async () => ({ ok: true, value: { tools: "yes" } }),
  };
  const wrapped = engine(registry()).wrap(
    completePort,
    () => ({ ...policy, globalEnabled: "false" }) as unknown as ToolRunPolicy,
  );
  const events = await collect(
    wrapped.startRun(request, new AbortController().signal),
  );
  expect(events.map((event) => event.type)).toEqual([
    "RunStarted",
    "RunFailed",
  ]);
  expect(events.at(-1)).toMatchObject({ error: { code: "malformed" } });
  expect(provider.seen).toHaveLength(0);
});

test("a claimed invocation cannot reset to pending and claim execution a second time", async () => {
  const disk = await durable();
  const binding = {
    id: id(40),
    runId: request.runId,
    conversationId: request.conversationId,
    serverId: id(10),
    toolName: "weather",
    input: { city: "Oslo" },
  };
  await disk.store.begin(binding);
  expect((await disk.store.claimExecution(binding.id)).claimed).toBe(true);
  await expect(
    disk.store.finish(binding.id, "pending" as never, null),
  ).rejects.toThrow("terminal state");
  await expect(
    disk.store.finish(binding.id, "running" as never, null),
  ).rejects.toThrow("terminal state");
  expect((await disk.store.get(binding.id))?.state).toBe("running");
  expect((await disk.store.claimExecution(binding.id)).claimed).toBe(false);
});

test("aggregate metadata bytes stop below event count and per-event caps with one terminal", async () => {
  const provider = fakeProvider(() => [
    { type: "RunStarted" },
    ...Array.from({ length: 20 }, () => ({
      type: "Source",
      url: "https://example.invalid/fixture",
      title: "x".repeat(500),
    })),
    { type: "RunCompleted" },
  ]);
  const events = await collect(
    engine(registry()).startRun(
      request,
      provider.port,
      {
        ...policy,
        maxEventBytes: 2048,
        maxEvents: 100,
        maxTotalEventBytes: 4096,
      },
      new AbortController().signal,
    ),
  );
  expect(events.length).toBeLessThan(20);
  expect(events.some((event) => event.type === "Source")).toBe(true);
  expect(events.at(-1)).toMatchObject({
    type: "RunFailed",
    error: { code: "quota" },
  });
  expect(terminal(events)).toHaveLength(1);
  expect(
    events.reduce(
      (bytes, event) =>
        bytes + new TextEncoder().encode(JSON.stringify(event)).byteLength,
      0,
    ),
  ).toBeLessThanOrEqual(4096);
  expect(RunEventBatchSchema.safeParse(events).success).toBe(true);
});

test("real shared mobile facade claims invocation after unrelated rollback and preserves an ordinary write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "locallab-tools-shared-"));
  const database = new DatabaseSync(join(directory, "tools.sqlite"));
  try {
    const db = sharedMobileDatabase(adapter(database));
    const store = new SQLiteToolInvocationStore(db, id(20), () => timestamp);
    await store.initialize();
    await db.execAsync("CREATE TABLE fixture_audit (value TEXT PRIMARY KEY)");
    const binding = {
      id: id(40),
      runId: request.runId,
      conversationId: request.conversationId,
      serverId: id(10),
      toolName: "weather",
      input: { city: "Oslo" },
    };
    await store.begin(binding);
    let entered!: () => void, release!: () => void;
    const insideTransaction = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rollback = db.withTransactionAsync(async (transaction) => {
      expect(transaction).toBeDefined();
      await transaction!.runAsync(
        "UPDATE tool_engine_invocations SET entity_json=json_set(entity_json,'$.state','failed') WHERE id=?",
        binding.id,
      );
      entered();
      await held;
      throw new Error("Fixture rollback");
    });
    const rollbackResult = expect(rollback).rejects.toThrow("Fixture rollback");
    await insideTransaction;
    let claimed = false,
      ordinarySettled = false;
    const claim = store.claimExecution(binding.id).then((result) => {
      claimed = true;
      return result;
    });
    const ordinary = db
      .runAsync(
        "INSERT INTO fixture_audit(value) VALUES (?)",
        "Independent fixture write",
      )
      .then(() => {
        ordinarySettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(claimed).toBe(false);
    expect(ordinarySettled).toBe(false);
    release();
    await rollbackResult;
    expect((await claim).claimed).toBe(true);
    await ordinary;
    expect((await store.get(binding.id))?.state).toBe("running");
    expect(
      (
        await db.getFirstAsync<{ value: string }>(
          "SELECT value FROM fixture_audit",
        )
      )?.value,
    ).toBe("Independent fixture write");
    expect((await store.claimExecution(binding.id)).claimed).toBe(false);
    await store.finish(binding.id, "completed", { temperature: 12 });
    expect((await store.get(binding.id))?.state).toBe("completed");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
