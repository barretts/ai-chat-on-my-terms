import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { AdvancedChatEngine } from "@locallab/chat-engine-advanced";
import { initializeChatHistory } from "@locallab/chat-history";
import { ContextBudgetError, type ContextPolicy } from "@locallab/context";
import type { SecretStore } from "@locallab/security-secrets";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { migrateSQLite } from "../../../../packages/schema/migrations/full";
import { sharedMobileDatabase } from "../../platform/database";
import { mobileMigrationDatabase } from "../../platform/migrations";
import {
  initializePersonaMemoryChat,
  personaSystemPrompt,
} from "./persona-memory";
import {
  createRegisteredChatProvider,
  SQLiteChatProviderRegistry,
} from "./providers";

const id = (n: number) =>
  `0195c000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const secrets: SecretStore = {
  put: async () => {
    throw new Error("This fixture must not save credentials");
  },
  remove: async () => {},
  resolveHeaders: async () => {
    throw new Error("This fixture must not read credentials");
  },
};

function adapter(native: DatabaseSync): SQLiteDatabasePort {
  return {
    execAsync: async (sql) => native.exec(sql),
    runAsync: async (sql, ...values: SqliteBindValue[]) =>
      native.prepare(sql).run(...values),
    getFirstAsync: async <T,>(sql: string, ...values: SqliteBindValue[]) =>
      (native.prepare(sql).get(...values) as T | undefined) ?? null,
    getAllAsync: async <T,>(sql: string, ...values: SqliteBindValue[]) =>
      native.prepare(sql).all(...values) as T[],
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

async function fixture(
  prompt: string,
  policy: ContextPolicy,
  tokenBudget = 4096,
) {
  const native = new DatabaseSync(":memory:");
  const db = sharedMobileDatabase(adapter(native));
  await migrateSQLite({
    ...mobileMigrationDatabase(db),
    readMigrationSource: (source) => readFile(source, "utf8"),
  });
  await db.runAsync(
    "INSERT INTO providers(id,kind,name) VALUES(?,?,?)",
    id(1),
    "fixture",
    "Persona request fixture",
  );
  await db.runAsync(
    "INSERT INTO models(id,provider_id,name) VALUES(?,?,?)",
    id(2),
    id(1),
    "persona-fixture-model",
  );
  await db.runAsync(
    "INSERT INTO conversations(id,title) VALUES(?,?)",
    id(3),
    "Persona request fixture",
  );
  await initializeChatHistory(db);
  await db.runAsync(
    "INSERT INTO chat_history_metadata(conversation_id,model_id,last_used_at) VALUES(?,NULL,NULL)",
    id(3),
  );
  let next = 100;
  const identities = await initializePersonaMemoryChat(db, () => id(next++));
  const persona = await identities.personas.create({
    name: "Persona fixture",
    prompt,
  });
  await identities.personas.select(id(3), persona.id);
  const identity = await identities.personas.snapshotForNextRun(id(3));
  const registry = new SQLiteChatProviderRegistry(db);
  await registry.initialize();
  await registry.save({
    id: id(4),
    kind: "compatible",
    label: "Persona endpoint",
    modelId: "persona-fixture-model",
    endpoint: "https://persona-request.fixture.example/v1",
  });
  await registry.select(id(3), id(4));
  const selected = await registry.selected(id(3));
  assert.ok(selected);
  const calls: {
    url: string;
    body: Record<string, unknown>;
    serialized: string;
  }[] = [];
  let summarizerCalls = 0;
  const port = createRegisteredChatProvider(selected, {
    secrets,
    fetch: async (url, init) => {
      const serialized = String(init?.body);
      calls.push({
        url: String(url),
        body: JSON.parse(serialized) as Record<string, unknown>,
        serialized,
      });
      return new Response(
        'data: {"choices":[{"delta":{"content":"Fixture reply"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const engine = new AdvancedChatEngine({
    db,
    context: {
      tokenBudget,
      reservedOutputTokens: 64,
      policy,
      summarize: async () => {
        summarizerCalls++;
        return "Fixture summary.";
      },
    },
    // The phone route resolves saved text the same way, and supplies prepared
    // current-user context separately from persisted transcript parts.
    resolveProviderContext: async (message) => [
      {
        kind: message.role,
        value: message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n"),
      },
    ],
  });
  const send = (text: string, chatPrompt = "", memoryPrompt = "") =>
    engine.send({
      conversationId: id(3),
      text,
      systemPrompt: personaSystemPrompt(identity, chatPrompt, memoryPrompt),
      contextParts: [{ type: "text", text }],
      pendingContext: [{ kind: "user", value: text }],
      binding: {
        port,
        providerConnectionId: selected.id,
        providerId: id(1),
        modelRecordId: id(2),
        modelId: selected.modelId,
      },
    });
  return {
    native,
    db,
    identity,
    calls,
    send,
    historySnapshot: () =>
      db.getFirstAsync(
        "SELECT m.model_id,m.last_used_at,c.updated_at FROM conversations c JOIN chat_history_metadata m ON m.conversation_id=c.id WHERE c.id=?",
        id(3),
      ),
    getSummarizerCalls: () => summarizerCalls,
  };
}

for (const policy of ["roll", "cut-middle", "stop", "summarize"] as const) {
  test(`Persona XML, Markdown, quotes, backslashes and Unicode survive actual chat JSON under ${policy}`, async () => {
    const prompt =
      '# Persona “Mira”\n<persona role="friend">\n  <rule>Use **Markdown** & don\'t remove C:\\notes\\file.txt.</rule>\n  <example><![CDATA[{"text":"quoted \\\"words\\\""}]]></example>\n</persona>\n日本語 · café · 🧑‍💻';
    const chatPrompt =
      '<|think_off|>\nFollow the persona. Preserve "quotes" and \\ paths.';
    const memoryPrompt =
      "<memory>Prefers café ☕ and **brief** replies.</memory>";
    const question =
      'Explain <tag attr="value">a & b</tag>.\n```xml\n<example/>\n```\nEmoji: 🦉; 日本語; path C:\\tmp\\x; quote "hello".';
    const f = await fixture(prompt, policy);
    try {
      assert.equal(f.identity.prompt, prompt);
      const handle = await f.send(question, chatPrompt, memoryPrompt);
      const events = [];
      for await (const event of handle.events) events.push(event);
      assert.equal(events.at(-1)?.type, "RunCompleted");
      assert.equal(f.calls.length, 1);
      assert.equal(
        f.calls[0]?.url,
        "https://persona-request.fixture.example/v1/chat/completions",
      );
      assert.equal(f.calls[0]?.body.model, "persona-fixture-model");
      assert.deepEqual(f.calls[0]?.body.messages, [
        {
          role: "system",
          content: [prompt, chatPrompt, memoryPrompt].join("\n\n"),
        },
        { role: "user", content: question },
      ]);
      assert.match(f.calls[0]!.serialized, /\\n/);
      assert.match(f.calls[0]!.serialized, /\\"friend\\"/);
    } finally {
      f.native.close();
    }
  });
}

for (const policy of ["roll", "cut-middle", "stop", "summarize"] as const) {
  test(`oversized Persona fails locally with input-budget recovery instead of sending messages:[] under ${policy}`, async () => {
    const f = await fixture("X".repeat(2000), policy, 256);
    try {
      const historyBefore = await f.historySnapshot();
      await assert.rejects(f.send("Hello"), (cause: unknown) => {
        assert.ok(cause instanceof ContextBudgetError);
        assert.equal(cause.code, "context-full");
        assert.match(cause.message, /context|input|budget/i);
        assert.match(cause.message, /persona|system|instructions/i);
        return true;
      });
      assert.equal(f.calls.length, 0);
      assert.equal(f.getSummarizerCalls(), 0);
      assert.deepEqual(await f.historySnapshot(), historyBefore);
      assert.equal((await f.db.getAllAsync("SELECT id FROM runs")).length, 0);
      assert.equal(
        (await f.db.getAllAsync("SELECT id FROM messages")).length,
        0,
      );
    } finally {
      f.native.close();
    }
  });

  test(`a Persona that fits cannot cause the oversized current question to disappear under ${policy}`, async () => {
    const f = await fixture("X".repeat(32), policy, 256);
    try {
      const historyBefore = await f.historySnapshot();
      await assert.rejects(f.send("Y".repeat(1000)), (cause: unknown) => {
        assert.ok(cause instanceof ContextBudgetError);
        assert.equal(cause.code, "context-full");
        assert.match(cause.message, /context|input|budget/i);
        assert.match(cause.message, /current|latest|message|question/i);
        return true;
      });
      assert.equal(f.calls.length, 0);
      assert.equal(f.getSummarizerCalls(), 0);
      assert.deepEqual(await f.historySnapshot(), historyBefore);
      assert.equal((await f.db.getAllAsync("SELECT id FROM runs")).length, 0);
    } finally {
      f.native.close();
    }
  });
}
