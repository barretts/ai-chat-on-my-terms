import {
  HostScopedSecretStore,
  type SecureValuePort,
} from "@locallab/security-secrets";
import { registerDiagnosticSecret } from "../../features/diagnostics/sanitization";

// Browser keys exist only in this tab's memory, never in browser persistence.
const tabSecrets = new Map<string, string>();

export interface ExpoSecureStoreModule {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export function createMobileSecretStore(store: ExpoSecureStoreModule) {
  const port: SecureValuePort = {
    get: async (key) => {
      const value = await store.getItemAsync(key);
      if (value && key.endsWith(":value")) registerDiagnosticSecret(value);
      return value;
    },
    set: (key, value) => {
      if (key.endsWith(":value")) registerDiagnosticSecret(value);
      return store.setItemAsync(key, value);
    },
    delete: (key) => store.deleteItemAsync(key),
  };
  return new HostScopedSecretStore(port, "mobile-provider-headers");
}

export function createNativeMobileSecretStore() {
  return createMobileSecretStore({
    getItemAsync: async (key) => tabSecrets.get(key) ?? null,
    setItemAsync: async (key, value) => {
      tabSecrets.set(key, value);
    },
    deleteItemAsync: async (key) => {
      tabSecrets.delete(key);
    },
  });
}
