import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { AdvancedChatEngine } from "@locallab/chat-engine-advanced";
import { ChatIntegration, chatFailureCause } from "@locallab/chat-integration";
import { describeError } from "../../features/diagnostics/errors";
import { registerDiagnosticSecret } from "../../features/diagnostics/sanitization";
import { SQLiteChatHistory } from "@locallab/chat-history";
import { HostScopedSecretStore } from "@locallab/security-secrets";
import type { FetchLike } from "@locallab/network-http";
import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { createChatId, initializeFirstRunChat } from "../first-run-chat";
import {
  createRegisteredChatProvider,
  SQLiteChatProviderRegistry,
  type ChatProviderRegistration,
} from "./providers";
import {
  putProviderCredential,
  requireListedProviderModel,
} from "./provider-setup-helpers";

const timestamp = "2026-09-26T12:00:00.000Z";
const secret = "fixture-credential-never-persist";
const context = {
  tokenBudget: 4096,
  reservedOutputTokens: 128,
  policy: "roll" as const,
};

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
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
function secrets() {
  const secureValues = new Map<string, string>();
  return new HostScopedSecretStore(
    {
      get: async (key) => secureValues.get(key) ?? null,
      set: async (key, value) => {
        secureValues.set(key, value);
      },
      delete: async (key) => {
        secureValues.delete(key);
      },
    },
    "provider-composition-fixture",
  );
}
async function fixture(path = ":memory:") {
  const native = new DatabaseSync(path);
  const db = adapter(native);
  const history = await initializeFirstRunChat(db);
  const registry = new SQLiteChatProviderRegistry(db);
  await registry.initialize();
  const conversationId = createChatId();
  await history.allocateConversation({
    allocationKey: conversationId,
    id: conversationId,
    now: timestamp,
  });
  const providerId = createChatId();
  const modelRecordId = createChatId();
  await db.runAsync(
    "INSERT INTO providers(id,kind,name) VALUES(?,?,?)",
    providerId,
    "fixture",
    providerId,
  );
  await db.runAsync(
    "INSERT INTO models(id,provider_id,name) VALUES(?,?,?)",
    modelRecordId,
    providerId,
    modelRecordId,
  );
  return {
    native,
    db,
    history,
    registry,
    conversationId,
    providerId,
    modelRecordId,
  };
}
function binding(
  f: Awaited<ReturnType<typeof fixture>>,
  registration: ChatProviderRegistration,
  port: ProviderPort,
) {
  return {
    providerConnectionId: registration.id,
    providerId: f.providerId,
    modelRecordId: f.modelRecordId,
    modelId: registration.modelId,
    port,
  };
}
async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const values: RunEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
}
function responses(text: string) {
  return new Response(
    [
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`,
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":2}}}\n\n',
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("saved chat provider composition", () => {
  for (const thrown of [false, true]) {
    it(`keeps complete ${thrown ? "thrown" : "HTTP"} failure details across provider, schema validation and integration without persisting them`, async () => {
      const f = await fixture();
      try {
        const sentinel = "LAST-COMPOSED-FAILURE-FIELD";
        const body = JSON.stringify({
          failure: {
            reason: "full failure with no message",
            details: "diagnostic ".repeat(1500),
            cause: "underlying server cause",
          },
          echo: secret,
          sentinel,
        });
        registerDiagnosticSecret(secret);
        const registration: ChatProviderRegistration = {
          id: createChatId(),
          label: "Full error fixture",
          kind: "compatible",
          modelId: "exact-fixture-model",
          endpoint: "https://full-error.fixture.example/v1",
        };
        const port = createRegisteredChatProvider(registration, {
          secrets: secrets(),
          fetch: async () => {
            if (thrown) throw new Error(body);
            return new Response(body, {
              status: 422,
              headers: { "content-type": "application/problem+json" },
            });
          },
        });
        const engine = new AdvancedChatEngine({ db: f.db, context });
        const integration = new ChatIntegration(
          (input: Parameters<typeof engine.send>[0]) => engine.send(input),
          { async retainAttachments() {} },
        );
        const handle = await integration.send({
          conversationId: f.conversationId,
          text: "Retain the complete failure",
          binding: binding(f, registration, port),
        });
        const events = await collect(handle.events);
        const failure = events.find((event) => event.type === "RunFailed");
        assert.ok(failure && failure.type === "RunFailed");
        const displayed = describeError(chatFailureCause(failure.error), {
          operation: "Generate response",
          recovery: "Retry the message.",
        });
        assert.ok(displayed.includes(body.replaceAll(secret, "[REDACTED]")));
        assert.ok(displayed.length > 12_000);
        assert.match(displayed, /LAST-COMPOSED-FAILURE-FIELD/);
        assert.equal(displayed.includes(secret), false);
        assert.equal(JSON.stringify(events).includes(sentinel), false);
        assert.equal(JSON.stringify(events).includes(secret), false);
        const persisted = JSON.stringify({
          runs: await f.db.getAllAsync("SELECT * FROM runs"),
          messages: await f.db.getAllAsync("SELECT * FROM messages"),
          projection: await engine.getProjection(f.conversationId),
        });
        assert.equal(persisted.includes(sentinel), false);
        assert.equal(persisted.includes(secret), false);
      } finally {
        f.native.close();
      }
    });
  }
  it("keeps favorites first after reopening and editing the saved address book", async () => {
    const f = await fixture();
    try {
      const favorite: ChatProviderRegistration = {
        id: createChatId(),
        label: "Favorite",
        kind: "compatible",
        modelId: "exact",
        endpoint: "https://fixture.invalid/v1",
        favorite: true,
      };
      const other = {
        ...favorite,
        id: createChatId(),
        label: "Other",
        favorite: false,
      };
      await f.registry.save(favorite);
      await f.registry.save(other);
      const reopened = new SQLiteChatProviderRegistry(f.db);
      await reopened.initialize();
      assert.deepEqual(
        (await reopened.list()).map((item) => item.id),
        [favorite.id, other.id],
      );
      await reopened.save({ ...favorite, label: "Renamed favorite" });
      assert.equal((await reopened.list()).length, 2);
      assert.equal((await reopened.get(favorite.id))?.favorite, true);
    } finally {
      f.native.close();
    }
  });

  it("refuses removing the active provider, then detaches other chats without deleting history", async () => {
    const f = await fixture();
    try {
      const registration: ChatProviderRegistration = {
        id: createChatId(),
        label: "Saved",
        kind: "compatible",
        modelId: "exact",
        endpoint: "https://fixture.invalid/v1",
      };
      const otherChat = createChatId();
      await f.history.allocateConversation({
        id: otherChat,
        allocationKey: otherChat,
        now: timestamp,
      });
      await f.registry.save(registration);
      await f.registry.select(f.conversationId, registration.id);
      await f.registry.select(otherChat, registration.id);
      await assert.rejects(
        f.registry.remove(registration.id, f.conversationId),
        /Choose another provider/,
      );
      assert.equal((await f.registry.selected(otherChat))?.id, registration.id);
      assert.ok(await f.registry.get(registration.id));
      const before = await f.db.getFirstAsync<{ n: number }>(
        "SELECT COUNT(*) AS n FROM conversations",
      );
      await f.registry.clearSelection(f.conversationId);
      await f.registry.remove(registration.id, f.conversationId);
      assert.equal(await f.registry.selected(otherChat), undefined);
      assert.equal(await f.registry.get(registration.id), undefined);
      const after = await f.db.getFirstAsync<{ n: number }>(
        "SELECT COUNT(*) AS n FROM conversations",
      );
      assert.equal(after?.n, before?.n);
    } finally {
      f.native.close();
    }
  });
  for (const kind of [
    "openai",
    "anthropic",
    "gemini",
    "mistral",
    "compatible",
    "cloud-compatible",
  ] as const) {
    it(`uses the setup form's ${kind} key through the real adapter with one correct vendor header`, async () => {
      const store = secrets();
      const origin = "https://fixture.example";
      const descriptor = await putProviderCredential(
        store,
        kind,
        origin,
        ` Bearer ${secret} `,
      );
      const expectedHeader =
        kind === "anthropic"
          ? "x-api-key"
          : kind === "gemini"
            ? "x-goog-api-key"
            : "authorization";
      let calls = 0;
      const port = createRegisteredChatProvider(
        {
          id: createChatId(),
          label: `${kind} fixture`,
          kind,
          endpoint:
            origin +
            (kind === "openai"
              ? "/v1/responses"
              : kind === "anthropic"
                ? "/v1/messages"
                : ""),
          modelId: "listed-exact-model",
          credentialRef: descriptor.ref,
        },
        {
          secrets: store,
          fetch: async (url, init) => {
            calls++;
            assert.equal(new URL(String(url)).origin, origin);
            const headers = new Headers(init?.headers);
            assert.equal(
              headers.get(expectedHeader),
              expectedHeader === "authorization" ? `Bearer ${secret}` : secret,
            );
            for (const name of [
              "authorization",
              "x-api-key",
              "x-goog-api-key",
            ]) {
              if (name !== expectedHeader)
                assert.equal(headers.get(name), null);
            }
            return Response.json(
              kind === "gemini"
                ? { models: [{ name: "models/listed-exact-model" }] }
                : { data: [{ id: "listed-exact-model" }] },
            );
          },
        },
      );
      await requireListedProviderModel(port, "listed-exact-model");
      assert.equal(calls, 1);
      await assert.rejects(
        store.resolveHeaders("https://another.example", [descriptor.ref]),
        { code: "host-mismatch" },
      );
      await port.dispose?.();
    });
  }

  for (const kind of ["gemini", "mistral"] as const) {
    it(`rejects a ${kind} setup test when the entered model is absent from actual server inventory`, async () => {
      const store = secrets();
      const credential = await putProviderCredential(
        store,
        kind,
        "https://fixture.example",
        secret,
      );
      let calls = 0;
      const port = createRegisteredChatProvider(
        {
          id: createChatId(),
          label: "Catalog miss fixture",
          kind,
          endpoint: "https://fixture.example",
          modelId: "nonexistent-configured-model",
          credentialRef: credential.ref,
        },
        {
          secrets: store,
          fetch: async () => {
            calls++;
            return Response.json(
              kind === "gemini"
                ? { models: [{ name: "models/server-reported-model" }] }
                : { data: [{ id: "server-reported-model" }] },
            );
          },
        },
      );
      await assert.rejects(
        requireListedProviderModel(port, "nonexistent-configured-model"),
        /does not list nonexistent-configured-model.*server-reported-model/,
      );
      assert.equal(calls, 1);
      await port.dispose?.();
    });
  }

  it("persists only allowed setup fields and opaque credential refs, then reopens exact selection", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "locallab-provider-registry-"),
    );
    const f = await fixture(join(directory, "chat.sqlite"));
    let reopened: DatabaseSync | undefined;
    try {
      const store = secrets();
      const descriptor = await store.put(
        "https://fixture.example",
        "authorization",
        secret,
      );
      const registration: ChatProviderRegistration = {
        id: createChatId(),
        label: "Configured fixture",
        kind: "openai",
        modelId: "gpt-exact-fixture",
        endpoint: "https://fixture.example/v1/responses",
        credentialRef: descriptor.ref,
        cleartextAuthorized: false,
        allowCrossProviderRouting: false,
        favorite: false,
      };
      await f.registry.save({
        ...registration,
        apiKey: secret,
        password: secret,
        headers: { authorization: `Bearer ${secret}` },
      } as ChatProviderRegistration);
      await f.registry.select(f.conversationId, registration.id);
      const stored = await f.db.getFirstAsync<{ registration_json: string }>(
        "SELECT registration_json FROM chat_provider_connections WHERE id=?",
        registration.id,
      );
      assert.ok(stored);
      assert.doesNotMatch(stored.registration_json, new RegExp(secret));
      assert.deepEqual(JSON.parse(stored.registration_json), registration);
      f.native.close();
      reopened = new DatabaseSync(join(directory, "chat.sqlite"));
      const registry = new SQLiteChatProviderRegistry(adapter(reopened));
      assert.deepEqual(await registry.selected(f.conversationId), registration);
      assert.deepEqual(await registry.list(), [registration]);
      await assert.rejects(
        registry.save({ ...registration, credentialRef: secret as never }),
        /opaque secure-store/,
      );
      assert.deepEqual(await registry.get(registration.id), registration);
      await assert.rejects(
        registry.save({
          ...registration,
          endpoint: "https://user:password@fixture.example",
        }),
        /without credentials/,
      );
      await assert.rejects(
        registry.select(f.conversationId, createChatId()),
        /unavailable/,
      );
      const rows = reopened.prepare("SELECT config_json FROM providers").all();
      assert.doesNotMatch(JSON.stringify(rows), new RegExp(secret));
    } finally {
      if (reopened) reopened.close();
      else f.native.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires cleartext LAN opt-in before calling Ollama and sends canonical roles to the exact model", async () => {
    const f = await fixture();
    try {
      const registration: ChatProviderRegistration = {
        id: createChatId(),
        label: "LAN Ollama",
        kind: "ollama",
        modelId: "fixture-model:exact-tag",
        endpoint: "http://192.168.50.3:11434",
        cleartextAuthorized: false,
      };
      let calls = 0;
      const captured: Array<{
        url: string;
        body: Record<string, unknown>;
        headers: Headers;
      }> = [];
      const fetch: FetchLike = async (url, init) => {
        calls++;
        captured.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
        });
        return new Response(
          '{"message":{"content":"LAN fixture reply"},"done":true,"done_reason":"stop","prompt_eval_count":5,"eval_count":2}\n',
          { headers: { "content-type": "application/x-ndjson" } },
        );
      };
      const store = secrets();
      registration.credentialRef = (
        await store.put(
          "http://192.168.50.3:11434",
          "authorization",
          `Bearer ${secret}`,
        )
      ).ref;
      const denied = createRegisteredChatProvider(registration, {
        fetch,
        secrets: store,
      });
      const deniedEngine = new AdvancedChatEngine({ db: f.db, context });
      const deniedRun = await deniedEngine.send({
        conversationId: f.conversationId,
        text: "Permission attempt",
        binding: binding(f, registration, denied),
      });
      const deniedEvents = await collect(deniedRun.events);
      assert.equal(calls, 0);
      assert.ok(deniedEvents.some((event) => event.type === "RunFailed"));

      const permittedConversation = createChatId();
      await f.history.allocateConversation({
        allocationKey: permittedConversation,
        id: permittedConversation,
        now: timestamp,
      });
      await f.registry.save({ ...registration, cleartextAuthorized: true });
      await f.registry.select(permittedConversation, registration.id);
      const saved = await f.registry.selected(permittedConversation);
      assert.ok(saved);
      const port = createRegisteredChatProvider(saved, {
        fetch,
        secrets: store,
      });
      const engine = new AdvancedChatEngine({
        db: f.db,
        context,
        resolveBinding: async (conversationId) => {
          assert.equal(conversationId, permittedConversation);
          const selected = await f.registry.selected(conversationId);
          assert.ok(selected);
          return binding(f, selected, port);
        },
      });
      const run = await engine.send({
        conversationId: permittedConversation,
        text: "Reply from LAN fixture",
        systemPrompt: "Fixture system",
        parameters: { temperature: 0.4 },
      });
      assert.ok(
        (await collect(run.events)).some(
          (event) => event.type === "RunCompleted",
        ),
      );
      assert.equal(calls, 1);
      assert.equal(captured[0]?.url, "http://192.168.50.3:11434/api/chat");
      assert.equal(captured[0]?.body.model, registration.modelId);
      assert.equal(
        captured[0]?.headers.get("authorization"),
        `Bearer ${secret}`,
      );
      assert.deepEqual(captured[0]?.body.messages, [
        { role: "system", content: "Fixture system" },
        { role: "user", content: "Reply from LAN fixture" },
      ]);
      const projection = await engine.getProjection(permittedConversation);
      assert.deepEqual(projection.messages[0]?.parts, [
        { type: "text", text: "LAN fixture reply" },
      ]);
      const runRecord = await f.db.getFirstAsync<{
        model_id: string;
        parameters_json: string;
      }>("SELECT model_id,parameters_json FROM runs WHERE id=?", run.runId);
      assert.equal(runRecord?.model_id, f.modelRecordId);
      assert.doesNotMatch(runRecord!.parameters_json, new RegExp(secret));
      assert.deepEqual(JSON.parse(runRecord!.parameters_json).binding, {
        providerConnectionId: registration.id,
        providerId: f.providerId,
        modelRecordId: f.modelRecordId,
        modelId: registration.modelId,
      });
    } finally {
      f.native.close();
    }
  });

  it("uses saved OpenAI binding and selected history, then regenerates without another user row or duplicate context", async () => {
    const f = await fixture();
    try {
      const store = secrets();
      const ref = (
        await store.put(
          "https://openai.fixture.example",
          "authorization",
          secret,
        )
      ).ref;
      const registration: ChatProviderRegistration = {
        id: createChatId(),
        label: "OpenAI fixture",
        kind: "openai",
        modelId: "gpt-exact-snapshot",
        endpoint: "https://openai.fixture.example/v1/responses",
        credentialRef: ref,
      };
      await f.registry.save(registration);
      await f.registry.select(f.conversationId, registration.id);
      const previousUser = createChatId();
      const previousAssistant = createChatId();
      await f.db.runAsync(
        "INSERT INTO messages(id,conversation_id,role,parts_json,sequence) VALUES(?,?,?,?,0)",
        previousUser,
        f.conversationId,
        "user",
        JSON.stringify([{ type: "text", text: "Prior user" }]),
      );
      await f.db.runAsync(
        "INSERT INTO messages(id,conversation_id,role,parts_json,sequence) VALUES(?,?,?,?,1)",
        previousAssistant,
        f.conversationId,
        "assistant",
        JSON.stringify([{ type: "text", text: "Unselected original" }]),
      );
      await f.history.addVariant({
        id: createChatId(),
        messageId: previousAssistant,
        modelId: f.modelRecordId,
        content: [{ type: "text", text: "Unselected original" }],
        createdAt: timestamp,
      });
      const selectedVariant = createChatId();
      await f.history.addVariant({
        id: selectedVariant,
        messageId: previousAssistant,
        modelId: f.modelRecordId,
        content: [{ type: "text", text: "Selected prior reply" }],
        createdAt: timestamp,
      });
      await f.history.selectVariant(previousAssistant, selectedVariant);
      const requests: Array<{
        url: string;
        headers: Headers;
        body: Record<string, unknown>;
      }> = [];
      const fetch: FetchLike = async (url, init) => {
        requests.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return responses(
          requests.length === 1
            ? "First fixture reply"
            : "Regenerated fixture reply",
        );
      };
      const resolvedModels: Array<string | null | undefined> = [];
      const engine = new AdvancedChatEngine({
        db: f.db,
        context,
        resolveBinding: async (conversationId, savedModelRecordId) => {
          resolvedModels.push(savedModelRecordId);
          const selected = await f.registry.selected(conversationId);
          assert.ok(selected);
          return binding(
            f,
            selected,
            createRegisteredChatProvider(selected, { fetch, secrets: store }),
          );
        },
      });
      const run = await engine.send({
        conversationId: f.conversationId,
        text: "Current user",
        systemPrompt: "Fixture instructions",
        parameters: { max_output_tokens: 128, temperature: 0.2 },
      });
      assert.ok(
        (await collect(run.events)).some(
          (event) => event.type === "RunCompleted",
        ),
      );
      assert.equal(requests.length, 1);
      const expectedInput = [
        { role: "system", content: "Fixture instructions" },
        { role: "user", content: "Prior user" },
        { role: "assistant", content: "Selected prior reply" },
        { role: "user", content: "Current user" },
      ];
      assert.deepEqual(requests[0]?.body.input, expectedInput);
      assert.equal(requests[0]?.body.model, registration.modelId);
      assert.equal(requests[0]?.body.max_output_tokens, 128);
      assert.equal(
        requests[0]?.headers.get("authorization"),
        `Bearer ${secret}`,
      );
      assert.equal(requests[0]?.url, registration.endpoint);
      const beforeUserCount = (await f.db.getFirstAsync<{ n: number }>(
        "SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND role='user'",
        f.conversationId,
      ))!.n;
      const beforeParts = (await f.db.getFirstAsync<{ parts_json: string }>(
        "SELECT parts_json FROM messages WHERE id=?",
        run.userMessageId,
      ))!.parts_json;
      const regenerated = await engine.regenerate({
        conversationId: f.conversationId,
        userMessageId: run.userMessageId,
        systemPrompt: "Fixture instructions",
        parameters: { max_output_tokens: 128 },
      });
      assert.ok(
        (await collect(regenerated.events)).some(
          (event) => event.type === "RunCompleted",
        ),
      );
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[1]?.body.input, expectedInput);
      assert.equal(requests[1]?.body.model, registration.modelId);
      assert.equal(regenerated.userMessageId, run.userMessageId);
      assert.equal(
        (await f.db.getFirstAsync<{ n: number }>(
          "SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND role='user'",
          f.conversationId,
        ))!.n,
        beforeUserCount,
      );
      assert.equal(
        (await f.db.getFirstAsync<{ parts_json: string }>(
          "SELECT parts_json FROM messages WHERE id=?",
          run.userMessageId,
        ))!.parts_json,
        beforeParts,
      );
      assert.deepEqual(resolvedModels, [null, f.modelRecordId]);
      const records = await f.db.getAllAsync<{
        parameters_json: string;
        model_id: string;
      }>("SELECT parameters_json,model_id FROM runs ORDER BY created_at,id");
      assert.equal(records.length, 2);
      assert.ok(records.every((record) => record.model_id === f.modelRecordId));
      assert.doesNotMatch(JSON.stringify(records), new RegExp(secret));
      assert.ok(
        records.every(
          (record) =>
            JSON.parse(record.parameters_json).binding.modelId ===
            registration.modelId,
        ),
      );
    } finally {
      f.native.close();
    }
  });

  it("rejects mismatched connection or model before native execution or network fetch", async () => {
    let nativeCalls = 0;
    let fetchCalls = 0;
    const native: ProviderPort = {
      listModels: async () => ({ ok: true, value: [] }),
      getCapabilities: async () => ({ ok: true, value: {} }),
      async *startRun(request) {
        nativeCalls++;
        yield {
          type: "RunStarted",
          runId: request.runId,
          sequence: 0,
          timestamp,
        };
        yield {
          type: "RunCompleted",
          runId: request.runId,
          sequence: 1,
          timestamp,
        };
      },
    };
    const store = secrets();
    for (const kind of ["ollama", "mac-gguf"] as const) {
      const registration: ChatProviderRegistration = {
        id: createChatId(),
        label: "Strict binding",
        kind,
        modelId: "selected-model:exact",
        ...(kind === "ollama"
          ? { endpoint: "http://192.168.50.3:11434", cleartextAuthorized: true }
          : {}),
      };
      const port = createRegisteredChatProvider(registration, {
        secrets: store,
        nativePort: () => native,
        fetch: async () => {
          fetchCalls++;
          return new Response('{"done":true}\n');
        },
      });
      const request: RunRequest = {
        runId: createChatId(),
        conversationId: createChatId(),
        messageId: createChatId(),
        providerConnectionId: registration.id,
        modelId: registration.modelId,
        context: [{ kind: "user", value: "Strict fixture" }],
        parameters: {},
        permittedTools: [],
        attachmentRefs: [],
        reasoning: false,
        json: false,
      };
      for (const mismatched of [
        { ...request, modelId: "other-model" },
        { ...request, providerConnectionId: createChatId() },
      ]) {
        let rejected = false;
        let events: RunEvent[] = [];
        try {
          events = await collect(
            port.startRun(mismatched, new AbortController().signal),
          );
        } catch {
          rejected = true;
        }
        assert.ok(
          rejected || events.some((event) => event.type === "RunFailed"),
        );
      }
    }
    assert.equal(nativeCalls, 0);
    assert.equal(fetchCalls, 0);
  });

  it("redacts native yielded and thrown failures before ChatEngine stores them in SQLite", async () => {
    const f = await fixture();
    try {
      const registration: ChatProviderRegistration = {
        id: createChatId(),
        label: "Mac fixture",
        kind: "mac-gguf",
        modelId: "model:exact-fixture",
      };
      const rawError = `401 Authorization: Bearer ${secret}; request body private-debug-details`;
      for (const thrown of [false, true]) {
        const native: ProviderPort = {
          listModels: async () => ({ ok: true, value: [registration.modelId] }),
          getCapabilities: async () => ({ ok: true, value: {} }),
          async *startRun(request: RunRequest) {
            if (thrown)
              throw Object.assign(new Error(rawError), {
                code: "unauthorized",
              });
            yield {
              type: "RunStarted",
              runId: request.runId,
              sequence: 0,
              timestamp,
            };
            yield {
              type: "RunFailed",
              runId: request.runId,
              sequence: 1,
              timestamp,
              error: {
                code: "unauthorized",
                message: rawError,
                recoverable: true,
              },
            };
          },
        };
        const port = createRegisteredChatProvider(registration, {
          fetch: async () => {
            throw new Error("Native provider must not fetch");
          },
          secrets: secrets(),
          nativePort: () => native,
        });
        const engine = new AdvancedChatEngine({ db: f.db, context });
        const run = await engine.send({
          conversationId: f.conversationId,
          text: "Fixture request",
          binding: binding(f, registration, port),
        });
        const events = await collect(run.events);
        assert.ok(events.some((event) => event.type === "RunFailed"));
        assert.doesNotMatch(
          JSON.stringify(events),
          /fixture-credential-never-persist|private-debug-details|Authorization:/,
        );
        const record = await f.db.getFirstAsync<{
          parameters_json: string;
          status: string;
        }>("SELECT parameters_json,status FROM runs WHERE id=?", run.runId);
        assert.equal(record?.status, "failed");
        assert.doesNotMatch(
          record!.parameters_json,
          /fixture-credential-never-persist|private-debug-details|Authorization:/,
        );
        assert.match(record!.parameters_json, /saved credential/);
      }
      const parts = await f.db.getAllAsync<{ parts_json: string }>(
        "SELECT parts_json FROM messages",
      );
      assert.doesNotMatch(
        JSON.stringify(parts),
        /fixture-credential-never-persist|private-debug-details|Authorization:/,
      );
    } finally {
      f.native.close();
    }
  });

  it("sends configured integration names to LM Studio native requests only", async () => {
    const f = await fixture();
    try {
      const lmStudio: ChatProviderRegistration = {
        id: createChatId(),
        label: "LM Studio",
        kind: "lmstudio",
        modelId: "model-a",
        endpoint: "http://127.0.0.1:1234",
        cleartextAuthorized: true,
      };
      const bodies: Record<string, unknown>[] = [];
      const port = createRegisteredChatProvider(lmStudio, {
        secrets: secrets(),
        fetch: async (_input, init) => {
          bodies.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>,
          );
          return new Response(
            'event: chat.end\ndata: {"type":"chat.end","result":{"output":[{"type":"message","content":"ok"}],"response_id":"resp_int"}}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        },
        lmStudioIntegrations: async () => [
          {
            id: createChatId(),
            name: "mcp/playwright",
            label: "pw",
            enabled: true,
          },
          { id: createChatId(), name: "mcp/ghost", label: "ghost", enabled: false },
        ],
      });
      const engine = new AdvancedChatEngine({ db: f.db, context });
      const run = await engine.send({
        conversationId: f.conversationId,
        text: "Open the site",
        binding: binding(f, lmStudio, port),
      });
      const events = await collect(run.events);
      assert.equal(events.at(-1)?.type, "RunCompleted");
      assert.deepEqual(bodies[0]?.integrations, ["mcp/playwright"]);
    } finally {
      f.native.close();
    }
  });

  it("never sends integration names to Ollama requests", async () => {
    const f = await fixture();
    try {
      const ollama: ChatProviderRegistration = {
        id: createChatId(),
        label: "Ollama",
        kind: "ollama",
        modelId: "llama3",
        endpoint: "http://127.0.0.1:11434",
        cleartextAuthorized: true,
      };
      const bodies: Record<string, unknown>[] = [];
      const port = createRegisteredChatProvider(ollama, {
        secrets: secrets(),
        fetch: async (_input, init) => {
          bodies.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>,
          );
          return new Response(JSON.stringify({ response: "ok", done: true }), {
            headers: { "content-type": "application/json" },
          });
        },
        lmStudioIntegrations: async () => [
          {
            id: createChatId(),
            name: "mcp/playwright",
            label: "pw",
            enabled: true,
          },
        ],
      });
      const engine = new AdvancedChatEngine({ db: f.db, context });
      const run = await engine.send({
        conversationId: f.conversationId,
        text: "Hello",
        binding: binding(f, ollama, port),
      });
      await collect(run.events);
      assert.ok(bodies.length > 0);
      for (const body of bodies)
        assert.equal("integrations" in body, false, JSON.stringify(body));
    } finally {
      f.native.close();
    }
  });
});
