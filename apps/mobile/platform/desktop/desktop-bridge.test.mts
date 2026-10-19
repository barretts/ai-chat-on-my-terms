import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test, vi } from "vitest";

import { nativeArchiveFiles } from "../../composition/chat/archives/native.web";
import { isDesktopBridge } from "./bridge";
import { openDesktopDatabase } from "./database";
import { base64ToBytes, bytesToBase64 } from "./encoding";
import { createDesktopSecretStore } from "./secrets";
import { sanitizeDiagnosticText } from "../../features/diagnostics/sanitization";

interface FakeBackend {
  db: DatabaseSync;
  keyring: Map<string, string>;
  saved: { name: string; bytes: Uint8Array }[];
  canceled: boolean;
  commands: string[];
  execs: string[];
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

function isBlobEnvelope(
  value: unknown,
): value is { type: "blob"; base64: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "type" in value &&
    value.type === "blob" &&
    "base64" in value &&
    typeof value.base64 === "string"
  );
}

/** Wire DbValue → node:sqlite bind value, mirroring `to_sql_value` in desktop.rs. */
function decodeDbValue(value: unknown): string | number | null | Uint8Array {
  if (value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  if (isBlobEnvelope(value)) return base64ToBytes(value.base64);
  throw new Error(`Unsupported DbValue on the wire: ${JSON.stringify(value)}`);
}

/** node:sqlite row → wire row (BLOB columns as {"type":"blob","base64":...}). */
function encodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const encoded: Record<string, unknown> = { ...row };
  for (const [column, cell] of Object.entries(encoded)) {
    if (cell instanceof Uint8Array)
      encoded[column] = { type: "blob", base64: bytesToBase64(cell) };
  }
  return encoded;
}

/** Spec-faithful stand-in for the Rust db_*, secret_* and files_save commands. */
function createFakeBackend(): FakeBackend {
  const db = new DatabaseSync(":memory:");
  const keyring = new Map<string, string>();
  const backend: FakeBackend = {
    db,
    keyring,
    saved: [],
    canceled: false,
    commands: [],
    execs: [],
    async invoke(cmd, args = {}) {
      backend.commands.push(cmd);
      switch (cmd) {
        case "db_open":
          return "ok";
        case "db_exec": {
          const sql = String(args.sql);
          backend.execs.push(sql);
          db.exec(sql);
          return null;
        }
        case "db_run": {
          const params = (args.params as unknown[]).map(decodeDbValue);
          const info = db.prepare(String(args.sql)).run(...params);
          return {
            lastInsertRowId: Number(info.lastInsertRowid),
            changes: Number(info.changes),
          };
        }
        case "db_all": {
          const params = (args.params as unknown[]).map(decodeDbValue);
          return db
            .prepare(String(args.sql))
            .all(...params)
            .map((row) => encodeRow(row as Record<string, unknown>));
        }
        case "db_get": {
          const params = (args.params as unknown[]).map(decodeDbValue);
          const rows = db
            .prepare(String(args.sql))
            .all(...params)
            .map((row) => encodeRow(row as Record<string, unknown>));
          return rows.length > 0 ? rows[0]! : null;
        }
        case "secret_get":
          return keyring.get(String(args.account)) ?? null;
        case "secret_set":
          keyring.set(String(args.account), String(args.value));
          return null;
        case "secret_delete":
          keyring.delete(String(args.account));
          return null;
        case "files_save": {
          if (backend.canceled) return null;
          backend.saved.push({
            name: String(args.name),
            bytes: base64ToBytes(String(args.base64Data)),
          });
          return `C:\\Users\\fixture\\Desktop\\${String(args.name)}`;
        }
        default:
          throw new Error(`Unknown desktop command: ${cmd}`);
      }
    },
  };
  return backend;
}

/** Emulates the Tauri v2 runtime injecting `window.__TAURI_INTERNALS__`. */
function installBridge(backend: FakeBackend): void {
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {
      postMessage: () => {},
      transformCallback: () => 0,
      invoke: backend.invoke,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("the bridge is detected only inside a Tauri-injected webview", () => {
  assert.equal(isDesktopBridge(), false);
  installBridge(createFakeBackend());
  assert.equal(isDesktopBridge(), true);
  vi.stubGlobal("window", { isTauri: true });
  assert.equal(isDesktopBridge(), false);
});

interface NoteRow {
  id: number;
  body: string;
  data: Uint8Array | null;
  flag: number | null;
}

test("the SQLite adapter maps params, blobs and run results over the db_* wire", async () => {
  const backend = createFakeBackend();
  installBridge(backend);
  const database = await openDesktopDatabase();
  assert.equal(backend.commands[0], "db_open");

  await database.execAsync(`
    CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, data BLOB, flag INTEGER);
    INSERT INTO notes (body, data, flag) VALUES ('seed', X'00FF', 1);
  `);

  const inserted = await database.runAsync(
    "INSERT INTO notes (body, data, flag) VALUES (?, ?, ?)",
    "hello",
    new Uint8Array([1, 2, 3]),
    true,
  );
  assert.deepEqual(inserted, { lastInsertRowId: 2, changes: 1 });

  const rows = await database.getAllAsync<NoteRow>(
    "SELECT id, body, data, flag FROM notes ORDER BY id",
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[1]?.body, "hello");
  // The bound Uint8Array went out as base64 and came back revived.
  assert.ok(rows[1]?.data instanceof Uint8Array);
  assert.deepEqual(rows[1]?.data, new Uint8Array([1, 2, 3]));
  // Booleans travel as 0/1 integers.
  assert.equal(rows[1]?.flag, 1);
  assert.ok(rows[0]?.data instanceof Uint8Array);
  assert.deepEqual(rows[0]?.data, new Uint8Array([0x00, 0xff]));
  assert.deepEqual(
    await database.getAllAsync<NoteRow>(
      "SELECT id, body, data, flag FROM notes WHERE body = ?",
      "seed",
    ),
    [{ id: 1, body: "seed", data: new Uint8Array([0x00, 0xff]), flag: 1 }],
  );

  assert.deepEqual(
    await database.getFirstAsync<{ body: string }>(
      "SELECT body FROM notes WHERE body = ?",
      "seed",
    ),
    { body: "seed" },
  );
  assert.equal(
    await database.getFirstAsync("SELECT body FROM notes WHERE body = ?", "?"),
    null,
  );
});

test("transactions run BEGIN IMMEDIATE through the adapter and roll back on error", async () => {
  const backend = createFakeBackend();
  installBridge(backend);
  const database = await openDesktopDatabase();
  await database.execAsync(
    "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);",
  );

  await database.withTransactionAsync(async (transaction) => {
    assert.ok(transaction);
    await transaction.runAsync("INSERT INTO notes (body) VALUES (?)", "tx-a");
    await transaction.runAsync("INSERT INTO notes (body) VALUES (?)", "tx-b");
  });
  assert.ok(backend.execs.includes("BEGIN IMMEDIATE"));
  assert.ok(backend.execs.includes("COMMIT"));
  const countAfterCommit = await database.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM notes",
  );
  assert.equal(countAfterCommit?.n, 2);

  await assert.rejects(
    database.withTransactionAsync(async (transaction) => {
      assert.ok(transaction);
      await transaction.runAsync("INSERT INTO notes (body) VALUES (?)", "tx-c");
      throw new Error("rollback requested");
    }),
    /rollback requested/,
  );
  const countAfterRollback = await database.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM notes",
  );
  assert.equal(countAfterRollback?.n, 2);
  assert.ok(backend.execs.includes("ROLLBACK"));
});

test("the keyring store puts, resolves, scope-guards and deletes over secret_* commands", async () => {
  const backend = createFakeBackend();
  installBridge(backend);
  const secret = "Bearer keyring-fixture-3f9c2a";
  const writer = createDesktopSecretStore();
  const descriptor = await writer.put(
    "https://api.fixture.invalid",
    "Authorization",
    secret,
  );
  // Value and ownership index are two keyring accounts, both under the
  // mobile-provider-headers namespace (same as the Expo/web stores).
  const accounts = [...backend.keyring.keys()];
  assert.equal(accounts.length, 2);
  assert.ok(
    accounts.every((account) =>
      account.startsWith("locallab:mobile-provider-headers:secret:sec_"),
    ),
  );
  assert.ok(accounts.some((account) => account.endsWith(":value")));
  assert.ok(accounts.some((account) => account.endsWith(":owner")));

  const reopened = createDesktopSecretStore();
  // resolveHeaders returns a null-prototype frozen map; copy before comparing.
  assert.deepEqual(
    {
      ...(await reopened.resolveHeaders("https://api.fixture.invalid", [
        descriptor.ref,
      ])),
    },
    { authorization: secret },
  );
  await assert.rejects(
    reopened.resolveHeaders("https://other.fixture.invalid", [descriptor.ref]),
    { code: "host-mismatch" },
  );

  // Diagnostic-sanitization parity with the web store: the registered value
  // never survives diagnostic text.
  assert.equal(sanitizeDiagnosticText(secret), "[REDACTED]");

  await reopened.remove(descriptor.ref);
  assert.equal(backend.keyring.size, 0);
  await assert.rejects(
    writer.resolveHeaders("https://api.fixture.invalid", [descriptor.ref]),
    { code: "missing" },
  );
});

test("share saves through files_save, tolerates cancel, and still rejects bad names", async () => {
  const backend = createFakeBackend();
  installBridge(backend);
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x21]);
  await nativeArchiveFiles.share({
    name: "export.zip",
    mimeType: "application/zip",
    bytes,
  });
  assert.deepEqual(backend.saved, [{ name: "export.zip", bytes }]);

  // Cancel path: the Rust command resolves None; share() resolves quietly and
  // writes nothing.
  backend.canceled = true;
  await nativeArchiveFiles.share({
    name: "cancelled.zip",
    mimeType: "application/zip",
    bytes,
  });
  assert.equal(backend.saved.length, 1);
  assert.deepEqual(backend.saved[0]?.bytes, bytes);

  await assert.rejects(
    nativeArchiveFiles.share({
      name: "../escape.zip",
      mimeType: "application/zip",
      bytes,
    }),
    /Export filename is invalid/,
  );
  assert.ok(backend.commands.includes("files_save"));
});

test("bytesToBase64 survives payloads larger than the chunk boundary", () => {
  const big = new Uint8Array(0x8000 + 5).fill(0xab);
  assert.deepEqual(base64ToBytes(bytesToBase64(big)), big);
});
