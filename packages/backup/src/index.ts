/** Encrypted workspace backup (DA-03): schema-versioned ZIP sealed with
 * Argon2id-derived AES-256-GCM. The passphrase never leaves the client;
 * object storage holds ciphertext only. */
import type { ZipEntry, ZipPort } from "@locallab/archives";

export const BACKUP_SCHEMA_VERSION = 1;
const MAGIC = "LLBKP1\n";

export interface BackupManifest {
  schemaVersion: number;
  createdAt: string;
  counts: {
    chats: number;
    personas: number;
    attachments: number;
  };
}

export interface KdfParams {
  algorithm: "argon2id";
  saltHex: string;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  keyLengthBytes: number;
}

export interface CipherParams {
  algorithm: "AES-256-GCM";
  ivHex: string;
  tagHex: string;
}

export interface BackupHeader {
  version: number;
  kdf: KdfParams;
  cipher: CipherParams;
}

export interface CryptoPorts {
  randomBytes(count: number): Uint8Array;
  deriveKey(passphrase: string, params: KdfParams): Promise<Uint8Array>;
  encrypt(
    key: Uint8Array,
    plaintext: Uint8Array,
    aad: Uint8Array,
  ): Promise<{ ivHex: string; tagHex: string; ciphertext: Uint8Array }>;
  decrypt(
    key: Uint8Array,
    ivHex: string,
    tagHex: string,
    aad: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array>;
}

export interface CreateBackupOptions {
  passphrase: string;
  kdfParams?: Partial<Omit<KdfParams, "saltHex">>;
  manifest: Omit<BackupManifest, "schemaVersion">;
  entries: readonly ZipEntry[];
  zip: ZipPort;
  crypto: CryptoPorts;
}

/** Credential-bearing entries are refused outright (step 3): PINs, keys and
 * tokens must never enter a backup, even an encrypted one. */
const SECRET_PATH =
  /(^|\/)(keychain|credential|token|secret|password|pin|applock|app_lock)/i;

export function findSecretPaths(
  entries: readonly ZipEntry[],
): string[] {
  return entries
    .map((entry) => entry.path)
    .filter((path) => SECRET_PATH.test(path));
}

export async function createBackup(
  options: CreateBackupOptions,
): Promise<Uint8Array> {
  if (options.passphrase.length < 8)
    throw new Error("backup passphrase must be at least 8 characters");
  const secrets = findSecretPaths(options.entries);
  if (secrets.length > 0)
    throw new Error(
      `refusing to back up credential entries: ${secrets.join(", ")}`,
    );
  const manifest: BackupManifest = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    ...options.manifest,
  };
  const payload: ZipEntry[] = [
    ...options.entries.filter((entry) => entry.path !== "manifest.json"),
    {
      path: "manifest.json",
      bytes: new TextEncoder().encode(JSON.stringify(manifest)),
    },
  ];
  const zipped = await options.zip.encode(
    payload.sort((a, b) => a.path.localeCompare(b.path)),
  );
  const kdf: KdfParams = {
    algorithm: "argon2id",
    saltHex: toHex(options.crypto.randomBytes(16)),
    memoryKiB: 65_536,
    iterations: 3,
    parallelism: 2,
    keyLengthBytes: 32,
    ...options.kdfParams,
  };
  const key = await options.crypto.deriveKey(options.passphrase, kdf);
  const aad = new TextEncoder().encode(MAGIC);
  const sealed = await options.crypto.encrypt(key, zipped, aad);
  const header: BackupHeader = {
    version: BACKUP_SCHEMA_VERSION,
    kdf,
    cipher: { algorithm: "AES-256-GCM", ivHex: sealed.ivHex, tagHex: sealed.tagHex },
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(
    MAGIC.length + 4 + headerBytes.length + sealed.ciphertext.length,
  );
  out.set(new TextEncoder().encode(MAGIC));
  new DataView(out.buffer).setUint32(MAGIC.length, headerBytes.length, false);
  out.set(headerBytes, MAGIC.length + 4);
  out.set(sealed.ciphertext, MAGIC.length + 4 + headerBytes.length);
  return out;
}

export function readHeader(bytes: Uint8Array): BackupHeader {
  const magic = new TextDecoder().decode(bytes.subarray(0, MAGIC.length));
  if (magic !== MAGIC) throw new Error("not a LocalLab backup file");
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    MAGIC.length,
    false,
  );
  const header = JSON.parse(
    new TextDecoder().decode(
      bytes.subarray(MAGIC.length + 4, MAGIC.length + 4 + headerLen),
    ),
  ) as BackupHeader;
  if (
    header.version !== BACKUP_SCHEMA_VERSION ||
    header.kdf.algorithm !== "argon2id" ||
    header.cipher.algorithm !== "AES-256-GCM"
  )
    throw new Error("unsupported backup format version or primitives");
  return header;
}

export interface DecryptedBackup {
  header: BackupHeader;
  manifest: BackupManifest;
  zipBytes: Uint8Array;
}

/** Throws on wrong passphrase or tampering (GCM tag covers the whole
 * payload; nothing is applied before the tag check). */
export async function openBackup(
  bytes: Uint8Array,
  passphrase: string,
  crypto: CryptoPorts,
): Promise<DecryptedBackup> {
  const header = readHeader(bytes);
  const key = await crypto.deriveKey(passphrase, header.kdf);
  const aad = new TextEncoder().encode(MAGIC);
  const ciphertext = bytes.subarray(MAGIC.length + 4 + headerJsonLength(bytes));
  const zipBytes = await crypto.decrypt(
    key,
    header.cipher.ivHex,
    header.cipher.tagHex,
    aad,
    ciphertext,
  );
  const entries = await zipEntries(zipBytes);
  const manifestEntry = entries.find((entry) => entry.path === "manifest.json");
  if (manifestEntry === undefined)
    throw new Error("backup has no manifest entry");
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestEntry.bytes),
  ) as BackupManifest;
  if (manifest.schemaVersion !== BACKUP_SCHEMA_VERSION)
    throw new Error(
      `unsupported backup schema version ${String(manifest.schemaVersion)}`,
    );
  return { header, manifest, zipBytes };
}

export interface BackupPreview {
  manifest: BackupManifest;
  files: { path: string; bytes: number }[];
}

export async function previewBackup(
  bytes: Uint8Array,
  passphrase: string,
  crypto: CryptoPorts,
): Promise<BackupPreview> {
  const opened = await openBackup(bytes, passphrase, crypto);
  const files = (await zipEntries(opened.zipBytes)).map((entry) => ({
    path: entry.path,
    bytes: entry.bytes.length,
  }));
  return { manifest: opened.manifest, files };
}

export interface RestoreTransaction {
  begin(): Promise<void>;
  stage(entries: readonly ZipEntry[]): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** Transactional application: a failure anywhere rolls the whole restore
 * back; nothing is partially overwritten. */
export async function applyRestore(
  zipBytes: Uint8Array,
  transaction: RestoreTransaction,
): Promise<void> {
  const entries = await zipEntries(zipBytes);
  await transaction.begin();
  try {
    await transaction.stage(entries);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

let activeZipPort: ZipPort | null = null;

/** The ZIP port is host-supplied; set it once per process before open or
 * apply (mobile injects its native zip port). */
export function setBackupZipPort(port: ZipPort): void {
  activeZipPort = port;
}

async function zipEntries(zipBytes: Uint8Array): Promise<readonly ZipEntry[]> {
  if (activeZipPort === null)
    throw new Error("backup zip port is not configured");
  return activeZipPort.decode(zipBytes);
}

function headerJsonLength(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    MAGIC.length,
    false,
  );
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1)
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
