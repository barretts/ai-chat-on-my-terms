import { describe, expect, it } from "vitest";
import {
  AuthApiError,
  createAccountClient,
  secureStoreTokenPort,
} from "./client";

type Recorded = { method: string; url: string; hasAuth: boolean };

function memoryTokens(initial: string | null = null) {
  let current = initial;
  const calls: string[] = [];
  return {
    calls,
    async get() {
      calls.push("get");
      return current;
    },
    async set(token: string) {
      calls.push("set");
      current = token;
    },
    async clear() {
      calls.push("clear");
      current = null;
    },
    peek: () => current,
  };
}

function fakeService(responder: (req: Recorded & { body?: string }) => {
  status: number;
  body: Record<string, unknown>;
}) {
  const recorded: Recorded[] = [];
  return {
    recorded,
    fetchImpl: async (
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ) => {
      const req = {
        method: init.method,
        url,
        hasAuth: init.headers.authorization !== undefined,
        ...(init.body === undefined ? {} : { body: init.body }),
      };
      recorded.push(req);
      const result = responder(req);
      return {
        status: result.status,
        json: async () => result.body,
      };
    },
  };
}

describe("account client", () => {
  it("sign-in stores the session token in device-secure storage", async () => {
    const tokens = memoryTokens();
    const service = fakeService(() => ({
      status: 200,
      body: { token: "tok-123" },
    }));
    const client = createAccountClient({
      baseUrl: "https://account.example/",
      tokens,
      fetchImpl: service.fetchImpl,
    });
    await client.signIn("a@b.co", "longenough1");
    expect(tokens.peek()).toBe("tok-123");
    expect(await client.currentSession()).toBe("tok-123");
    expect(service.recorded[0].url).toBe("https://account.example/auth/sign-in");
  });

  it("sign-out removes only the session token; only auth routes are called", async () => {
    const tokens = memoryTokens("tok-123");
    const service = fakeService((req) =>
      req.url.endsWith("/auth/logout")
        ? { status: 200, body: { removed: true } }
        : { status: 401, body: { code: "no-session" } },
    );
    const client = createAccountClient({
      baseUrl: "https://account.example",
      tokens,
      fetchImpl: service.fetchImpl,
    });
    await client.signOut();
    expect(tokens.peek()).toBeNull();
    // Every request stayed under /auth/: no data endpoint was touched, so
    // local chats cannot be affected by signing out.
    expect(service.recorded.map((r) => r.url)).toEqual([
      "https://account.example/auth/logout",
    ]);
    expect(await client.currentSession()).toBeNull();
  });

  it("a stale stored token is cleared on first 401", async () => {
    const tokens = memoryTokens("expired-token");
    const service = fakeService(() => ({
      status: 401,
      body: { code: "no-session" },
    }));
    const client = createAccountClient({
      baseUrl: "https://account.example",
      tokens,
      fetchImpl: service.fetchImpl,
    });
    expect(await client.account()).toBeNull();
    expect(tokens.peek()).toBeNull();
    expect(service.recorded[0].hasAuth).toBe(true);
  });

  it("failed sign-ins surface the service code and store nothing", async () => {
    const tokens = memoryTokens();
    const service = fakeService(() => ({
      status: 401,
      body: { code: "invalid-credentials" },
    }));
    const client = createAccountClient({
      baseUrl: "https://account.example",
      tokens,
      fetchImpl: service.fetchImpl,
    });
    await expect(client.signIn("a@b.co", "wrong")).rejects.toBeInstanceOf(
      AuthApiError,
    );
    expect(tokens.peek()).toBeNull();
  });

  it("conflicting links surface the identity-conflict code", async () => {
    const tokens = memoryTokens("tok-anon");
    const service = fakeService(() => ({
      status: 409,
      body: { code: "identity-conflict" },
    }));
    const client = createAccountClient({
      baseUrl: "https://account.example",
      tokens,
      fetchImpl: service.fetchImpl,
    });
    await expect(client.linkEmail("taken@b.co")).rejects.toMatchObject({
      code: "identity-conflict",
      status: 409,
    });
    expect(service.recorded[0].hasAuth).toBe(true);
  });

  it("the secure-store adapter uses one dedicated key", async () => {
    const items = new Map<string, string>();
    const keychain = {
      async getItemAsync(key: string) {
        return items.get(key) ?? null;
      },
      async setItemAsync(key: string, value: string) {
        items.set(key, value);
      },
      async deleteItemAsync(key: string) {
        items.delete(key);
      },
    };
    const port = secureStoreTokenPort(keychain);
    await port.set("secret-session");
    expect(items.get("authSessionV1")).toBe("secret-session");
    await port.clear();
    expect(await port.get()).toBeNull();
    expect(items.size).toBe(0);
  });
});
