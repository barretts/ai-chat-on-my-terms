import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { enabledLmStudioIntegrationRefs } from "@locallab/tools-mcp-lmstudio";
import { SQLiteLmStudioIntegrationStore } from "./lmstudio-integrations";

function memorySqlite(): SQLiteDatabasePort {
  const database = new DatabaseSync(":memory:");
  return {
    execAsync: async (sql) => {
      database.exec(sql);
    },
    runAsync: async (sql, ...values) => {
      database.prepare(sql).run(...values);
    },
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

it("adds, reloads and removes LM Studio integration rows", async () => {
  const store = new SQLiteLmStudioIntegrationStore(memorySqlite());
  const added = await store.add("playwright");
  expect(added.name).toBe("mcp/playwright");
  expect(added.label).toBe("playwright");
  expect(added.enabled).toBe(false);
  expect(await store.load()).toEqual([added]);
  await store.remove(added.id);
  expect(await store.load()).toEqual([]);
});

it("renaming an integration keeps the original reference", async () => {
  const store = new SQLiteLmStudioIntegrationStore(memorySqlite());
  const row = await store.add("mcp/filesystem", "old");
  await store.save({ ...row, label: "File tools" });
  const [renamed] = await store.load();
  expect(renamed?.id).toBe(row.id);
  expect(renamed?.name).toBe("mcp/filesystem");
  expect(renamed?.label).toBe("File tools");
  expect(enabledLmStudioIntegrationRefs([renamed!])).toEqual([]);
  await store.save({ ...renamed!, enabled: true });
  expect(enabledLmStudioIntegrationRefs(await store.load())).toEqual([
    "mcp/filesystem",
  ]);
});

it("rejects names that are not integrated server names", async () => {
  const store = new SQLiteLmStudioIntegrationStore(memorySqlite());
  for (const bad of ["", "https://example.com/mcp", "mcp/../x"])
    await expect(store.add(bad)).rejects.toThrow(/playwright|mcp\.json/);
  await expect(
    store.save({
      id: "00000000-0000-4000-8000-000000000001",
      name: "https://example.com/mcp",
      label: "smuggled",
      enabled: true,
    }),
  ).rejects.toThrow(/mcp.json/);
  await expect(
    store.save({
      id: "00000000-0000-4000-8000-000000000002",
      name: "mcp/ok",
      label: "x".repeat(120),
      enabled: true,
    }),
  ).rejects.toThrow(/display name/);
});
