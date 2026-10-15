import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createSupportClient } from "./client";
import type { ChangelogInfo, SupportClient, SupportRequestInfo } from "./client";
import { buildRedactedDiagnostics } from "./redacted-diagnostics";
import type { RedactedDiagnosticsInput } from "./redacted-diagnostics";
import { secureStoreTokenPort } from "../account/adapters";

/** Native image pick seam; absence means the attach control explains it
 * instead of silently doing nothing. */
export interface AttachmentSourcePort {
  pickImage(): Promise<{
    name: string;
    contentType: string;
    dataBase64: string;
  } | null>;
}

export interface SupportValue {
  available: boolean;
  requests: SupportRequestInfo[];
  changelog: ChangelogInfo[];
  update: { latest: string | null; upToDate: boolean } | null;
  busy: boolean;
  error: string | null;
  refresh(): Promise<void>;
  checkForUpdate(installedVersion: string): Promise<void>;
  submitRequest(input: {
    kind: "feature-request" | "support-ticket";
    title: string;
    body: string;
    diagnostics?: RedactedDiagnosticsInput;
  }): Promise<boolean>;
  vote(id: string, up: boolean): Promise<void>;
  comment(id: string, body: string, parentId?: string): Promise<boolean>;
  markRead(id: string): Promise<void>;
  attach(requestId: string): Promise<boolean>;
  deleteAccount(): Promise<boolean>;
  redactedDiagnostics(): RedactedDiagnosticsInput | null;
}

const SupportContext = createContext<SupportValue | null>(null);

export function SupportProvider(options: {
  baseUrl?: string;
  client?: SupportClient;
  attachmentSource?: AttachmentSourcePort;
  diagnosticsSource?: () => RedactedDiagnosticsInput | null;
  children: ReactNode;
}) {
  const client =
    options.client ??
    (options.baseUrl === undefined
      ? null
      : createSupportClient({
          baseUrl: options.baseUrl,
          tokens: secureStoreTokenPort(),
        }));
  const [requests, setRequests] = useState<SupportRequestInfo[]>([]);
  const [changelog, setChangelog] = useState<ChangelogInfo[]>([]);
  const [update, setUpdate] = useState<SupportValue["update"]>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (client === null) return;
    try {
      const [items, log] = await Promise.all([
        client.listRequests(),
        client.changelog(),
      ]);
      setRequests(items);
      setChangelog(log);
      setError(null);
    } catch {
      setError("support board unreachable");
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const checkForUpdate = useCallback(
    async (installedVersion: string) => {
      if (client === null) return;
      try {
        setUpdate(await client.versionCheck(installedVersion));
      } catch {
        setUpdate(null);
      }
    },
    [client],
  );

  const submitRequest = useCallback<SupportValue["submitRequest"]>(
    async (input) => {
      if (client === null) return false;
      setBusy(true);
      setError(null);
      try {
        // Diagnostics are appended only when explicitly provided.
        const body =
          input.diagnostics === undefined
            ? input.body
            : `${input.body}\n\n${buildRedactedDiagnostics(input.diagnostics)}`;
        await client.createRequest({
          kind: input.kind,
          title: input.title,
          body,
        });
        await refresh();
        return true;
      } catch {
        setError("submit failed: sign in first");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [client, refresh],
  );

  const vote = useCallback(
    async (id: string, up: boolean) => {
      if (client === null) return;
      await client.vote(id, up).catch(() => undefined);
      await refresh();
    },
    [client, refresh],
  );

  const comment = useCallback(
    async (id: string, body: string, parentId?: string) => {
      if (client === null) return false;
      try {
        await client.comment(
          id,
          parentId === undefined ? { body } : { body, parentId },
        );
        await refresh();
        return true;
      } catch {
        setError("comment failed");
        return false;
      }
    },
    [client, refresh],
  );

  const markRead = useCallback(
    async (id: string) => {
      if (client === null) return;
      await client.markRead(id).catch(() => undefined);
      await refresh();
    },
    [client, refresh],
  );

  const attach = useCallback(
    async (requestId: string) => {
      if (client === null) return false;
      if (options.attachmentSource === undefined) {
        setError("attachments need the native image picker");
        return false;
      }
      const picked = await options.attachmentSource.pickImage();
      if (picked === null) return false;
      try {
        await client.addAttachment(requestId, picked);
        return true;
      } catch {
        setError("attachment upload failed");
        return false;
      }
    },
    [client, options.attachmentSource],
  );

  const deleteAccount = useCallback(async () => {
    if (client === null) return false;
    try {
      await client.deleteAccount();
      await refresh();
      return true;
    } catch {
      setError("account deletion failed");
      return false;
    }
  }, [client, refresh]);

  const redactedDiagnostics = useCallback(
    () => options.diagnosticsSource?.() ?? null,
    [options.diagnosticsSource],
  );

  const value: SupportValue = {
    available: client !== null,
    requests,
    changelog,
    update,
    busy,
    error,
    refresh,
    checkForUpdate,
    submitRequest,
    vote,
    comment,
    markRead,
    attach,
    deleteAccount,
    redactedDiagnostics,
  };
  return (
    <SupportContext.Provider value={value}>
      {options.children}
    </SupportContext.Provider>
  );
}

export function useSupport(): SupportValue {
  const value = useContext(SupportContext);
  if (value === null)
    throw new Error("useSupport must be used inside SupportProvider");
  return value;
}
