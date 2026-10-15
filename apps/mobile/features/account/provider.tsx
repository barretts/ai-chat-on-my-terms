import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createAccountClient } from "./client";
import type { AccountClient, AccountSummary } from "./client";
import { secureStoreTokenPort } from "./adapters";

export interface AccountValue {
  available: boolean;
  account: AccountSummary | null;
  busy: boolean;
  error: string | null;
  refresh(): Promise<void>;
  anonymousSignIn(): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

const AccountContext = createContext<AccountValue | null>(null);

export function AccountProvider(options: {
  baseUrl?: string;
  client?: AccountClient;
  children: ReactNode;
}) {
  const client = useMemo(
    () =>
      options.client ??
      (options.baseUrl === undefined
        ? null
        : createAccountClient({
            baseUrl: options.baseUrl,
            tokens: secureStoreTokenPort(),
          })),
    [options.client, options.baseUrl],
  );
  // Rebuilt in the render body, this factory produced a fresh client (and a
  // fresh token adapter) on every render: each refresh state update changed
  // the client identity, reran the refresh effect, and looped requests until
  // restart. The client is now owned here and rebuilt only for a real
  // configuration change (injected client or baseUrl).
  const activeClient = useRef(client);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // A closure captured before a client switch must not fetch through the
    // abandoned client nor overwrite state from its responses.
    if (client === null || client !== activeClient.current) return;
    setBusy(true);
    setError(null);
    try {
      const next = await client.account();
      if (client !== activeClient.current) return;
      setAccount(next);
    } catch {
      setError("account service unreachable");
    } finally {
      setBusy(false);
    }
  }, [client]);

  useEffect(() => {
    // Commit the new client as active before refreshing it; refreshes still
    // in flight on the previous client are dropped by the identity check.
    activeClient.current = client;
    void refresh();
  }, [client, refresh]);

  const guard = useCallback(
    async (action: () => Promise<void>) => {
      if (client === null) return;
      setBusy(true);
      setError(null);
      try {
        await action();
        const next = await client.account();
        if (client === activeClient.current) setAccount(next);
      } catch {
        setError("that did not work; check the details and try again");
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  const value: AccountValue = {
    available: client !== null,
    account,
    busy,
    error,
    refresh,
    anonymousSignIn: () =>
      guard(async () => {
        await client?.anonymousSignIn();
      }),
    signIn: (email, password) =>
      guard(async () => {
        await client?.signIn(email, password);
      }),
    signOut: () =>
      guard(async () => {
        await client?.signOut();
      }),
  };
  return (
    <AccountContext.Provider value={value}>
      {options.children}
    </AccountContext.Provider>
  );
}

export function useAccount(): AccountValue {
  const value = useContext(AccountContext);
  if (value === null)
    throw new Error("useAccount must be used inside AccountProvider");
  return value;
}
