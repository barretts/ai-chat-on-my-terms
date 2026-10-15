import * as SecureStore from "expo-secure-store";
import type { SecureTokenPort } from "./client";

const ITEM_KEY = "authSessionV1";

/** Session token lives in Keychain/Keystore: never sqlite, never synced,
 * never included in backups (DA-03 credential-path rule matches this key
 * even if a future port stored it under a path). */
export function secureStoreTokenPort(): SecureTokenPort {
  return {
    async get() {
      return await SecureStore.getItemAsync(ITEM_KEY);
    },
    async set(token) {
      await SecureStore.setItemAsync(ITEM_KEY, token);
    },
    async clear() {
      await SecureStore.deleteItemAsync(ITEM_KEY);
    },
  };
}
