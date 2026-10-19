import {
  HostScopedSecretStore,
  type SecureValuePort,
} from "@locallab/security-secrets";
import { registerDiagnosticSecret } from "../../features/diagnostics/sanitization";
import { desktopInvoke } from "./bridge";

/**
 * OS keyring store for the desktop shell. Values live in the Windows
 * credential store (macOS Keychain / freedesktop secrets on other platforms)
 * under the fixed service `com.locallab.provider-secrets`, hardcoded in
 * apps/desktop/src-tauri/src/desktop.rs. That constant mirrors
 * apps/companion/src/secrets.rs:4 (and the now-removed
 * apps/desktop/platform/secrets scaffolding), so there is deliberately no
 * service parameter on this side either.
 */
export function createDesktopSecretStore(): HostScopedSecretStore {
  const port: SecureValuePort = {
    get: async (key) =>
      (await desktopInvoke<string | null>("secret_get", { account: key })) ??
      null,
    set: (key, value) =>
      desktopInvoke<void>("secret_set", { account: key, value }),
    delete: (key) => desktopInvoke<void>("secret_delete", { account: key }),
  };
  const store: SecureValuePort = {
    get: async (key) => {
      const value = await port.get(key);
      if (value && key.endsWith(":value")) registerDiagnosticSecret(value);
      return value;
    },
    set: (key, value) => {
      if (key.endsWith(":value")) registerDiagnosticSecret(value);
      return port.set(key, value);
    },
    delete: (key) => port.delete(key),
  };
  // Same namespace as apps/mobile/platform/secrets (createNativeMobileSecretStore
  // / index.web.ts) so refs stay portable across the desktop and web shells.
  return new HostScopedSecretStore(store, "mobile-provider-headers");
}
