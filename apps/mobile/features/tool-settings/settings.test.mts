import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import {
  DEFAULT_TOOL_GLOBAL_SETTINGS,
  SQLiteToolSettingsStore,
  TOOL_SETTINGS_CATALOG,
  resolveToolPolicy,
} from "./settings";

function sqlitePort(database: DatabaseSync): SQLiteDatabasePort {
  return {
    execAsync: async (sql) => {
      database.exec(sql);
    },
    runAsync: async (sql, ...values) => database.prepare(sql).run(...values),
    getFirstAsync: async <T,>(
      sql: string,
      ...values: (string | number | null | Uint8Array)[]
    ) => (database.prepare(sql).get(...values) as T) ?? null,
    getAllAsync: async <T,>(
      sql: string,
      ...values: (string | number | null | Uint8Array)[]
    ) => (database.prepare(sql).all(...values) as T[]),
    withTransactionAsync: async (work) => {
      await work();
    },
  };
}

describe("tool settings store", () => {
  it("defaults load with no row and a saved roundtrip survives reopening", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      const port = sqlitePort(database);
      const store = new SQLiteToolSettingsStore(port);
      expect(await store.load()).toEqual(DEFAULT_TOOL_GLOBAL_SETTINGS);
      await store.save({
        globalEnabled: false,
        roundLimit: 12,
        labels: { web_search: "Dr. Web (search)" },
        tools: { web_fetch: false, current_time: true },
      });
      expect(
        await new SQLiteToolSettingsStore(port).load(),
      ).toEqual({
        globalEnabled: false,
        roundLimit: 12,
        labels: { web_search: "Dr. Web (search)" },
        tools: { web_fetch: false, current_time: true },
      });
    } finally {
      database.close();
    }
  });

  it("rejects invalid round limits in raw JSON on load and on save", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      const port = sqlitePort(database);
      const store = new SQLiteToolSettingsStore(port);
      await store.load();
      for (const roundLimit of ["0", "51", "1.5", '"x"']) {
        database.exec(
          `INSERT OR REPLACE INTO tool_settings (singleton,settings) VALUES (1,'{"globalEnabled":true,"roundLimit":${roundLimit}}')`,
        );
        await expect(store.load()).rejects.toThrow(/round limit/i);
      }
      await expect(
        store.save({ ...DEFAULT_TOOL_GLOBAL_SETTINGS, roundLimit: 0 }),
      ).rejects.toThrow(/round limit/i);
      await expect(
        store.save({ ...DEFAULT_TOOL_GLOBAL_SETTINGS, roundLimit: 51 }),
      ).rejects.toThrow(/round limit/i);
      await expect(
        store.save({ ...DEFAULT_TOOL_GLOBAL_SETTINGS, roundLimit: 1.5 }),
      ).rejects.toThrow(/round limit/i);
    } finally {
      database.close();
    }
  });

  it("rejects unknown tool keys in stored settings", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      const port = sqlitePort(database);
      const store = new SQLiteToolSettingsStore(port);
      await store.load();
      database.exec(
        `INSERT OR REPLACE INTO tool_settings (singleton,settings) VALUES (1,'{"globalEnabled":true,"roundLimit":6,"tools":{"evil_tool":true}}')`,
      );
      await expect(store.load()).rejects.toThrow(/unknown tool name/i);
      await expect(
        store.save({
          ...DEFAULT_TOOL_GLOBAL_SETTINGS,
          tools: { "not-a-tool": false },
        }),
      ).rejects.toThrow(/unknown tool name/i);
    } finally {
      database.close();
    }
  });

  it("rejects oversized settings instead of storing them", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      const port = sqlitePort(database);
      const store = new SQLiteToolSettingsStore(port);
      const huge = {
        ...DEFAULT_TOOL_GLOBAL_SETTINGS,
        labels: Object.fromEntries(
          Object.keys(TOOL_SETTINGS_CATALOG).map((name) => [
            name,
            "x".repeat(1400),
          ]),
        ),
      };
      await expect(store.save(huge)).rejects.toThrow(/8192 bytes/);
      expect(await store.load()).toEqual(DEFAULT_TOOL_GLOBAL_SETTINGS);
    } finally {
      database.close();
    }
  });

  it("rejects control-char labels but accepts plain display names", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      const port = sqlitePort(database);
      const store = new SQLiteToolSettingsStore(port);
      await expect(
        store.save({
          ...DEFAULT_TOOL_GLOBAL_SETTINGS,
          labels: { web_search: "bad\tname\u0000" },
        }),
      ).rejects.toThrow(/label/i);
      await store.save({
        ...DEFAULT_TOOL_GLOBAL_SETTINGS,
        labels: { web_search: "Dr. Web (search)" },
      });
      expect(await store.load()).toMatchObject({
        labels: { web_search: "Dr. Web (search)" },
      });
    } finally {
      database.close();
    }
  });

  it("conversation overrides save, load, and clear back to inherit", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      const port = sqlitePort(database);
      const store = new SQLiteToolSettingsStore(port);
      expect(await store.loadConversation("chat-1")).toEqual({});
      await store.saveConversation("chat-1", {
        globalEnabled: false,
        tools: { web_search: false },
      });
      expect(await store.loadConversation("chat-1")).toEqual({
        globalEnabled: false,
        tools: { web_search: false },
      });
      await store.saveConversation("chat-1", { globalEnabled: true });
      expect(await store.loadConversation("chat-1")).toEqual({
        globalEnabled: true,
      });
      await store.clearConversation("chat-1");
      expect(await store.loadConversation("chat-1")).toEqual({});
      await expect(
        store.saveConversation("chat-2", { tools: { nope: true } }),
      ).rejects.toThrow(/unknown tool name/i);
    } finally {
      database.close();
    }
  });
});

describe("resolveToolPolicy", () => {
  const capable = { tools: "yes" as const };
  const on = { ...DEFAULT_TOOL_GLOBAL_SETTINGS };
  const off = { ...DEFAULT_TOOL_GLOBAL_SETTINGS, globalEnabled: false };

  it("participant beats chat, chat beats global, in both directions", () => {
    expect(
      resolveToolPolicy({
        global: off,
        conversation: { globalEnabled: true },
        participant: { globalEnabled: false },
        capabilities: capable,
      }),
    ).toMatchObject({ engaged: false, effectiveFrom: "participant" });
    expect(
      resolveToolPolicy({
        global: off,
        conversation: { globalEnabled: false },
        participant: { globalEnabled: true },
        capabilities: capable,
      }),
    ).toMatchObject({ engaged: true, effectiveFrom: "participant" });
    expect(
      resolveToolPolicy({
        global: on,
        conversation: { globalEnabled: false },
        participant: null,
        capabilities: capable,
      }),
    ).toMatchObject({ engaged: false, effectiveFrom: "chat" });
    expect(
      resolveToolPolicy({
        global: off,
        conversation: { globalEnabled: true },
        capabilities: capable,
      }),
    ).toMatchObject({ engaged: true, effectiveFrom: "chat" });
    expect(
      resolveToolPolicy({
        global: on,
        conversation: null,
        capabilities: capable,
      }),
    ).toMatchObject({ engaged: true, effectiveFrom: "global" });
    expect(
      resolveToolPolicy({
        global: off,
        conversation: {},
        capabilities: capable,
      }),
    ).toMatchObject({ engaged: false, effectiveFrom: "global" });
  });

  it("capabilities no or unknown keeps tools disengaged even when everything is on", () => {
    for (const tools of ["no", "unknown"] as const) {
      const policy = resolveToolPolicy({
        global: on,
        conversation: { globalEnabled: true },
        participant: { globalEnabled: true },
        capabilities: { tools },
      });
      expect(policy.engaged).toBe(false);
      expect(policy.effectiveFrom).toBe("participant");
    }
  });

  it("conversation false beats global true; global false hides; unset inherits true", () => {
    const hidden = resolveToolPolicy({
      global: { ...on, tools: { web_fetch: false } },
      conversation: { tools: { web_search: false } },
      capabilities: capable,
    });
    expect(hidden.tools.web_search).toBe(false);
    expect(hidden.tools.web_fetch).toBe(false);
    expect(hidden.tools.current_time).toBe(true);
    const revived = resolveToolPolicy({
      global: { ...on, tools: { web_search: false } },
      conversation: { tools: { web_search: true } },
      capabilities: capable,
    });
    expect(revived.tools.web_search).toBe(true);
    const plain = resolveToolPolicy({
      global: on,
      conversation: null,
      capabilities: capable,
    });
    for (const name of Object.keys(TOOL_SETTINGS_CATALOG)) {
      expect(plain.tools[name]).toBe(true);
    }
  });

  it("round limit passes through from global, including null", () => {
    expect(
      resolveToolPolicy({
        global: { ...on, roundLimit: 3 },
        conversation: null,
        capabilities: capable,
      }).roundLimit,
    ).toBe(3);
    expect(
      resolveToolPolicy({
        global: { ...on, roundLimit: null },
        conversation: { tools: { current_time: false } },
        capabilities: capable,
      }).roundLimit,
    ).toBe(null);
  });
});
