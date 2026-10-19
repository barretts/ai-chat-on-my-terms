import {
  HostScopedSecretStore,
  type SecureValuePort,
} from "@locallab/security-secrets";
import * as SecureStore from "expo-secure-store";
import { randomUUID } from "../crypto";
import { expoSecureStoreKey } from "./secure-store-key";
import { registerDiagnosticSecret } from "../../features/diagnostics/sanitization";
import { isDesktopBridge } from "../desktop/bridge";
import { createDesktopSecretStore } from "../desktop/secrets";

/** Adapter boundary for expo-secure-store. Inject SecureStore's getItemAsync/setItemAsync/deleteItemAsync. */
export interface ExpoSecureStoreModule {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export function createMobileSecretStore(
  expoSecureStore: ExpoSecureStoreModule,
) {
  // Shared-store key names contain colons. Expo rejected those before any OS
  // writes, so there is no native legacy payload to migrate; refs are unchanged.
  const port: SecureValuePort = {
    get: async (key) => {
      const value = await expoSecureStore.getItemAsync(expoSecureStoreKey(key));
      if (value && key.endsWith(":value")) registerDiagnosticSecret(value);
      return value;
    },
    set: (key, value) => {
      if (key.endsWith(":value")) registerDiagnosticSecret(value);
      return expoSecureStore.setItemAsync(expoSecureStoreKey(key), value);
    },
    delete: (key) => expoSecureStore.deleteItemAsync(expoSecureStoreKey(key)),
  };
  return new HostScopedSecretStore(port, "mobile-provider-headers", randomUUID);
}

/**
 * Production adapter. Inside the desktop Tauri webview the OS keyring (Rust
 * `keyring` crate) replaces Expo SecureStore; phones keep Keychain/Keystore.
 */
export function createNativeMobileSecretStore() {
  if (isDesktopBridge()) return createDesktopSecretStore();
  return createMobileSecretStore(SecureStore);
}
