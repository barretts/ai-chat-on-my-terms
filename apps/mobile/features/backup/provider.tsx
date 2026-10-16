/** BackupProvider: owns the encrypted-backup client for the session.
 * A CryptoPorts implementation must be injected; without a native crypto
 * module the section degrades to an unavailable notice instead of
 * pretending backup works (the passphrase-derived key can't be produced). */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { BackupPreview, CryptoPorts } from "@locallab/backup";
import { openMobileDatabase } from "../../platform/database-open";
import { secureStoreTokenPort } from "../account/adapters";
import {
  createBackupClient,
  fetchBackupObjectStore,
  type BackupClient,
  type BackupObjectStorePort,
} from "./client";

export interface BackupState {
  ready: boolean;
  cryptoAvailable: boolean;
  storeConfigured: boolean;
  busy: boolean;
  error: string | null;
  lastPreview: BackupPreview | null;
  client: BackupClient | null;
  createAndUpload(
    passphrase: string,
    objectId: string,
  ): Promise<BackupPreview | null>;
  restoreFromStore(
    passphrase: string,
    objectId: string,
  ): Promise<BackupPreview | null>;
}

const idleState: BackupState = {
  ready: false,
  cryptoAvailable: false,
  storeConfigured: false,
  busy: false,
  error: null,
  lastPreview: null,
  client: null,
  async createAndUpload() {
    return null;
  },
  async restoreFromStore() {
    return null;
  },
};

const BackupContext = createContext<BackupState>(idleState);

export interface BackupProviderProps {
  children: ReactNode;
  cryptoPort?: CryptoPorts;
  storeBaseUrl?: string;
}

export function BackupProvider({
  children,
  cryptoPort,
  storeBaseUrl,
}: BackupProviderProps) {
  const [client, setClient] = useState<BackupClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastPreview, setLastPreview] = useState<BackupPreview | null>(null);

  useEffect(() => {
    if (cryptoPort === undefined) return;
    let cancelled = false;
    const store: BackupObjectStorePort | undefined =
      storeBaseUrl === undefined
        ? undefined
        : fetchBackupObjectStore(storeBaseUrl, secureStoreTokenPort());
    void (async () => {
      const db = await openMobileDatabase();
      if (cancelled) return;
      setClient(
        createBackupClient({
          db,
          crypto: cryptoPort,
          ...(store === undefined ? {} : { store }),
        }),
      );
    })().catch((openError: unknown) => {
      if (!cancelled)
        setError(openError instanceof Error ? openError.message : String(openError));
    });
    return () => {
      cancelled = true;
    };
  }, [cryptoPort, storeBaseUrl]);

  const value = useMemo<BackupState>(() => {
    const fail = (thrown: unknown) => {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
      return null;
    };
    return {
      ready: client !== null,
      cryptoAvailable: cryptoPort !== undefined,
      storeConfigured: storeBaseUrl !== undefined,
      busy,
      error,
      lastPreview,
      client,
      async createAndUpload(passphrase, objectId) {
        if (client === null) return fail(new Error("backup client not ready"));
        setBusy(true);
        try {
          const { bytes, preview } = await client.create(passphrase);
          await client.upload(objectId, bytes);
          setLastPreview(preview);
          setError(null);
          return preview;
        } catch (thrown) {
          return fail(thrown);
        } finally {
          setBusy(false);
        }
      },
      async restoreFromStore(passphrase, objectId) {
        if (client === null) return fail(new Error("backup client not ready"));
        setBusy(true);
        try {
          const bytes = await client.download(objectId);
          if (bytes === null)
            return fail(new Error(`no backup object "${objectId}" on the server`));
          const preview = await client.restore(bytes, passphrase);
          setLastPreview(preview);
          setError(null);
          return preview;
        } catch (thrown) {
          return fail(thrown);
        } finally {
          setBusy(false);
        }
      },
    };
  }, [client, cryptoPort, storeBaseUrl, busy, error, lastPreview]);

  return <BackupContext.Provider value={value}>{children}</BackupContext.Provider>;
}

export function useBackup(): BackupState {
  return useContext(BackupContext);
}
