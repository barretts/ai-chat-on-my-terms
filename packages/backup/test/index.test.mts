import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRestore,
  createBackup,
  findSecretPaths,
  openBackup,
  previewBackup,
  readHeader,
  setBackupZipPort,
} from "../src/index.ts";
import { nodeBackupCrypto } from "../src/node-crypto.ts";
import type { ZipEntry, ZipPort } from "@locallab/archives";

const FAST_KDF = {
  memoryKiB: 1024,
  iterations: 1,
  parallelism: 1,
  keyLengthBytes: 32,
};

/** Test-double zip port: a JSON store codec that verifies a content hash on
 * decode (the mobile production port does the real ZIP/CRC work). */
function testZipPort(): ZipPort {
  type StoredEntry = { path: string; bytes: number[] };
  const checksum = (payload: StoredEntry[]) =>
    payload.reduce(
      (sum: number, entry) =>
        (sum + entry.bytes.reduce((s: number, b: number) => s + b, 0)) %
        1_000_003,
      0,
    );
  const encode = async (entries: readonly ZipEntry[]) => {
    const payload: StoredEntry[] = entries.map((entry) => ({
      path: entry.path,
      bytes: Array.from(entry.bytes),
    }));
    const withHash = `${JSON.stringify({ count: payload.length, payload })}#${String(checksum(payload))}`;
    return new TextEncoder().encode(withHash);
  };
  const decode = async (bytes: Uint8Array) => {
    const text = new TextDecoder().decode(bytes);
    const hashAt = text.lastIndexOf("#");
    if (hashAt < 0) throw new Error("integrity check failed");
    const parsed = JSON.parse(text.slice(0, hashAt)) as {
      count: number;
      payload: StoredEntry[];
    };
    if (String(checksum(parsed.payload)) !== text.slice(hashAt + 1))
      throw new Error("integrity check failed");
    return parsed.payload.map((entry): ZipEntry => {
      return { path: entry.path, bytes: Uint8Array.from(entry.bytes) };
    });
  };
  return { encode, decode };
}

setBackupZipPort(testZipPort());

const crypto = nodeBackupCrypto();

function manifest() {
  return {
    createdAt: "2026-10-14T00:00:00.000Z",
    counts: { chats: 2, personas: 1, attachments: 1 },
  };
}

function entries(): ZipEntry[] {
  const enc = new TextEncoder();
  return [
    {
      path: "manifest.json",
      bytes: enc.encode(
        JSON.stringify({
          schemaVersion: 1,
          createdAt: "2026-10-14T00:00:00.000Z",
          counts: { chats: 2, personas: 1, attachments: 1 },
        }),
      ),
    },
    { path: "chats/one.json", bytes: enc.encode('{"title":"one"}') },
    { path: "attachments/photo.png", bytes: Uint8Array.from([1, 2, 3, 4]) },
    { path: "personas/helper.json", bytes: enc.encode('{"name":"helper"}') },
  ];
}

async function makeBackup(passphrase = "correct horse battery staple") {
  return createBackup({
    passphrase,
    manifest: manifest(),
    entries: entries(),
    zip: testZipPort(),
    crypto,
    kdfParams: FAST_KDF,
  });
}

test("a backup round-trips through the envelope with argon2id parameters", async () => {
  const bytes = await makeBackup();
  const header = readHeader(bytes);
  assert.equal(header.kdf.algorithm, "argon2id");
  assert.equal(header.cipher.algorithm, "AES-256-GCM");
  const opened = await openBackup(bytes, "correct horse battery staple", crypto);
  assert.equal(opened.manifest.counts.chats, 2);
  const preview = await previewBackup(
    bytes,
    "correct horse battery staple",
    crypto,
  );
  assert.deepEqual(
    preview.files.map((file) => file.path),
    [
      "attachments/photo.png",
      "chats/one.json",
      "manifest.json",
      "personas/helper.json",
    ],
  );
});

test("the same passphrase yields different salt, iv and ciphertext each run", async () => {
  const a = await makeBackup("passphrase value");
  const b = await makeBackup("passphrase value");
  assert.notEqual(readHeader(a).kdf.saltHex, readHeader(b).kdf.saltHex);
  assert.notEqual(readHeader(a).cipher.ivHex, readHeader(b).cipher.ivHex);
  assert.notEqual(Buffer.compare(Buffer.from(a), Buffer.from(b)), 0);
});

test("wrong passphrase and tampered bytes fail the tag check", async () => {
  const bytes = await makeBackup("right passphrase");
  await assert.rejects(openBackup(bytes, "wrong passphrase", crypto));
  const tampered = Uint8Array.from(bytes);
  const last = bytes.length - 10;
  tampered[last] = (tampered[last] ?? 0) ^ 0xff;
  await assert.rejects(openBackup(tampered, "right passphrase", crypto));
  const headerTampered = Uint8Array.from(bytes);
  headerTampered[12] = (headerTampered[12] ?? 0) ^ 0x11;
  assert.throws(() => readHeader(headerTampered));
});

test("credential entries are refused and reported before encryption", async () => {
  const enc = new TextEncoder();
  const withSecret: ZipEntry[] = [
    ...entries(),
    { path: "applock/verifier.json", bytes: enc.encode('{"hash":"x"}') },
  ];
  assert.deepEqual(findSecretPaths(withSecret), ["applock/verifier.json"]);
  await assert.rejects(
    createBackup({
      passphrase: "passphrase value",
      manifest: manifest(),
      entries: withSecret,
      zip: testZipPort(),
      crypto,
      kdfParams: FAST_KDF,
    }),
    /credential entries: applock\/verifier\.json/,
  );
});

test("restore applies as one transaction and rolls back on failure", async () => {
  const bytes = await makeBackup("passphrase value");
  const opened = await openBackup(bytes, "passphrase value", crypto);
  const log: string[] = [];
  await assert.rejects(
    applyRestore(opened.zipBytes, {
      async begin() {
        log.push("begin");
      },
      async stage(applied) {
        log.push(`stage:${String(applied.length)}`);
        throw new Error("disk write failed");
      },
      async commit() {
        log.push("commit");
      },
      async rollback() {
        log.push("rollback");
      },
    }),
    /disk write failed/,
  );
  assert.deepEqual(log, ["begin", "stage:4", "rollback"]);
});
test("manifest schema version outside ours refuses restore", async () => {
  // Hand-seal an envelope the create path would never emit (a future
  // schema version) and check the read path refuses it.
  const kdf = {
    algorithm: "argon2id" as const,
    saltHex: "00112233445566778899aabbccddeeff",
    ...FAST_KDF,
  };
  const key = await crypto.deriveKey("passphrase value", kdf);
  const zipBytes = await testZipPort().encode([
    {
      path: "manifest.json",
      bytes: new TextEncoder().encode(
        JSON.stringify({ schemaVersion: 99, createdAt: "", counts: {} }),
      ),
    },
  ]);
  const sealed = await crypto.encrypt(
    key,
    zipBytes,
    new TextEncoder().encode("LLBKP1\n"),
  );
  const headerBytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      kdf,
      cipher: {
        algorithm: "AES-256-GCM",
        ivHex: sealed.ivHex,
        tagHex: sealed.tagHex,
      },
    }),
  );
  const bytes = new Uint8Array(
    7 + 4 + headerBytes.length + sealed.ciphertext.length,
  );
  bytes.set(new TextEncoder().encode("LLBKP1\n"));
  new DataView(bytes.buffer).setUint32(7, headerBytes.length, false);
  bytes.set(headerBytes, 11);
  bytes.set(sealed.ciphertext, 11 + headerBytes.length);
  await assert.rejects(
    openBackup(bytes, "passphrase value", crypto),
    /unsupported backup schema version 99/,
  );
});

test("short passphrases are rejected at create time", async () => {
  await assert.rejects(
    makeBackup("short"),
    /at least 8 characters/,
  );
});
