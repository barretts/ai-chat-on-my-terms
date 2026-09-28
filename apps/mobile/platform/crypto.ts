import * as Crypto from "expo-crypto";
import type { BlobCryptoPort } from "@locallab/storage-blobs";
import { sha256Hex, uuidv7 } from "./crypto-core";

/** Native secure bytes, with no dependency on a browser global or development fallback. */
export function createId(): string {
  return uuidv7((bytes) => {
    Crypto.getRandomValues(bytes);
  });
}

/** Secret references need opaque random UUIDs rather than entity creation timestamps. */
export function randomUUID(): string {
  return Crypto.randomUUID();
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const snapshot = new Uint8Array(bytes);
  return sha256Hex(
    await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, snapshot),
  );
}

export const mobileBlobCrypto: BlobCryptoPort = {
  randomUUID: createId,
  sha256,
};
