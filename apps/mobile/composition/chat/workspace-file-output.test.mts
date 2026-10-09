import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { strToU8 } from "fflate";
import type { ProviderPort } from "@locallab/contracts/ports";
import {
  RunEventBatchSchema,
  type RunEvent,
  type RunRequest,
} from "@locallab/contracts/run-events";
import {
  localFailureCause,
  retainLocalFailureCause,
} from "@locallab/contracts/local-failure-details";
import { HttpTransportError } from "@locallab/network-http";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import {
  SQLiteToolInvocationStore,
  ToolLoopEngine,
  ToolRegistry,
} from "@locallab/tools-engine";
import { createChatId } from "../first-run-chat";
import { sharedMobileDatabase } from "../../platform/database";
import { registerDiagnosticSecret } from "../../features/diagnostics/sanitization";
import {
  SQLiteWorkspaceFiles,
  WORKSPACE_LIMITS,
} from "../../features/workspace-files/store";
import {
  createWorkspaceTools,
  WORKSPACE_TOOL_NAMES,
} from "../../features/workspace-files/tools";
import {
  withVerifiedWorkspaceFileSave,
  withWorkspaceFileOutput,
  type WorkspaceOutputStore,
} from "./workspace-file-output";

function request(): RunRequest {
  return {
    runId: createChatId(),
    conversationId: createChatId(),
    messageId: createChatId(),
    providerConnectionId: createChatId(),
    modelId: "file-fixture",
    context: [],
    parameters: { max_output_tokens: 2048 },
    permittedTools: [...WORKSPACE_TOOL_NAMES],
    attachmentRefs: [],
    reasoning: false,
    json: false,
  };
}
function event(
  req: RunRequest,
  payload: Record<string, unknown>,
  sequence = 0,
): RunEvent {
  return {
    runId: req.runId,
    sequence,
    timestamp: "2026-09-29T18:00:00.000Z",
    ...payload,
  } as RunEvent;
}
function provider(
  run: (req: RunRequest, signal: AbortSignal) => AsyncIterable<RunEvent>,
): ProviderPort {
  return {
    listModels: async () => ({ ok: true, value: ["file-fixture"] }),
    getCapabilities: async () => ({ ok: true, value: { tools: "unknown" } }),
    startRun: run,
  };
}
function source(text: string, finishReason?: string): ProviderPort {
  return provider(async function* (req) {
    yield event(req, { type: "RunStarted" });
    yield event(
      req,
      {
        type: "ReasoningDelta",
        text: "Private reasoning is not file content.",
      },
      1,
    );
    yield event(req, { type: "TextDelta", text }, 2);
    yield event(
      req,
      { type: "RunCompleted", ...(finishReason ? { finishReason } : {}) },
      3,
    );
  });
}
function memoryStore() {
  const writes: { path: string; content: string; expectedRevision?: number }[] =
    [];
  const store: WorkspaceOutputStore = {
    write: async (input) => {
      writes.push(input);
      return {
        path: input.path,
        revision: (input.expectedRevision ?? 0) + 1,
        byteLength: strToU8(input.content).byteLength,
      };
    },
  };
  return { store, writes };
}
async function collect(
  port: ProviderPort,
  req = request(),
  signal = new AbortController().signal,
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const value of port.startRun(req, signal)) events.push(value);
  expect(RunEventBatchSchema.safeParse(events).success).toBe(true);
  expect(events.map((value) => value.sequence)).toEqual(
    events.map((_value, index) => index),
  );
  expect(
    events.filter((value) =>
      ["RunCompleted", "RunFailed", "RunCanceled"].includes(value.type),
    ),
  ).toHaveLength(1);
  return events;
}
function adapter(native: DatabaseSync): SQLiteDatabasePort {
  return {
    execAsync: async (sql) => native.exec(sql),
    runAsync: async (sql, ...params: SqliteBindValue[]) =>
      native.prepare(sql).run(...params),
    getFirstAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      (native.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      native.prepare(sql).all(...params) as T[],
    withTransactionAsync: async (work) => {
      native.exec("BEGIN IMMEDIATE");
      try {
        await work();
        native.exec("COMMIT");
      } catch (cause) {
        native.exec("ROLLBACK");
        throw cause;
      }
    },
  };
}
async function sqliteStore(conversationId: string) {
  const native = new DatabaseSync(":memory:");
  const db = sharedMobileDatabase(adapter(native));
  await db.execAsync(
    "PRAGMA foreign_keys=ON; CREATE TABLE conversations(id TEXT PRIMARY KEY);",
  );
  await db.runAsync("INSERT INTO conversations(id) VALUES(?)", conversationId);
  const store = new SQLiteWorkspaceFiles(db, conversationId);
  await store.initialize();
  return { native, db, store };
}

describe("complete-response file fallback", () => {
  it("preserves the upstream provider's disposal method and receiver through both wrappers", async () => {
    let disposed = 0;
    const upstream = {
      ...source("complete"),
      dispose() {
        expect(this).toBe(upstream);
        disposed++;
      },
    };
    const f = memoryStore();
    await withWorkspaceFileOutput(upstream, {
      store: f.store,
      path: "plan.md",
      createId: createChatId,
    }).dispose?.();
    await withVerifiedWorkspaceFileSave(upstream, {
      path: "plan.md",
    }).dispose?.();
    expect(disposed).toBe(2);
  });
  it("saves complete Unicode, XML, Markdown and internal fences without reasoning, while preserving event order", async () => {
    const f = memoryStore();
    const content =
      '# Résumé 🌻\n\n<xml attr="a & b">你好</xml>\n\n```typescript\nconst thing = `inner`;\n```\n';
    const req = request();
    const events = await collect(
      withWorkspaceFileOutput(source(content), {
        store: f.store,
        path: "notes/plan.md",
        createId: createChatId,
      }),
      req,
    );
    expect(f.writes).toEqual([{ path: "notes/plan.md", content }]);
    expect(events.map((value) => value.type)).toEqual([
      "RunStarted",
      "ReasoningDelta",
      "TextDelta",
      "ToolCall",
      "ToolResult",
      "RunCompleted",
    ]);
    expect(events.at(-2)).toMatchObject({
      type: "ToolResult",
      output: { saved: true, path: "notes/plan.md", revision: 1 },
    });
  });

  it.each(["```markdown\n", "````md\n", "~~~txt\r\n"])(
    "removes only an outer response wrapper %j and retains inner fences and content line endings",
    async (opening) => {
      const f = memoryStore();
      const newline = opening.includes("\r\n") ? "\r\n" : "\n";
      const content = `# Plan 🌻${newline}${newline}\`\`\`js${newline}const a = 1;${newline}\`\`\`${newline}`;
      const fence = /^(?:`+|~+)/.exec(opening)![0];
      await collect(
        withWorkspaceFileOutput(
          source(`${opening}${content}${fence}${newline}`),
          { store: f.store, path: "plan.md", createId: createChatId },
        ),
      );
      expect(f.writes[0]?.content).toBe(content);
    },
  );

  it("retains legitimate leading code blocks and split emoji chunks, with exact UTF-8 quota handling", async () => {
    const f = memoryStore();
    const content = "```typescript\nconst a = 1;\n```\n\n🌻 is the result.\n";
    await collect(
      withWorkspaceFileOutput(
        provider(async function* (req) {
          yield event(req, { type: "RunStarted" });
          const split = content.indexOf("🌻") + 1;
          yield event(
            req,
            { type: "TextDelta", text: content.slice(0, split) },
            1,
          );
          yield event(
            req,
            { type: "TextDelta", text: content.slice(split) },
            2,
          );
          yield event(req, { type: "RunCompleted" }, 3);
        }),
        { store: f.store, path: "plan.md", createId: createChatId },
      ),
    );
    expect(f.writes[0]?.content).toBe(content);
    const exact = "a".repeat(WORKSPACE_LIMITS.fileBytes - 1) + "\n";
    await collect(
      withWorkspaceFileOutput(source(`~~~txt\n${exact}~~~\n`), {
        store: f.store,
        path: "limit.txt",
        createId: createChatId,
      }),
    );
    expect(f.writes[1]?.content).toBe(exact);
  });

  it.each([
    "length",
    "max_tokens",
    "MAX_OUTPUT_TOKENS",
    "content_filter",
    "incomplete",
    "tool_calls",
  ])(
    "does not save a truncated or unfinished response (%s)",
    async (finishReason) => {
      const f = memoryStore();
      const events = await collect(
        withWorkspaceFileOutput(source("partial", finishReason), {
          store: f.store,
          path: "partial.md",
          createId: createChatId,
        }),
      );
      expect(f.writes).toEqual([]);
      expect(events.at(-1)).toMatchObject({
        type: "RunFailed",
        error: {
          message: expect.stringContaining("incomplete file was not saved"),
        },
      });
    },
  );

  it("does not save an empty, oversized or unterminated stream", async () => {
    for (const upstream of [
      source(" \n"),
      source("a".repeat(WORKSPACE_LIMITS.fileBytes + 1)),
      provider(async function* (req) {
        yield event(req, { type: "TextDelta", text: "unfinished" });
      }),
    ]) {
      const f = memoryStore();
      const events = await collect(
        withWorkspaceFileOutput(upstream, {
          store: f.store,
          path: "partial.md",
          createId: createChatId,
        }),
      );
      expect(f.writes).toEqual([]);
      expect(events.at(-1)?.type).toBe("RunFailed");
    }
  });

  it("does not save after cancellation or an upstream failed terminal, preserving the original local cause", async () => {
    const controller = new AbortController();
    const f = memoryStore();
    const canceled = await collect(
      withWorkspaceFileOutput(
        provider(async function* (req) {
          yield event(req, { type: "TextDelta", text: "partial" });
          controller.abort();
          yield event(req, { type: "RunCompleted" }, 1);
        }),
        { store: f.store, path: "partial.md", createId: createChatId },
      ),
      request(),
      controller.signal,
    );
    expect(canceled.at(-1)?.type).toBe("RunCanceled");
    expect(f.writes).toEqual([]);
    const cause = new Error("Original response failed");
    const failed = await collect(
      withWorkspaceFileOutput(
        provider(async function* (req) {
          const failure = event(req, {
            type: "RunFailed",
            error: {
              code: "offline",
              message: "Full upstream failure",
              recoverable: true,
            },
          });
          retainLocalFailureCause(failure, cause);
          yield failure;
        }),
        { store: f.store, path: "partial.md", createId: createChatId },
      ),
    );
    expect(failed.at(-1)).toMatchObject({
      type: "RunFailed",
      error: { message: "Full upstream failure" },
    });
    expect(localFailureCause(failed.at(-1)!)).toBe(cause);
    expect(f.writes).toEqual([]);
  });

  it("preserves complete HTTP response bodies and local causes when the provider throws", async () => {
    const f = memoryStore();
    const body =
      '{"error":{"message":"messages must be a non-empty array","type":"invalid_request_error"}}';
    const cause = new HttpTransportError(
      "http",
      "Generate response rejected",
      true,
      400,
      {
        response: {
          status: 400,
          statusText: "bad request",
          contentType: "application/json",
          body,
          complete: true,
        },
      },
    );
    const events = await collect(
      withWorkspaceFileOutput(
        provider(async function* () {
          throw cause;
        }),
        { store: f.store, path: "partial.md", createId: createChatId },
      ),
    );
    const failure = events.at(-1)!;
    expect(failure).toMatchObject({
      type: "RunFailed",
      error: { message: expect.stringContaining(body) },
    });
    if (failure.type !== "RunFailed") throw new Error("Expected failure");
    expect(failure.error.message).toContain("HTTP 400 bad request");
    expect(failure.error.message).toContain("Content-Type: application/json");
    expect(localFailureCause(failure.error)).toBe(cause);
    expect(localFailureCause(failure)).toBe(cause);
    expect(f.writes).toEqual([]);
  });

  it("reports a real SQLite stale-revision conflict without overwriting newer saved text", async () => {
    const req = request();
    const f = await sqliteStore(req.conversationId);
    try {
      await f.store.write({ path: "plan.md", content: "first" });
      await f.store.write({
        path: "plan.md",
        content: "newer manual edit",
        expectedRevision: 1,
      });
      const events = await collect(
        withWorkspaceFileOutput(source("stale model edit"), {
          store: f.store,
          path: "plan.md",
          expectedRevision: 1,
          createId: createChatId,
        }),
        req,
      );
      expect(events.at(-2)).toMatchObject({
        type: "ToolResult",
        output: { error: expect.stringContaining("revision 2") },
      });
      expect(events.at(-1)).toMatchObject({
        type: "RunFailed",
        error: { message: expect.stringContaining("revision 2") },
      });
      expect(await f.store.read("plan.md")).toMatchObject({
        content: "newer manual edit",
        revision: 2,
      });
    } finally {
      f.native.close();
    }
  });

  it("emits only one terminal when an upstream iterator throws while closing after completion", async () => {
    const f = memoryStore();
    const events = await collect(
      withWorkspaceFileOutput(
        provider(async function* (req) {
          try {
            yield event(req, { type: "TextDelta", text: "complete" });
            yield event(req, { type: "RunCompleted" }, 1);
          } finally {
            throw new Error("Cleanup failure after terminal");
          }
        }),
        { store: f.store, path: "plan.md", createId: createChatId },
      ),
    );
    expect(events.at(-1)?.type).toBe("RunCompleted");
    expect(f.writes).toHaveLength(1);
  });
});

describe("diagnostic privacy for files", () => {
  it("redacts known secrets from the complete HTTP body while preserving non-secret response details and the cause", async () => {
    const secret = "workspace-test-credential-private";
    registerDiagnosticSecret(secret);
    const body = JSON.stringify({
      error: {
        message: "messages must be a non-empty array",
        debug: `credential=${secret}`,
        count: 7,
      },
    });
    const cause = new HttpTransportError(
      "http",
      "Generate response rejected",
      true,
      400,
      {
        response: {
          status: 400,
          statusText: "bad request",
          contentType: "application/json",
          body,
          complete: true,
        },
      },
    );
    const f = memoryStore();
    const events = await collect(
      withWorkspaceFileOutput(
        provider(async function* () {
          throw cause;
        }),
        { store: f.store, path: "plan.md", createId: createChatId },
      ),
    );
    const failure = events.at(-1)!;
    if (failure.type !== "RunFailed") throw new Error("Expected failure");
    expect(failure.error.message).not.toContain(secret);
    expect(failure.error.message).toContain("[REDACTED]");
    expect(failure.error.message).toContain(
      "messages must be a non-empty array",
    );
    expect(failure.error.message).toContain('"count":7');
    expect(localFailureCause(failure.error)).toBe(cause);
    const forwarded = await collect(
      withVerifiedWorkspaceFileSave(
        provider(async function* (req) {
          yield event(req, {
            type: "RunFailed",
            error: {
              code: "http",
              message: `Failure ${secret}; kept detail`,
              recoverable: true,
            },
          });
        }),
        { path: "plan.md" },
      ),
    );
    expect(forwarded.at(-1)).toMatchObject({
      type: "RunFailed",
      error: { message: "Failure [REDACTED]; kept detail" },
    });
  });
});

describe("verified native file saves", () => {
  it("refuses conversational claims or unrelated/failed tool results without autosaving a reply", async () => {
    for (const mode of ["claimed", "wrong-path", "failed", "unbound-result"]) {
      const invocationId = createChatId();
      const events = await collect(
        withVerifiedWorkspaceFileSave(
          provider(async function* (req) {
            yield event(req, { type: "RunStarted" });
            if (mode !== "claimed" && mode !== "unbound-result")
              yield event(
                req,
                {
                  type: "ToolCall",
                  invocationId,
                  name: "workspace_write_file",
                  input: {
                    path: mode === "wrong-path" ? "wrong.md" : "plan.md",
                    content: "content",
                  },
                },
                1,
              );
            if (mode !== "claimed")
              yield event(
                req,
                {
                  type: "ToolResult",
                  invocationId,
                  output:
                    mode === "failed"
                      ? { error: "conflict" }
                      : { saved: true, path: "plan.md", revision: 1 },
                },
                2,
              );
            yield event(
              req,
              { type: "TextDelta", text: "I saved plan.md." },
              3,
            );
            yield event(req, { type: "RunCompleted" }, 4);
          }),
          { path: "plan.md" },
        ),
      );
      expect(events.at(-1)).toMatchObject({
        type: "RunFailed",
        error: {
          code: "workspace-not-saved",
          message: expect.stringContaining("without saving plan.md"),
        },
      });
    }
  });

  it("accepts a confirmed case-insensitive write even if the final confirmation is truncated", async () => {
    const invocationId = createChatId();
    const events = await collect(
      withVerifiedWorkspaceFileSave(
        provider(async function* (req) {
          yield event(req, {
            type: "ToolCall",
            invocationId,
            name: "workspace_write_file",
            input: { path: "notes/Plan.md", content: "complete file" },
          });
          yield event(
            req,
            {
              type: "ToolResult",
              invocationId,
              output: { saved: true, path: "notes/PLAN.md", revision: 3 },
            },
            1,
          );
          yield event(req, { type: "RunCompleted", finishReason: "length" }, 2);
        }),
        { path: "notes/plan.md" },
      ),
    );
    expect(events.at(-1)).toMatchObject({
      type: "RunCompleted",
      finishReason: "length",
    });
  });

  it("runs the real tool loop and SQLite save with the app's bounded policy, continuing to a confirmed response", async () => {
    const req = request();
    const f = await sqliteStore(req.conversationId);
    try {
      const content =
        '# Launch plan 🌻\n\n<xml attr="a & b">Full content</xml>\n\n```txt\ninside fence\n```\n';
      const registry = new ToolRegistry();
      for (const tool of createWorkspaceTools(f.store)) registry.register(tool);
      const invocations = new SQLiteToolInvocationStore(f.db, createChatId());
      await invocations.initialize();
      let round = 0;
      const continuations: RunRequest[] = [];
      const loop = new ToolLoopEngine({
        registry,
        store: invocations,
        createId: createChatId,
      }).wrap(
        provider(async function* (child) {
          continuations.push(child);
          yield event(child, { type: "RunStarted" });
          if (round++ === 0) {
            yield event(
              child,
              {
                type: "ToolCall",
                invocationId: createChatId(),
                name: "workspace_write_file",
                input: { path: "notes/plan.md", content },
              },
              1,
            );
            yield event(
              child,
              { type: "RunCompleted", finishReason: "tool_calls" },
              2,
            );
          } else {
            yield event(
              child,
              { type: "TextDelta", text: "Saved notes/plan.md in Files." },
              1,
            );
            yield event(
              child,
              { type: "RunCompleted", finishReason: "stop" },
              2,
            );
          }
        }),
        () => ({
          globalEnabled: true,
          capabilities: { tools: "yes" },
          roundLimit: 6,
          maxToolCalls: 12,
          deadlineMs: 300_000,
          maxArgumentBytes: 1_000_000,
          maxResultBytes: 256 * 1024,
          maxContextBytes: 8 * 1024 * 1024,
          maxEventBytes: 1024 * 1024,
          maxTotalEventBytes: 8 * 1024 * 1024,
          tokenBudget: 65_536,
          reservedOutputTokens: 2048,
        }),
      );
      const events = await collect(
        withVerifiedWorkspaceFileSave(loop, { path: "notes/plan.md" }),
        req,
      );
      expect(events.at(-1)?.type).toBe("RunCompleted");
      expect(round).toBe(2);
      expect(JSON.stringify(continuations[1]!.context)).toContain(
        "notes/plan.md",
      );
      expect(await f.store.read("notes/plan.md")).toMatchObject({
        content,
        revision: 1,
      });
      expect(await invocations.list()).toMatchObject([
        { state: "completed", output: { saved: true, path: "notes/plan.md" } },
      ]);
    } finally {
      f.native.close();
    }
  });
});
