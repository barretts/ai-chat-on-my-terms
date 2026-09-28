import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import test from "node:test";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "../../../packages/storage/sqlite/core/src/index.js";
const connectionFeature = createRequire(import.meta.url)(
  "../../../apps/mobile/features/connections/index.ts",
) as typeof import("../../../apps/mobile/features/connections/index.js");
const {
  createManualRedirectConnectionRequest,
  SQLiteConnectionRepository,
  testConnection,
} = connectionFeature;
import {
  createUnauthenticatedHttpProbe,
  discoverLanServers,
  normalizeManualHost,
} from "../src/index.js";

function sqlitePort(db: DatabaseSync): SQLiteDatabasePort {
  return {
    execAsync: async (sql) => {
      db.exec(sql);
    },
    runAsync: async (sql, ...params: SqliteBindValue[]) =>
      db.prepare(sql).run(...params),
    getFirstAsync: async <T>(sql: string, ...params: SqliteBindValue[]) =>
      (db.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T>(sql: string, ...params: SqliteBindValue[]) =>
      db.prepare(sql).all(...params) as T[],
    withTransactionAsync: async (work) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        await work();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

test("connection CRUD, ordering and secret references survive SQLite reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "locallab-connections-"));
  const path = join(directory, "connections.sqlite");
  const id1 = "0197f000-0000-7000-8000-000000000001";
  const id2 = "0197f000-0000-7000-8000-000000000002";
  const secretRef = "sec_0197f000-0000-7000-8000-000000000003";
  try {
    let db = new DatabaseSync(path);
    const repo = new SQLiteConnectionRepository(sqlitePort(db));
    await assert.rejects(
      repo.save({
        name: "Unsafe",
        kind: "openai",
        host: "https://api.example.com",
        headerRefs: ["raw-secret-value"],
      }),
      /opaque secret reference/,
    );
    await repo.save({
      id: id1,
      name: "Local model",
      kind: "lm-studio",
      host: "192.168.1.5:1234",
      headerRefs: [secretRef],
      customHeadersEnabled: true,
    });
    await repo.save({
      id: id2,
      name: "Cloud model",
      kind: "openai",
      host: "https://api.example.com",
    });
    await repo.reorder([id2, id1]);
    db.close();

    db = new DatabaseSync(path);
    const reopened = new SQLiteConnectionRepository(sqlitePort(db));
    const saved = await reopened.list();
    assert.deepEqual(
      saved.map((item) => item.id),
      [id2, id1],
    );
    assert.equal(saved[1]?.host, "http://192.168.1.5:1234");
    assert.equal(saved[1]?.customHeadersEnabled, true);
    assert.deepEqual(saved[1]?.headerRefs, [secretRef]);
    const stored = db
      .prepare("SELECT * FROM provider_connections_local WHERE id = ?")
      .get(id1) as Record<string, unknown>;
    assert.equal(JSON.stringify(stored).includes("secret-value"), false);
    await reopened.delete(id2);
    assert.deepEqual(
      (await reopened.list()).map((item) => item.id),
      [id1],
    );
    db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("connection checks do not follow redirects with credentials", async () => {
  const requests: Array<{
    url: string;
    headers: Readonly<Record<string, string>>;
    redirect: RequestRedirect | undefined;
  }> = [];
  const request = createManualRedirectConnectionRequest(async (input, init) => {
    requests.push({
      url: String(input),
      headers: init?.headers as Readonly<Record<string, string>>,
      redirect: init?.redirect,
    });
    return new Response(null, {
      status: 302,
      headers: { location: "https://elsewhere.example/collect" },
    });
  });
  const result = await testConnection({
    connection: {
      id: "0197f000-0000-7000-8000-000000000001",
      name: "API",
      kind: "openai",
      host: "https://api.example.com",
      credentialRef: null,
      headerRefs: ["sec_0197f000-0000-7000-8000-000000000003"],
      customHeadersEnabled: true,
      position: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    secrets: {
      put: async () => {
        throw new Error("unused");
      },
      remove: async () => undefined,
      resolveHeaders: async () => ({ authorization: "sensitive" }),
    },
    request,
  });
  assert.equal(result, "failed");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.redirect, "manual");
  assert.deepEqual(requests[0]?.headers, { authorization: "sensitive" });
  assert.equal(requests[0]?.url, "https://api.example.com/v1/models");
});

test("manual discovery requires permission, caps candidates and exposes protected servers without credentials", async () => {
  let prompts = 0;
  let probes = 0;
  await assert.rejects(
    discoverLanServers({
      hosts: ["192.168.1.4"],
      permission: {
        request: async () => {
          prompts++;
          return "denied";
        },
      },
      probe: {
        probe: async () => {
          probes++;
          return { status: "not-found", host: "192.168.1.4" };
        },
      },
    }),
    /permission/,
  );
  assert.equal(prompts, 1);
  assert.equal(probes, 0);
  await assert.rejects(
    discoverLanServers({
      hosts: Array.from({ length: 17 }, (_, i) => `192.168.1.${i + 1}`),
      permission: { request: async () => "granted" },
      probe: {
        probe: async () => {
          probes++;
          return { status: "not-found", host: "x" };
        },
      },
    }),
    /limited to 16/,
  );
  assert.equal(probes, 0);

  const sentHeaders: HeadersInit[] = [];
  const httpProbe = createUnauthenticatedHttpProbe(async (_input, init) => {
    sentHeaders.push(init?.headers ?? {});
    return new Response(null, { status: 401 });
  });
  const results = await discoverLanServers({
    hosts: ["192.168.1.8:1234"],
    permission: { request: async () => "granted" },
    probe: httpProbe,
  });
  assert.deepEqual(results, [
    { status: "auth-required", host: "192.168.1.8:1234" },
  ]);
  assert.equal(sentHeaders.length, 1);
  assert.deepEqual(sentHeaders[0], { Accept: "application/json" });
});

test("discovery timeout is bounded and explicit hosts retain port", async () => {
  assert.equal(normalizeManualHost("192.168.1.8:1234"), "192.168.1.8:1234");
  const started = Date.now();
  const results = await discoverLanServers({
    hosts: ["192.168.1.9"],
    timeoutMs: 100,
    permission: { request: async () => "granted" },
    probe: { probe: async () => new Promise(() => undefined) },
  });
  assert.equal(results[0]?.status, "not-found");
  assert.ok(Date.now() - started < 1_000);
});
