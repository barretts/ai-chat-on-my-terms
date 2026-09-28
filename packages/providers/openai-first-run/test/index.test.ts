import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  RunEventBatchSchema,
  type RunRequest,
  type RunEvent,
} from "@locallab/contracts/run-events";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import {
  createOpenAIResponsesProvider,
  validateResponsesEndpoint,
} from "../src/index.js";
import type { FetchLike } from "@locallab/network-http";
import {
  SQLiteOpenAIEndpointSetupRepository,
  saveOpenAIEndpointSetup,
} from "../../../../apps/mobile/features/openai-endpoint-setup/index.js";

const runId = "018f0b1a-7b3c-7abc-8def-123456789abc";
const request: RunRequest = {
  runId,
  conversationId: runId,
  messageId: runId,
  providerConnectionId: "018f0b1a-7b3c-7abc-8def-123456789abd",
  modelId: "gpt-test",
  context: [{ kind: "text", value: "hello" }],
  parameters: { temperature: 0.2 },
  permittedTools: [],
  attachmentRefs: [],
  reasoning: false,
  json: false,
};
const ref = "sec_018f0b1a-7b3c-7abc-8def-123456789abd" as SecretRef;
const connection = {
  endpointUrl: "https://api.example.test/v1/responses",
  modelId: "gpt-test",
  apiKeyRef: ref,
};
const fixture = new URL("../fixtures/responses-text.sse", import.meta.url);
const fixtureBytes = new TextEncoder().encode(await readFile(fixture, "utf8"));
type SqliteBindValue = string | number | null | Uint8Array;
interface SQLiteDatabasePort {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: SqliteBindValue[]): Promise<unknown>;
  getFirstAsync<T>(
    sql: string,
    ...params: SqliteBindValue[]
  ): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: SqliteBindValue[]): Promise<T[]>;
  withTransactionAsync(work: () => Promise<void>): Promise<void>;
}

function testSecrets() {
  const calls: string[] = [];
  const secrets: SecretStore = {
    async put() {
      throw new Error("unused");
    },
    async remove() {},
    async resolveHeaders(host, refs) {
      calls.push(`${host}:${refs.join(",")}`);
      if (host !== "https://api.example.test" || refs[0] !== ref)
        throw new Error("host mismatch");
      return { authorization: "unit-test-token" };
    },
  };
  return { secrets, calls };
}
async function collect(events: AsyncIterable<RunEvent>) {
  const result: RunEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("OpenAI Responses first-run provider", () => {
  it("streams ordered text and usage through the host-scoped secret reference", async () => {
    const { secrets, calls } = testSecrets();
    let sentAuth = "";
    let body: Record<string, unknown> | undefined;
    const fetch: FetchLike = async (input, init) => {
      expect(String(input)).toBe(connection.endpointUrl);
      sentAuth = new Headers(init?.headers).get("authorization") ?? "";
      body = JSON.parse(String(init?.body));
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of [
              fixtureBytes.slice(0, 83),
              fixtureBytes.slice(83, 141),
              fixtureBytes.slice(141),
            ])
              controller.enqueue(chunk);
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const port = createOpenAIResponsesProvider({
      secrets,
      fetch,
      resolveConnection: async (id) => {
        expect(id).toBe(request.providerConnectionId);
        return connection;
      },
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const events = await collect(
      port.startRun(request, new AbortController().signal),
    );
    expect(sentAuth).toBe("Bearer unit-test-token");
    expect(calls).toEqual([`https://api.example.test:${ref}`]);
    expect(body).toMatchObject({
      model: "gpt-test",
      stream: true,
      temperature: 0.2,
      input: [{ role: "user", content: "hello" }],
    });
    expect(events.map(({ type }) => type)).toEqual([
      "RunStarted",
      "TextDelta",
      "Usage",
      "RunCompleted",
    ]);
    expect(events.find((event) => event.type === "TextDelta")).toMatchObject({
      text: "Hello",
    });
    expect(RunEventBatchSchema.safeParse(events).success).toBe(true);
    expect(JSON.stringify(events)).not.toContain("unit-test-token");
  });

  it("rejects non-HTTPS and cross-origin redirect targets before forwarding authorization", async () => {
    expect(() =>
      validateResponsesEndpoint("http://api.example.test/v1/responses"),
    ).toThrow();
    const { secrets } = testSecrets();
    const calls: string[] = [];
    const fetch: FetchLike = async (input) => {
      calls.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/steal" },
      });
    };
    const port = createOpenAIResponsesProvider({
      secrets,
      fetch,
      resolveConnection: async () => connection,
    });
    const events = await collect(
      port.startRun(request, new AbortController().signal),
    );
    expect(calls).toEqual([connection.endpointUrl]);
    expect(events.at(-1)).toMatchObject({
      type: "RunFailed",
      error: { code: "offline" },
    });
  });

  it("propagates cancellation and emits one terminal event", async () => {
    const { secrets } = testSecrets();
    let requestSignal: AbortSignal | undefined;
    const fetch: FetchLike = async (_input, init) => {
      requestSignal = init?.signal as AbortSignal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            requestSignal?.addEventListener(
              "abort",
              () => controller.error(new Error("abort")),
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const port = createOpenAIResponsesProvider({
      secrets,
      fetch,
      resolveConnection: async () => connection,
    });
    const abort = new AbortController();
    const iterator = port
      .startRun(request, abort.signal)
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("RunStarted");
    abort.abort();
    const final = await iterator.next();
    expect(final.value?.type).toBe("RunCanceled");
    expect((await iterator.next()).done).toBe(true);
  });

  it.each([
    [401, "unauthorized"],
    [404, "missing-model"],
  ] as const)(
    "maps HTTP %i to a typed recoverable provider error",
    async (status, code) => {
      const { secrets } = testSecrets();
      const fetch: FetchLike = async () =>
        new Response("{}", {
          status,
          headers: { "content-type": "application/json" },
        });
      const port = createOpenAIResponsesProvider({
        secrets,
        fetch,
        resolveConnection: async () => connection,
      });
      const events = await collect(
        port.startRun(request, new AbortController().signal),
      );
      expect(events.at(-1)).toMatchObject({
        type: "RunFailed",
        error: { code, recoverable: false },
      });
    },
  );

  it("contains no credential bytes in the checked-in stream fixture", async () => {
    const contents = await readFile(
      new URL("../fixtures/responses-text.sse", import.meta.url),
      "utf8",
    );
    expect(contents).not.toMatch(/api[_-]?key|authorization|bearer\s/i);
  });

  it("maps the Responses model_not_found event without exposing provider detail", async () => {
    const { secrets } = testSecrets();
    const bytes = new TextEncoder().encode(
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"model_not_found","message":"secret-bearing provider detail"}}}\n\n',
    );
    const fetch: FetchLike = async () =>
      new Response(bytes, { headers: { "content-type": "text/event-stream" } });
    const port = createOpenAIResponsesProvider({
      secrets,
      fetch,
      resolveConnection: async () => connection,
    });
    const events = await collect(
      port.startRun(request, new AbortController().signal),
    );
    expect(events.at(-1)).toMatchObject({
      type: "RunFailed",
      error: { code: "missing-model", recoverable: false },
    });
    expect(JSON.stringify(events)).not.toContain("secret-bearing");
  });

  it("persists endpoint/model/reference across repository recreation without putting the key in SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "locallab-openai-setup-"));
    const databasePath = join(directory, "setup.sqlite");
    const database = new DatabaseSync(databasePath);
    const db: SQLiteDatabasePort = {
      execAsync: async (sql) => {
        database.exec(sql);
      },
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
    let storedKey = "";
    const secrets: SecretStore = {
      async put(host, headerName, value) {
        expect(host).toBe("https://api.openai.com");
        expect(headerName).toBe("Authorization");
        storedKey = value;
        return { ref, host, headerName };
      },
      async remove() {
        storedKey = "";
      },
      async resolveHeaders(host, refs) {
        if (host !== "https://api.openai.com" || refs[0] !== ref || !storedKey)
          throw new Error("scope mismatch");
        return { authorization: storedKey };
      },
    };
    const first = new SQLiteOpenAIEndpointSetupRepository(db);
    const saved = await saveOpenAIEndpointSetup({
      connectionId: request.providerConnectionId,
      endpointUrl: "https://api.openai.com/v1/responses",
      modelId: "gpt-configured",
      apiKey: "unit-test-token",
      repository: first,
      secrets,
    });
    const reopened = await new SQLiteOpenAIEndpointSetupRepository(db).get(
      request.providerConnectionId,
    );
    expect(reopened).toEqual(saved);
    expect(reopened?.modelId).toBe("gpt-configured");
    const row = database.prepare("SELECT * FROM openai_first_run_setup").get();
    expect(JSON.stringify(row)).not.toContain("unit-test-token");
    expect(storedKey).toBe("unit-test-token");
    database.close();
    const afterRelaunchDb = new DatabaseSync(databasePath);
    try {
      const adapter: SQLiteDatabasePort = {
        execAsync: async (sql) => {
          afterRelaunchDb.exec(sql);
        },
        runAsync: async (sql: string, ...params: SqliteBindValue[]) =>
          afterRelaunchDb.prepare(sql).run(...params),
        getFirstAsync: async <T>(sql: string, ...params: SqliteBindValue[]) =>
          (afterRelaunchDb.prepare(sql).get(...params) as T | undefined) ??
          null,
        getAllAsync: async <T>(sql: string, ...params: SqliteBindValue[]) =>
          afterRelaunchDb.prepare(sql).all(...params) as T[],
        withTransactionAsync: async (work) => {
          afterRelaunchDb.exec("BEGIN IMMEDIATE");
          try {
            await work();
            afterRelaunchDb.exec("COMMIT");
          } catch (error) {
            afterRelaunchDb.exec("ROLLBACK");
            throw error;
          }
        },
      };
      expect(
        await new SQLiteOpenAIEndpointSetupRepository(adapter).get(
          request.providerConnectionId,
        ),
      ).toEqual(saved);
    } finally {
      afterRelaunchDb.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
