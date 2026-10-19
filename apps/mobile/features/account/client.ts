/** Device side of optional accounts (AC-01/AC-02). The session token is
 * held in device-secure storage (Keychain/Keystore), never in sqlite, so
 * sync and backups never carry it. Local-only users never call this —
 * nothing here requires an account, and sign-out here deletes the
 * token only; local chats live in the app database and are untouched. */

export interface SecureTokenPort {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

export interface AccountSummary {
  userId: string;
  providers: { provider: string; verified: boolean }[];
}

export interface AccountClient {
  currentSession(): Promise<string | null>;
  account(): Promise<AccountSummary | null>;
  anonymousSignIn(): Promise<void>;
  signUp(email: string, password: string): Promise<void>;
  verifyEmail(token: string): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  linkEmail(email: string, password?: string): Promise<void>;
  linkProvider(provider: "google" | "apple", idToken: string): Promise<void>;
  signOut(): Promise<void>;
  forgotPassword(email: string): Promise<void>;
  resetPassword(token: string, password: string): Promise<void>;
}

export class AuthApiError extends Error {
  name = "AuthApiError";
  constructor(readonly status: number, readonly code: string) {
    super(`auth failed: ${code} (${status})`);
  }
}

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{
  status: number;
  json(): Promise<Record<string, unknown>>;
}>;

export interface CreateAccountClientOptions {
  baseUrl: string;
  tokens: SecureTokenPort;
  fetchImpl?: FetchLike;
}

export function createAccountClient(
  options: CreateAccountClientOptions,
): AccountClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  async function call(
    method: "GET" | "POST",
    path: string,
    payload?: unknown,
    token?: string | null,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (token !== undefined && token !== null)
      headers.authorization = `Bearer ${token}`;
    const response = await doFetch(`${base}${path}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const body = await response.json();
    if (response.status >= 400)
      throw new AuthApiError(
        response.status,
        typeof body.code === "string" ? body.code : "unknown",
      );
    return body;
  }

  async function adopt(body: Record<string, unknown>): Promise<void> {
    if (typeof body.token === "string") await options.tokens.set(body.token);
  }

  const client: AccountClient = {
    currentSession: () => options.tokens.get(),
    async account() {
      const token = await options.tokens.get();
      if (token === null) return null;
      try {
        const body = await call("GET", "/auth/session", undefined, token);
        return {
          userId: String(body.userId),
          providers: (body.providers as AccountSummary["providers"]) ?? [],
        };
      } catch (error) {
        if (error instanceof AuthApiError && error.status === 401) {
          await options.tokens.clear(); // stale token on device
          return null;
        }
        throw error;
      }
    },
    async anonymousSignIn() {
      await adopt(await call("POST", "/auth/anonymous", {}));
    },
    async signUp(email, password) {
      await call("POST", "/auth/sign-up", { email, password });
    },
    async verifyEmail(token) {
      await call("POST", "/auth/verify-email", { token });
    },
    async signIn(email, password) {
      await adopt(await call("POST", "/auth/sign-in", { email, password }));
    },
    async linkEmail(email, password) {
      const token = await options.tokens.get();
      await call(
        "POST",
        "/auth/link",
        { email, ...(password === undefined ? {} : { password }) },
        token,
      );
    },
    async linkProvider(provider, idToken) {
      const token = await options.tokens.get();
      await call("POST", "/auth/link", { provider, idToken }, token);
    },
    async signOut() {
      const token = await options.tokens.get();
      if (token !== null) await call("POST", "/auth/logout", {}, token);
      // Token removal is the device-visible effect of signing out.
      await options.tokens.clear();
    },
    async forgotPassword(email) {
      await call("POST", "/auth/forgot-password", { email });
    },
    async resetPassword(token, password) {
      await call("POST", "/auth/reset-password", { token, password });
    },
  };
  return client;
}

export function secureStoreTokenPort(
  store: {
    getItemAsync(key: string): Promise<string | null>;
    setItemAsync(key: string, value: string): Promise<void>;
    deleteItemAsync(key: string): Promise<void>;
  },
  key = "authSessionV1",
): SecureTokenPort {
  return {
    async get() {
      return await store.getItemAsync(key);
    },
    async set(token) {
      await store.setItemAsync(key, token);
    },
    async clear() {
      await store.deleteItemAsync(key);
    },
  };
}
