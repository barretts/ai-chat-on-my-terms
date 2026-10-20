import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { SQLiteChatSettingsStore } from "./settings-store";

function makeDb(): { native: DatabaseSync; db: SQLiteDatabasePort } {
  const native = new DatabaseSync(":memory:");
  return {
    native,
    db: {
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
    },
  };
}

describe("SQLite chat settings composition", () => {
  it("persists false and keeps model/persona/chat scopes isolated", async () => {
    const { native, db } = makeDb();
    try {
      await SQLiteChatSettingsStore.initialize(db);
      const store = new SQLiteChatSettingsStore(db, "conversation-a");
      await store.savePreset(
        "global",
        { reasoning: false, temperature: 0.7 },
        {},
      );
      await store.savePreset(
        "model",
        { max_output_tokens: 512 },
        { modelId: "model-a" },
      );
      await store.savePreset(
        "persona",
        { json: false },
        { personaId: "persona-a" },
      );
      await store.savePreset("chat", { top_p: 0.3 }, {});

      const loaded = await store.loadPresets({
        modelId: "model-a",
        personaId: "persona-a",
      });
      assert.deepEqual(loaded.global?.explicitlySet, {
        reasoning: false,
        temperature: 0.7,
      });
      assert.deepEqual(loaded.model?.explicitlySet, { max_output_tokens: 512 });
      assert.deepEqual(loaded.persona?.explicitlySet, { json: false });
      assert.deepEqual(loaded.chat?.explicitlySet, { top_p: 0.3 });
      assert.deepEqual(
        await store
          .loadPresets({ modelId: "model-b" })
          .then((value) => value.model),
        undefined,
      );
      assert.deepEqual(
        await store
          .loadPresets({ personaId: "persona-b" })
          .then((value) => value.persona),
        undefined,
      );

      const otherChat = new SQLiteChatSettingsStore(db, "conversation-b");
      assert.equal((await otherChat.loadPresets({})).chat, undefined);
      await assert.rejects(
        store.savePreset("model", { temperature: 1 }, {}),
        /model ID/,
      );
      await assert.rejects(
        store.savePreset("persona", { json: false }, {}),
        /persona ID/,
      );
    } finally {
      native.close();
    }
  });

  it("stores chat appearance independently per conversation", async () => {
    const { native, db } = makeDb();
    try {
      await SQLiteChatSettingsStore.initialize(db);
      const first = new SQLiteChatSettingsStore(db, "conversation-a");
      const second = new SQLiteChatSettingsStore(db, "conversation-b");
      await first.saveAppearance("conversation-a", {
        background: "#123456",
        avatar: "blob:avatar-a",
        avatarAttachmentId: "00000000-0000-4000-8000-0000000000a7",
      });
      assert.deepEqual(await first.loadAppearance("conversation-a"), {
        background: "#123456",
        avatar: "blob:avatar-a",
        avatarAttachmentId: "00000000-0000-4000-8000-0000000000a7",
      });
      assert.deepEqual(await second.loadAppearance("conversation-b"), {});
    } finally {
      native.close();
    }
  });

  it("restores the selected context policy without changing another chat", async () => {
    const { native, db } = makeDb();
    try {
      await SQLiteChatSettingsStore.initialize(db);
      const store = new SQLiteChatSettingsStore(db, "conversation-a");
      assert.equal(await store.loadContextPolicy(), "roll");
      await store.saveContextPolicy("cut-middle");
      assert.equal(
        await new SQLiteChatSettingsStore(
          db,
          "conversation-a",
        ).loadContextPolicy(),
        "cut-middle",
      );
      assert.equal(
        await new SQLiteChatSettingsStore(
          db,
          "conversation-b",
        ).loadContextPolicy(),
        "roll",
      );
      await assert.rejects(
        store.saveContextPolicy("invalid" as never),
        /context policy/i,
      );
      assert.equal(await store.loadContextPolicy(), "cut-middle");
    } finally {
      native.close();
    }
  });
});
