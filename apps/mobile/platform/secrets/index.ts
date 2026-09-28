import {
  HostScopedSecretStore,
  type SecureValuePort,
} from "@locallab/security-secrets";
import * as SecureStore from "expo-secure-store";
import { randomUUID } from "../crypto";

/** Adapter boundary for expo-secure-store. Inject SecureStore's getItemAsync/setItemAsync/deleteItemAsync. */
export interface ExpoSecureStoreModule {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export function createMobileSecretStore(
  expoSecureStore: ExpoSecureStoreModule,
) {
  const port: SecureValuePort = {
    get: (key) => expoSecureStore.getItemAsync(key),
    set: (key, value) => expoSecureStore.setItemAsync(key, value),
    delete: (key) => expoSecureStore.deleteItemAsync(key),
  };
  return new HostScopedSecretStore(port, "mobile-provider-headers", randomUUID);
}

/** Production adapter backed by iOS Keychain / Android Keystore via Expo SecureStore. */
export function createNativeMobileSecretStore() {
  return createMobileSecretStore(SecureStore);
}
