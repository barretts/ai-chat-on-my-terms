/** Whole-database snapshot and transactional restore for encrypted backups.
 * Table names come from sqlite_master; blob columns round-trip as base64. */
import type { SqliteBindValue } from "@locallab/storage-sqlite-core";
import type { ZipEntry } from "@locallab/archives";
import type { RestoreTransaction } from "@locallab/backup";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

export type { RestoreTransaction };

const SAFE_TABLE = /^[A-Za-z0-9_]+$/;

export async function snapshotDatabase(
  db: SQLiteDatabasePort,
): Promise<ZipEntry[]> {
  const tables = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const entries: ZipEntry[] = [];
  for (const table of tables) {
    if (!SAFE_TABLE.test(table.name)) continue;
    const rows = await db.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM "${table.name}"`,
    );
    entries.push({
      path: `db/${table.name}.json`,
      bytes: new TextEncoder().encode(JSON.stringify(rows, encodeBlob)),
    });
  }
  return entries;
}

export async function snapshotCounts(db: SQLiteDatabasePort): Promise<{
  chats: number;
  personas: number;
  attachments: number;
}> {
  const count = async (table: string) => {
    try {
      const row = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM "${table}"`,
      );
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  };
  return {
    chats: await count("conversations"),
    personas: await count("persona_profiles"),
    attachments: await count("workspace_files"),
  };
}

/** Atomic apply: every DELETE/INSERT happens inside one transaction, so a
 * failure (corrupt row, schema mismatch) leaves the database untouched. */
export function restoreTransaction(db: SQLiteDatabasePort): RestoreTransaction {
  let staged: readonly ZipEntry[] = [];
  return {
    async begin() {
      staged = [];
    },
    async stage(entries) {
      staged = entries.filter((entry) => entry.path.startsWith("db/"));
    },
    async commit() {
      await db.withTransactionAsync(async (txRaw) => {
        const tx = (txRaw ?? db) as SQLiteDatabasePort;
        for (const entry of staged) {
          const table = entry.path.slice("db/".length, -".json".length);
          if (!SAFE_TABLE.test(table))
            throw new Error(`unsafe restore table name "${table}"`);
          const rows = JSON.parse(
            new TextDecoder().decode(entry.bytes),
            decodeBlob,
          ) as Record<string, unknown>[];
          await tx.runAsync(`DELETE FROM "${table}"`);
          if (rows.length === 0) continue;
          const columns = Object.keys(rows[0] ?? {});
          if (columns.length === 0) continue;
          for (const row of rows) {
            const values = columns.map((column) =>
              toBindValue(row[column] ?? null),
            );
            await tx.runAsync(
              `INSERT INTO "${table}" (${columns
                .map((column) => `"${column}"`)
                .join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
              ...values,
            );
          }
        }
      });
    },
    async rollback() {
      staged = [];
    },
  };
}

const B64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64_CHARS[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64_CHARS[b2 & 63];
  }
  return out;
}

function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_CHARS.indexOf(clean[i] ?? "");
    const c1 = B64_CHARS.indexOf(clean[i + 1] ?? "");
    const c2 = B64_CHARS.indexOf(clean[i + 2] ?? "");
    const c3 = B64_CHARS.indexOf(clean[i + 3] ?? "");
    out[o++] = (c0 << 2) | (c1 >> 4);
    if (c2 >= 0) out[o++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (c3 >= 0) out[o++] = ((c2 & 3) << 6) | c3;
  }
  return out.subarray(0, o);
}

function encodeBlob(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array)
    return { __blob__: bytesToBase64(value) };
  return value;
}

function decodeBlob(_key: string, value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    "__blob__" in value &&
    typeof (value as { __blob__: unknown }).__blob__ === "string"
  )
    return base64ToBytes((value as { __blob__: string }).__blob__);
  return value;
}

function toBindValue(value: unknown): SqliteBindValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (value instanceof Uint8Array) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}
