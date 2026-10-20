import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applySQLiteMigrations,
  migrateEmbeddedSQLite,
  EMBEDDED_SCHEMA_VERSION,
  type SQLiteMigrationDatabase,
} from "../embedded.js";
import { EMBEDDED_MIGRATIONS } from "../embedded-data.generated.js";
import {
  EMBEDDED_OUTPUT,
  generatedEmbeddedSource,
} from "../generate-embedded.js";

function adapter(db: DatabaseSync, trace?: string[]): SQLiteMigrationDatabase {
  return {
    exec: async (sql) => {
      trace?.push(sql);
      db.exec(sql);
    },
    all: async <T extends Record<string, unknown>>(sql: string) =>
      db.prepare(sql).all() as T[],
    transaction: async <T>(work: () => Promise<T>) => {
      db.exec("BEGIN IMMEDIATE");
      trace?.push("BEGIN IMMEDIATE");
      try {
        const value = await work();
        db.exec("COMMIT");
        trace?.push("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        trace?.push("ROLLBACK");
        throw error;
      }
    },
  };
}

function populateCore(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO providers(id,kind,name) VALUES ('provider','local','Prior provider');
    INSERT INTO models(id,provider_id,name) VALUES ('model','provider','exact-model');
    INSERT INTO conversations(id,title) VALUES ('conversation','Prior conversation');
    INSERT INTO runs(id,conversation_id,model_id,status,parameters_json) VALUES ('run','conversation','model','completed','{"temperature":0.4}');
    INSERT INTO messages(id,conversation_id,role,parts_json,sequence,run_id) VALUES ('message','conversation','assistant','[{"type":"text","text":"Saved private answer"}]',0,'run');
    INSERT INTO jobs(id,run_id,kind,status) VALUES ('job','run','prior-download','running');
  `);
}

function ledger(db: DatabaseSync) {
  return db
    .prepare("SELECT version,name FROM schema_migrations ORDER BY version")
    .all();
}
function schema(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
    )
    .all();
}

test("fresh embedded database applies the complete static chain and remains idempotent", async () => {
  const db = new DatabaseSync(":memory:");
  const trace: string[] = [];
  try {
    assert.equal(EMBEDDED_SCHEMA_VERSION, 9);
    assert.equal(await migrateEmbeddedSQLite(adapter(db, trace)), 9);
    const before = schema(db);
    assert.equal(await migrateEmbeddedSQLite(adapter(db, trace)), 9);
    assert.deepEqual(schema(db), before);
    assert.deepEqual(
      ledger(db).map((row) => ({ ...row })),
      EMBEDDED_MIGRATIONS.map(({ version, name }) => ({ version, name })),
    );
    for (const name of [
      "persona_profiles",
      "memory_items",
      "memory_extraction_runs",
      "arena_runs",
      "arena_contestants",
      "tool_engine_invocations",
    ])
      assert.ok(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(name),
        name,
      );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(trace[0], "PRAGMA foreign_keys = ON");
  } finally {
    db.close();
  }
});

test("populated unversioned first-run database is adopted atomically and survives reopen", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "locallab-embedded-migrations-"),
  );
  const path = join(directory, "prior-app.sqlite");
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec(
      await readFile(
        new URL("../fixtures/unversioned-first-run.sql", import.meta.url),
        "utf8",
      ),
    );
    db.exec(
      await readFile(
        new URL("../fixtures/unversioned-chat-extensions.sql", import.meta.url),
        "utf8",
      ),
    );
    populateCore(db);
    db.exec(
      "INSERT INTO first_run_chat_settings(mode,conversation_id,model_id,model_record_id,connection_id) VALUES ('local','conversation','blob:managed-model','model','exact-connection')",
    );
    db.exec(`
      INSERT INTO chat_history_allocations(allocation_key,conversation_id,created_at) VALUES ('first-run-chat:local:v1','conversation','2026-09-26T12:00:00Z');
      INSERT INTO chat_history_metadata(conversation_id,model_id,last_used_at) VALUES ('conversation','blob:managed-model','2026-09-26T12:00:00Z');
      INSERT INTO response_variants(id,message_id,generation,content_json,model_id,created_at,selected) VALUES ('variant','message',0,'[{"type":"text","text":"Saved selected variant"}]','blob:managed-model','2026-09-26T12:00:00Z',1);
      INSERT INTO managed_blobs(id,sha256,mime_type,byte_length,managed_path,created_at) VALUES ('blob','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','text/plain',8,'managed/prior.txt','2026-09-26T12:00:00Z');
      INSERT INTO blob_references(blob_id,owner_type,owner_id) VALUES ('blob','other','attachment:attachment');
      INSERT INTO chat_attachments(id,blob_ref,descriptor_json) VALUES ('attachment','blob','{"originalName":"prior.txt","extractedText":"Original"}');
      INSERT INTO chat_attachment_owners(owner_id,attachment_id) VALUES ('conversation','attachment');
      INSERT INTO generation_lifecycle(run_id,conversation_id,execution,state,partial_text,updated_at) VALUES ('run','conversation','local','completed','Saved private answer','2026-09-26T12:00:00Z');
    `);
    const extensionTables = [
      "chat_history_allocations",
      "chat_history_metadata",
      "response_variants",
      "managed_blobs",
      "blob_references",
      "chat_attachments",
      "chat_attachment_owners",
      "generation_lifecycle",
    ];
    const extensionRows = extensionTables.map((table) =>
      db!.prepare(`SELECT * FROM ${table}`).all(),
    );
    const message = db
      .prepare("SELECT * FROM messages WHERE id='message'")
      .get();
    const settings = db.prepare("SELECT * FROM first_run_chat_settings").all();
    const baselineTables = db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('providers','models','conversations','messages','runs','jobs') ORDER BY name",
      )
      .all();
    const trace: string[] = [];
    assert.equal(await migrateEmbeddedSQLite(adapter(db, trace)), 9);
    const stampIndex = trace.findIndex((sql) =>
      sql.includes("VALUES (1,'0001-core')"),
    );
    assert.ok(stampIndex > 0);
    assert.equal(
      trace.slice(0, stampIndex).filter((sql) => sql === "BEGIN IMMEDIATE")
        .length,
      1,
    );
    assert.equal(trace.slice(0, stampIndex).includes("COMMIT"), false);
    assert.deepEqual(
      db.prepare("SELECT * FROM messages WHERE id='message'").get(),
      message,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM first_run_chat_settings").all(),
      settings,
    );
    assert.deepEqual(
      extensionTables.map((table) =>
        db!.prepare(`SELECT * FROM ${table}`).all(),
      ),
      extensionRows,
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('providers','models','conversations','messages','runs','jobs') ORDER BY name",
        )
        .all(),
      baselineTables,
    );
    db.close();
    db = new DatabaseSync(path);
    assert.equal(await migrateEmbeddedSQLite(adapter(db)), 9);
    assert.deepEqual(
      db.prepare("SELECT * FROM messages WHERE id='message'").get(),
      message,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM first_run_chat_settings").all(),
      settings,
    );
    assert.deepEqual(
      extensionTables.map((table) =>
        db!.prepare(`SELECT * FROM ${table}`).all(),
      ),
      extensionRows,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const previousVersion of [1, 3]) {
  test(`populated ledger version ${previousVersion} upgrades to the full chain without rewriting prior records`, async () => {
    const db = new DatabaseSync(":memory:");
    try {
      assert.equal(
        await applySQLiteMigrations(
          adapter(db),
          EMBEDDED_MIGRATIONS.slice(0, previousVersion),
        ),
        previousVersion,
      );
      populateCore(db);
      if (previousVersion === 3)
        db.exec(
          "INSERT INTO personas(id,name,prompt) VALUES ('old-persona','Prior persona','Keep this profile'); INSERT INTO arena_sessions(id,status,config_json) VALUES ('old-arena','completed','{\"preserve\":true}')",
        );
      const before = db.prepare("SELECT * FROM messages").all();
      assert.equal(await migrateEmbeddedSQLite(adapter(db)), 9);
      assert.equal(await migrateEmbeddedSQLite(adapter(db)), 9);
      assert.deepEqual(db.prepare("SELECT * FROM messages").all(), before);
      if (previousVersion === 3) {
        assert.equal(
          db
            .prepare("SELECT prompt FROM personas WHERE id='old-persona'")
            .get()!.prompt,
          "Keep this profile",
        );
        assert.equal(
          db
            .prepare(
              "SELECT config_json FROM arena_sessions WHERE id='old-arena'",
            )
            .get()!.config_json,
          '{"preserve":true}',
        );
      }
    } finally {
      db.close();
    }
  });
}

test("partial baseline adoption rejects without adding a ledger or feature tables", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE providers(id TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL,name TEXT NOT NULL)",
    );
    const before = schema(db);
    await assert.rejects(
      migrateEmbeddedSQLite(adapter(db)),
      /Partial unversioned core schema/,
    );
    assert.deepEqual(schema(db), before);
  } finally {
    db.close();
  }
});

test("baseline SQL checks reject altered CHECK constraints even with matching columns and indexes", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const core = EMBEDDED_MIGRATIONS[0].sql.replace(
      "CHECK (role IN ('system', 'developer', 'user', 'assistant', 'tool'))",
      "CHECK (role IN ('system', 'developer', 'user', 'assistant', 'tool', 'unsafe-role'))",
    );
    assert.notEqual(core, EMBEDDED_MIGRATIONS[0].sql);
    db.exec(core);
    populateCore(db);
    const before = schema(db);
    await assert.rejects(migrateEmbeddedSQLite(adapter(db)), /SQL constraints/);
    assert.deepEqual(schema(db), before);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM messages").get()!.count,
      1,
    );
  } finally {
    db.close();
  }
});

test("baseline adoption rejects missing, changed and additional indexes", async () => {
  for (const change of [
    "DROP INDEX messages_conversation_created",
    "DROP INDEX messages_conversation_created; CREATE INDEX messages_conversation_created ON messages(sequence,conversation_id)",
    "CREATE UNIQUE INDEX unexpected_message_uniqueness ON messages(role)",
  ]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(EMBEDDED_MIGRATIONS[0].sql);
      db.exec(change);
      const before = schema(db);
      await assert.rejects(
        migrateEmbeddedSQLite(adapter(db)),
        /schema mismatch|Partial unversioned/,
      );
      assert.deepEqual(schema(db), before);
    } finally {
      db.close();
    }
  }
});

test("unversioned adoption rejects existing foreign key violations without stamping core", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(EMBEDDED_MIGRATIONS[0].sql);
    db.exec(
      "PRAGMA foreign_keys=OFF; INSERT INTO messages(id,conversation_id,role,parts_json,sequence) VALUES ('orphan','missing-parent','user','[]',0)",
    );
    const before = schema(db);
    await assert.rejects(
      migrateEmbeddedSQLite(adapter(db)),
      /foreign key violations/,
    );
    assert.deepEqual(schema(db), before);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM messages").get()!.count,
      1,
    );
  } finally {
    db.close();
  }
});

test("failed additive migration rolls back DDL and ledger together", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    await migrateEmbeddedSQLite(adapter(db));
    const before = ledger(db);
    await assert.rejects(
      applySQLiteMigrations(adapter(db), [
        ...EMBEDDED_MIGRATIONS,
        {
          version: 10,
          name: "0010-failure-fixture",
          sql: "CREATE TABLE rollback_fixture(id TEXT); INVALID SQL",
        },
      ]),
      /syntax error/,
    );
    assert.deepEqual(ledger(db), before);
    assert.equal(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name='rollback_fixture'")
        .get(),
      undefined,
    );
  } finally {
    db.close();
  }
});

test("static embedded SQL matches registered files and its mobile imports resolve without Node URL evaluation", async () => {
  assert.equal(
    await readFile(EMBEDDED_OUTPUT, "utf8"),
    await generatedEmbeddedSource(),
  );
  for (const file of [
    "embedded.ts",
    "embedded-data.generated.ts",
    "apply.ts",
    "baseline.ts",
  ]) {
    const sourceUrl = new URL(`../${file}`, import.meta.url);
    const source = await readFile(sourceUrl, "utf8");
    assert.doesNotMatch(source, /\bnode:|import\.meta|new URL\s*\(/, file);
    assert.doesNotMatch(
      source,
      /(?:from\s+|import\s+)["'][^"']*(?:registry|full|runner|generate-embedded)/,
      file,
    );
    // Metro resolves an explicit .js import literally. tsx's .js-to-.ts
    // remapping can otherwise hide a missing native source file in Node tests.
    for (const [, specifier] of source.matchAll(
      /(?:from\s+|import\s+)["'](\.[^"']+)["']/g,
    )) {
      const candidates = /\.[cm]?[jt]sx?$/.test(specifier!)
        ? [new URL(specifier!, sourceUrl)]
        : [".ts", ".tsx", ".js", ".jsx"].map(
            (extension) => new URL(`${specifier}${extension}`, sourceUrl),
          );
      const resolved = await Promise.all(
        candidates.map((candidate) =>
          access(candidate).then(
            () => true,
            () => false,
          ),
        ),
      );
      assert.ok(
        resolved.some(Boolean),
        `${file} import ${specifier} must resolve to an existing source file`,
      );
    }
  }
});
