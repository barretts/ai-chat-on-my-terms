import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
  const client =
    options.client ??
    (options.baseUrl === undefined
      ? null
      : createAccountClient({
          baseUrl: options.baseUrl,
          tokens: secureStoreTokenPort(),
        }));
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (client === null) return;
    setBusy(true);
    setError(null);
    try {
      setAccount(await client.account());
    } catch {
      setError("account service unreachable");
    } finally {
      setBusy(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const guard = useCallback(
    async (action: () => Promise<void>) => {
      if (client === null) return;
      setBusy(true);
      setError(null);
      try {
        await action();
        setAccount(await client.account());
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
