import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type { HashPort, LockRecord, LockRecordStore } from "@locallab/app-lock";

const ITEM_KEY = "appLockV1";

/** Device-local verifier storage: SecureStore (Keychain on iOS) is never
 * walked by sync or backup paths, satisfying the no-sync/no-backup rule. */
export function secureStoreRecordStore(): LockRecordStore {
  return {
    async load() {
      const raw = await SecureStore.getItemAsync(ITEM_KEY);
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw) as LockRecord;
        if (parsed.version !== 1 || parsed.kind !== "pin") return null;
        return parsed;
      } catch {
        return null;
      }
    },
    async save(record) {
      await SecureStore.setItemAsync(ITEM_KEY, JSON.stringify(record));
    },
    async clear() {
      await SecureStore.deleteItemAsync(ITEM_KEY);
    },
  };
}

/** Salted SHA-256 via expo-crypto. NOTE: single-pass on purpose — the
 * device threat model is a lost/ununlocked phone, and Keychain storage
 * already holds the secret out of sqlite. A slow KDF hardening pass is
 * listed as pending. */
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
