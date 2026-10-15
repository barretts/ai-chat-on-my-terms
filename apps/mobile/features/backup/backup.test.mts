import { describe, expect, it } from "vitest";
import { nodeBackupCrypto } from "@locallab/backup/node";
import type { BackupObjectStorePort } from "./client";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { mobileArchiveZip } from "../../composition/chat/archives/zip";
import { createBackupClient } from "./client";
import { snapshotDatabase } from "./db-snapshot";

type Row = Record<string, unknown>;

/** In-memory double that understands exactly the SQL the snapshot/restore
 * paths emit; withTransactionAsync restores a deep copy on throw, like a
 * real transaction. */
class FakeDb implements SQLiteDatabasePort {
  readonly tables = new Map<string, Row[]>();
  failOnInsert: string | null = null;

  constructor(rows: Record<string, Row[]>) {
    for (const [name, list] of Object.entries(rows))
      this.tables.set(name, list);
  }

  async execAsync(): Promise<void> {
    return undefined;
  }

  async runAsync(sql: string, ...params: unknown[]): Promise<unknown> {
    const del = /^DELETE FROM "([A-Za-z0-9_]+)"$/.exec(sql);
    if (del) {
      this.tables.set(del[1] ?? "", []);
      return undefined;
    }
    const ins =
      /^INSERT INTO "([A-Za-z0-9_]+)" \(([^)]*)\) VALUES \((\?\s*(?:,\s*\?\s*)*)\)$/.exec(
        sql,
      );
    if (ins) {
      const table = ins[1] ?? "";
      if (this.failOnInsert === table)
        throw new Error(`insert failed for ${table}`);
      const columns = (ins[2] ?? "")
        .split(",")
        .map((c) => c.trim().replace(/"/g, ""));
      const row: Row = {};
      columns.forEach((column, i) => {
        row[column] = params[i] ?? null;
      });
      const list = this.tables.get(table);
      if (list === undefined) throw new Error(`no such table ${table}`);
      list.push(row);
      return undefined;
    }
    throw new Error(`unexpected sql: ${sql}`);
  }

  async getFirstAsync<T>(sql: string): Promise<T | null> {
    const count = /^SELECT COUNT\(\*\) AS n FROM "([A-Za-z0-9_]+)"$/.exec(sql);
    if (count) return { n: this.tables.get(count[1] ?? "")?.length ?? 0 } as T;
    throw new Error(`unexpected sql: ${sql}`);
  }

  async getAllAsync<T>(sql: string): Promise<T[]> {
    if (sql.startsWith("SELECT name FROM sqlite_master WHERE type = 'table'"))
      return [...this.tables.keys()].sort().map((name) => ({ name })) as T[];
    const all = /^SELECT \* FROM "([A-Za-z0-9_]+)"$/.exec(sql);
    if (all) return structuredClone(this.tables.get(all[1] ?? "") ?? []) as T[];
    throw new Error(`unexpected sql: ${sql}`);
  }

  async withTransactionAsync(
    work: (transaction?: SQLiteDatabasePort) => Promise<void>,
  ): Promise<void> {
    const saved = new Map(
      [...this.tables].map(([name, rows]) => [name, structuredClone(rows)]),
    );
    try {
      await work(this);
    } catch (error) {
      this.tables.clear();
      for (const [name, rows] of saved) this.tables.set(name, rows);
      throw error;
    }
  }

  dump(): Record<string, Row[]> {
    return Object.fromEntries(structuredClone(this.tables));
  }
}

const crypto = nodeBackupCrypto();

const FAST_KDF = {
  memoryKiB: 1024,
  iterations: 1,
  parallelism: 1,
  keyLengthBytes: 32,
};

function rows(): Record<string, Row[]> {
  return {
    conversations: [
      { id: "c1", title: "one", thumb: new Uint8Array([9, 8, 7]) },
      { id: "c2", title: null, thumb: null },
    ],
    persona_profiles: [{ id: "p1", name: "helper" }],
    workspace_files: [
      { path: "attachments/photo.png", bytes: new Uint8Array([1, 2]) },
    ],
  };
}

function makeStore(): BackupObjectStorePort {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(id, bytes) {
      objects.set(id, bytes);
    },
    async get(id) {
      return objects.get(id) ?? null;
    },
  };
}

function clientFor(db: FakeDb, store: BackupObjectStorePort) {
  return createBackupClient({
    db,
    crypto,
    zip: mobileArchiveZip,
    store,
    kdfParams: FAST_KDF,
    now: () => new Date("2026-10-14T00:00:00.000Z"),
  });
}

describe("encrypted backup client", () => {
  it("snapshots every table into sorted zip entries", async () => {
    const entries = await snapshotDatabase(new FakeDb(rows()));
    expect(entries.map((entry) => entry.path)).toEqual([
      "db/conversations.json",
      "db/persona_profiles.json",
      "db/workspace_files.json",
    ]);
  });

  it("creates, uploads, downloads and restores the whole workspace", async () => {
    const store = makeStore();
    const db = new FakeDb(rows());
    const client = clientFor(db, store);
    const { bytes, preview } = await client.create("longer passphrase");
    expect(preview.manifest.counts.chats).toBe(2);
    await client.upload("ws-1", bytes);
    expect(await client.download("ws-1")).toEqual(bytes);

    const mutated = new FakeDb(rows());
    await mutated.runAsync('DELETE FROM "conversations"');
    mutated.tables.set("persona_profiles", [{ id: "p2", name: "drift" }]);
    const restored = clientFor(mutated, store);
    const downloaded = await restored.download("ws-1");
    expect(downloaded).not.toBeNull();
    const after = await restored.restore(downloaded!, "longer passphrase");
    expect(after.manifest.createdAt).toBe("2026-10-14T00:00:00.000Z");
    const final = mutated.dump();
    expect(Object.keys(final.conversations ?? {})).toEqual(["0", "1"]);
    expect(final.conversations?.[0]?.title).toBe("one");
    expect((final.conversations?.[0]?.thumb as Uint8Array)[0]).toBe(9);
    expect(final.persona_profiles).toEqual([{ id: "p1", name: "helper" }]);
  });

  it("a wrong passphrase rejects and changes nothing in the database", async () => {
    const store = makeStore();
    const db = new FakeDb(rows());
    const client = clientFor(db, store);
    const { bytes } = await client.create("right passphrase");
    const untouched = db.dump();
    await expect(client.restore(bytes, "wrong passphrase")).rejects.toThrow();
    expect(db.dump()).toEqual(untouched);
  });

  it("tampering with the ciphertext fails the tag check before restore", async () => {
    const store = makeStore();
    const db = new FakeDb(rows());
    const client = clientFor(db, store);
    const { bytes } = await client.create("right passphrase");
    const tampered = Uint8Array.from(bytes);
    const idx = tampered.length - 5;
    tampered[idx] = (tampered[idx] ?? 0) ^ 0xff;
    const untouched = db.dump();
    await expect(
      client.restore(tampered, "right passphrase"),
    ).rejects.toThrow();
    expect(db.dump()).toEqual(untouched);
  });

  it("a failing row insert rolls the whole restore back", async () => {
    const store = makeStore();
    const db = new FakeDb(rows());
    const client = clientFor(db, store);
    const { bytes } = await client.create("right passphrase");
    const target = new FakeDb({
      conversations: [],
      persona_profiles: [],
      workspace_files: [],
    });
    target.failOnInsert = "persona_profiles";
    const targetClient = clientFor(target, store);
    await expect(
      targetClient.restore(bytes, "right passphrase"),
    ).rejects.toThrow(/insert failed/);
    expect(target.dump()).toEqual({
      conversations: [],
      persona_profiles: [],
      workspace_files: [],
    });
  });
});
