import * as Crypto from "expo-crypto";
import type { HashPort, LockRecord, LockRecordStore } from "@locallab/app-lock";

let record: LockRecord | null = null;

/** The browser has no native secure store; keep its app-lock verifier in this tab only. */
export function secureStoreRecordStore(): LockRecordStore {
  return {
    async load() {
      return record;
    },
    async save(value) {
      record = value;
    },
    async clear() {
      record = null;
    },
  };
}

export function expoSaltedHashPort(): HashPort {
  return {
    algorithm: "expo-sha256-salt-v1",
    async hash(salt, pin) {
      return Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        `${salt}:${pin}`,
      );
    },
    randomSalt() {
      return Array.from(Crypto.getRandomBytes(16))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    },
  };
}
