import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test, vi } from "vitest";
import { EntityIdSchema } from "@locallab/contracts/identity";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { SQLiteConnectionRepository } from "../features/connections";
import { uuidv7 } from "./crypto-core";
import * as browserCrypto from "./crypto.web";

// SDK fixture: exercise the native facade without loading a native bridge under Node.
vi.mock("expo-crypto", async () => {
  const { webcrypto, randomUUID } = await import("node:crypto");
  return {
    CryptoDigestAlgorithm: { SHA256: "SHA-256" },
    getRandomValues: (bytes: Uint8Array) => webcrypto.getRandomValues(bytes),
    randomUUID,
    digest: (algorithm: string, bytes: Uint8Array) => {
      assert.equal(algorithm, "SHA-256");
      return webcrypto.subtle.digest("SHA-256", new Uint8Array(bytes));
    },
  };
});

const abcSha256 =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

test("UUIDv7 encodes the 48-bit timestamp while retaining version and variant", () => {
  const id = uuidv7((bytes) => {
    bytes.fill(0xff);
  }, 0x0123456789ab);
  assert.equal(id, "01234567-89ab-7fff-bfff-ffffffffffff");
  EntityIdSchema.parse(id);
});

test("web crypto hashes only the supplied byte view and emits UUIDv7 entities", async () => {
  EntityIdSchema.parse(browserCrypto.createId());
  EntityIdSchema.parse(browserCrypto.mobileBlobCrypto.randomUUID());
  const bytes = new Uint8Array([0, 97, 98, 99, 255]);
  assert.equal(await browserCrypto.sha256(bytes.subarray(1, 4)), abcSha256);
  assert.equal(
    await browserCrypto.sha256(new Uint8Array()),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("native facade uses the SDK port when global crypto is absent (SDK fixture)", async () => {
  const nativeCrypto = await import("./crypto");
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: undefined,
  });
  try {
    EntityIdSchema.parse(nativeCrypto.createId());
    EntityIdSchema.parse(nativeCrypto.mobileBlobCrypto.randomUUID());
    assert.match(
      nativeCrypto.randomUUID(),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const bytes = new Uint8Array([0, 97, 98, 99, 255]);
    assert.equal(await nativeCrypto.sha256(bytes.subarray(1, 4)), abcSha256);
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test("connection creation uses its injected ID factory without a browser crypto global", async () => {
  const native = new DatabaseSync(":memory:");
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const db: SQLiteDatabasePort = {
    execAsync: async (sql) => native.exec(sql),
    runAsync: async (sql, ...params: SqliteBindValue[]) =>
      native.prepare(sql).run(...params),
    getFirstAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      (native.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      native.prepare(sql).all(...params) as T[],
    withTransactionAsync: async (work) => {
      await work();
    },
  };
  const id = "0195c000-0000-7000-8000-000000000501";
  let created = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: undefined,
  });
  try {
    const repository = new SQLiteConnectionRepository(db, () => {
      created += 1;
      return id;
    });
    const connection = await repository.save({
      name: "Crypto fixture",
      kind: "ollama",
      host: "http://127.0.0.1:11434",
    });
    assert.equal(connection.id, id);
    assert.equal(created, 1);
    assert.equal((await repository.list())[0]?.id, id);
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else Reflect.deleteProperty(globalThis, "crypto");
    native.close();
  }
});
