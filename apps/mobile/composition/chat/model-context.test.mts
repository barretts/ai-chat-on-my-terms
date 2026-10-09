import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { HostScopedSecretStore } from "@locallab/security-secrets";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { createChatId, initializeFirstRunChat } from "../first-run-chat";
import {
  SQLiteChatProviderRegistry,
  type ChatProviderRegistration,
} from "./providers";
import {
  discoverRegisteredModelContext,
  modelContextKey,
} from "./model-context";

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

async function fixture() {
  const native = new DatabaseSync(":memory:");
  const db = adapter(native);
  const history = await initializeFirstRunChat(db);
  const conversationId = createChatId();
  await history.allocateConversation({
    allocationKey: conversationId,
    id: conversationId,
    now: "2026-09-29T18:00:00.000Z",
  });
  const registry = new SQLiteChatProviderRegistry(db);
  await registry.initialize();
  return { native, registry, conversationId };
}

function connection(): ChatProviderRegistration {
  return {
    id: createChatId(),
    label: "This PC",
    kind: "compatible",
    endpoint: "http://192.168.1.213:35961/v1",
    modelId: "exact-context-fixture",
    headerRefs: [],
  };
}

function secrets() {
  const values = new Map<string, string>();
  return new HostScopedSecretStore(
    {
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => {
        values.delete(key);
      },
    },
    "context-key-fixture",
  );
}

describe("context identity across saved connection normalization", () => {
  it.each([undefined, false, true])(
    "keeps a new form's empty header references stable after SQLite save/select (HTTP authorization %s)",
    async (cleartextAuthorized) => {
      const f = await fixture();
      try {
        const raw = {
          ...connection(),
          ...(cleartextAuthorized === undefined ? {} : { cleartextAuthorized }),
        };
        const expectedKey = modelContextKey(raw);
        await f.registry.save(raw);
        await f.registry.select(f.conversationId, raw.id);
        const saved = await f.registry.get(raw.id);
        const selected = await f.registry.selected(f.conversationId);
        expect(saved).toBeDefined();
        expect(selected).toBeDefined();
        // Registry intentionally omits empty references and normalizes consent.
        // Those representation changes cannot invalidate the active display key.
        expect(saved?.headerRefs).toBeUndefined();
        expect(saved?.cleartextAuthorized).toBe(cleartextAuthorized === true);
        expect(modelContextKey(saved!)).toBe(expectedKey);
        expect(modelContextKey(selected!)).toBe(expectedKey);
        expect(raw.headerRefs).toEqual([]);
      } finally {
        f.native.close();
      }
    },
  );

  it("invalidates context identity when the endpoint, model, authorization or secret references change", async () => {
    const f = await fixture();
    try {
      const raw = { ...connection(), cleartextAuthorized: true };
      await f.registry.save(raw);
      await f.registry.select(f.conversationId, raw.id);
      const initial = (await f.registry.selected(f.conversationId))!;
      const initialKey = modelContextKey(initial);
      const credentialRef = "sec_00000000-0000-4000-8000-000000000001" as never;
      const headerRef = "sec_00000000-0000-4000-8000-000000000002" as never;
      const changes: Partial<ChatProviderRegistration>[] = [
        { endpoint: "http://192.168.1.214:35961/v1" },
        { modelId: "different-exact-model" },
        { cleartextAuthorized: false },
        { credentialRef },
        { headerRefs: [headerRef] },
        { kind: "jan" },
      ];
      const changedKeys = new Set<string>();
      for (const change of changes) {
        const changed = { ...raw, ...change };
        await f.registry.save(changed);
        const selected = (await f.registry.selected(f.conversationId))!;
        const key = modelContextKey(selected);
        expect(key).toBe(modelContextKey(changed));
        expect(key).not.toBe(initialKey);
        changedKeys.add(key);
      }
      expect(changedKeys.size).toBe(changes.length);
      await f.registry.save({ ...raw, label: "Renamed PC", favorite: true });
      expect(
        modelContextKey((await f.registry.selected(f.conversationId))!),
      ).toBe(initialKey);
    } finally {
      f.native.close();
    }
  });

  it("retains exact private HTTP authorization through SQLite and refuses discovery after consent is removed", async () => {
    const f = await fixture();
    try {
      const raw = { ...connection(), cleartextAuthorized: true };
      await f.registry.save(raw);
      await f.registry.select(f.conversationId, raw.id);
      const selected = (await f.registry.selected(f.conversationId))!;
      const calls: string[] = [];
      const options = {
        secrets: secrets(),
        fetch: async (input: string | URL) => {
          calls.push(String(input));
          return Response.json({
            data: [{ id: raw.modelId, max_model_len: 65536 }],
          });
        },
      };
      expect(await discoverRegisteredModelContext(selected, options)).toEqual({
        contextWindowTokens: 65536,
        source: "models",
      });
      expect(calls).toEqual(["http://192.168.1.213:35961/v1/models"]);
      expect(selected.endpoint).toBe(raw.endpoint);
      expect(selected.cleartextAuthorized).toBe(true);
      await f.registry.save({ ...raw, cleartextAuthorized: false });
      const refused = (await f.registry.selected(f.conversationId))!;
      expect(refused.cleartextAuthorized).toBe(false);
      expect(
        await discoverRegisteredModelContext(refused, options),
      ).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(modelContextKey(refused)).not.toBe(modelContextKey(selected));
    } finally {
      f.native.close();
    }
  });
});
