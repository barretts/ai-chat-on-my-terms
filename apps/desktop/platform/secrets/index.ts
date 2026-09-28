import {
  HostScopedSecretStore,
  type SecureValuePort,
} from "@locallab/security-secrets";

/** Adapter boundary for a Tauri keyring plugin or native OS credential API. */
export interface DesktopKeyringPort {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(
    service: string,
    account: string,
    password: string,
  ): Promise<void>;
  deletePassword(service: string, account: string): Promise<void>;
}

export function createDesktopSecretStore(keyring: DesktopKeyringPort) {
  const service = "com.locallab.provider-secrets";
  const port: SecureValuePort = {
    get: (account) => keyring.getPassword(service, account),
    set: (account, password) => keyring.setPassword(service, account, password),
    delete: (account) => keyring.deletePassword(service, account),
  };
  return new HostScopedSecretStore(port, "desktop-provider-headers");
}
