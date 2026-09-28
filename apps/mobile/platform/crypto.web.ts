import type { BlobCryptoPort } from "@locallab/storage-blobs";
import { sha256Hex, uuidv7 } from "./crypto-core";

/** Browser implementation for the same app-facing port; requires a secure origin. */
export function createId(): string {
  return uuidv7((bytes) => {
    globalThis.crypto.getRandomValues(bytes);
  });
}

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const snapshot = new Uint8Array(bytes);
  return sha256Hex(await globalThis.crypto.subtle.digest("SHA-256", snapshot));
}

export const mobileBlobCrypto: BlobCryptoPort = {
  randomUUID: createId,
  sha256,
};
