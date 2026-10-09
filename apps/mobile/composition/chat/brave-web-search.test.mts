import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  HostScopedSecretStore,
  type SecretRef,
  type SecretStore,
} from "@locallab/security-secrets";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { createWebResearchClient } from "./web-research";
import {
  BRAVE_SEARCH_ORIGIN,
  createBraveResearchClient,
} from "./brave-web-search";
import {
  createConfiguredWebResearchClient,
  saveWebResearchConfiguration,
  SQLiteWebResearchSettings,
  WebResearchCleanupError,
} from "./web-research-settings";

const ref = "sec_00000000-0000-4000-8000-000000000001" as SecretRef;
const signal = () => new AbortController().signal;
const response = () =>
  new Response(
    JSON.stringify({
      web: {
        results: [
          {
            title: "Expo <b>docs</b>",
            url: "https://docs.expo.dev/",
            description: "Official <b>documentation</b>.",
            extra_snippets: [
              "Additional public excerpt.",
              "Official <b>documentation</b>.",
            ],
          },
          {
            title: "Duplicate",
            url: "https://docs.expo.dev/",
            description: "Duplicate",
          },
          {
            title: "Private",
            url: "http://localhost:8080",
            description: "Must not become a source",
          },
        ],
      },
    }),
  );
const secrets: SecretStore = {
  put: async () => ({
    ref,
    host: BRAVE_SEARCH_ORIGIN,
    headerName: "x-subscription-token",
  }),
  remove: async () => {},
  resolveHeaders: async () => ({
    "x-subscription-token": "fixture-key",
    authorization: "must-not-leak",
  }),
};
function sqlitePort(database: DatabaseSync): SQLiteDatabasePort {
  return {
    execAsync: async (sql) => {
      database.exec(sql);
    },
    runAsync: async (sql, ...values) => database.prepare(sql).run(...values),
    getFirstAsync: async <T,>(
      sql: string,
      ...values: (string | number | null | Uint8Array)[]
    ) => (database.prepare(sql).get(...values) as T) ?? null,
    getAllAsync: async <T,>(
      sql: string,
      ...values: (string | number | null | Uint8Array)[]
    ) => database.prepare(sql).all(...values) as T[],
    withTransactionAsync: async (work) => {
      await work();
    },
  };
}

it("uses the official fixed API and isolated token, parses public snippets and never invents missing sources", async () => {
  let call: { url: string; init?: RequestInit } | undefined;
  const client = createBraveResearchClient({
    publicClient: createWebResearchClient(async () => {
      throw new Error("No public fallback");
    }),
    secrets,
    credentialRef: ref,
    fetcher: async (url, init) => {
      call = { url: String(url), ...(init ? { init } : {}) };
      return response();
    },
  });
  expect(await client.search("Expo   documentation", signal())).toEqual([
    {
      url: "https://docs.expo.dev/",
      title: "Expo docs",
      text: "Official documentation.\nAdditional public excerpt.",
      kind: "search-snippet",
    },
  ]);
  const url = new URL(call!.url);
  expect(url.origin).toBe(BRAVE_SEARCH_ORIGIN);
  expect(url.pathname).toBe("/res/v1/web/search");
  expect(url.searchParams.get("q")).toBe("Expo documentation");
  expect(url.searchParams.get("count")).toBe("5");
  expect(call!.init?.headers).toEqual({
    accept: "application/json",
    "x-subscription-token": "fixture-key",
  });
  expect(call!.init?.credentials).toBe("omit");
  expect(call!.init?.redirect).toBe("error");
});

it("reports key, quota and service problems with redacted upstream details and no service fallback", async () => {
  for (const status of [401, 403, 429, 503]) {
    const client = createBraveResearchClient({
      publicClient: createWebResearchClient(async () => {
        throw new Error("Must not fallback");
      }),
      secrets,
      credentialRef: ref,
      fetcher: async () =>
        new Response("private fixture-key upstream details", { status }),
    });
    await expect(client.search("Question", signal())).rejects.toThrow(
      status === 429
        ? /quota limit/
        : status === 503
          ? /HTTP 503/
          : /rejected the API key/,
    );
  }
  for (const body of [
    "not JSON",
    JSON.stringify({ error: { detail: "fixture-key" } }),
  ]) {
    const client = createBraveResearchClient({
      publicClient: createWebResearchClient(fetch),
      secrets,
      credentialRef: ref,
      fetcher: async () => new Response(body),
    });
    await expect(client.search("Question", signal())).rejects.toThrow(
      /unreadable|no usable/,
    );
  }
});

it("times out through body reading and supports cancellation before key resolution or network requests", async () => {
  const client = createBraveResearchClient({
    publicClient: createWebResearchClient(fetch),
    secrets,
    credentialRef: ref,
    timeoutMs: 10,
    fetcher: async () => new Response(new ReadableStream({ start() {} })),
  });
  await expect(client.search("Question", signal())).rejects.toThrow(
    /timed out/,
  );
  const controller = new AbortController();
  controller.abort();
  let resolved = false;
  const canceled = createBraveResearchClient({
    publicClient: createWebResearchClient(fetch),
    credentialRef: ref,
    secrets: {
      ...secrets,
      resolveHeaders: async () => {
        resolved = true;
        return {};
      },
    },
    fetcher: async () => {
      throw new Error("Must not request");
    },
  });
  await expect(canceled.search("Question", controller.signal)).rejects.toThrow(
    /canceled/,
  );
  expect(resolved).toBe(false);
});

it("persists provider and opaque reference in SQLite while raw key material stays in the secure store", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const store = new Map<string, string>();
    const secure = new HostScopedSecretStore(
      {
        get: async (key) => store.get(key) ?? null,
        set: async (key, value) => {
          store.set(key, value);
        },
        delete: async (key) => {
          store.delete(key);
        },
      },
      "search-test",
      () => "00000000-0000-4000-8000-000000000001",
    );
    const settings = new SQLiteWebResearchSettings(sqlitePort(database));
    expect(await settings.read()).toEqual({
      provider: "public",
      credentialRef: null,
    });
    await saveWebResearchConfiguration({
      settings,
      secrets: secure,
      provider: "brave",
      newKey: "private-fixture-token",
    });
    expect(
      await new SQLiteWebResearchSettings(sqlitePort(database)).read(),
    ).toEqual({ provider: "brave", credentialRef: ref });
    const rows = database
      .prepare("SELECT * FROM web_research_settings_local")
      .all();
    expect(JSON.stringify(rows)).not.toContain("private-fixture-token");
    expect(await secure.resolveHeaders(BRAVE_SEARCH_ORIGIN, [ref])).toEqual({
      "x-subscription-token": "private-fixture-token",
    });
    await expect(
      settings.save({
        provider: "brave",
        credentialRef: "private-fixture-token" as SecretRef,
      }),
    ).rejects.toThrow(/unreadable/);
    await saveWebResearchConfiguration({
      settings,
      secrets: secure,
      provider: "public",
      clearKey: true,
    });
    expect(await settings.read()).toEqual({
      provider: "public",
      credentialRef: null,
    });
    await expect(
      secure.resolveHeaders(BRAVE_SEARCH_ORIGIN, [ref]),
    ).rejects.toThrow(/unavailable/);
  } finally {
    database.close();
  }
});

it("rolls back a new secure value if preference saving fails and keeps the previous setting", async () => {
  const removed: SecretRef[] = [];
  const previous = { provider: "public" as const, credentialRef: null };
  const settings = {
    read: async () => previous,
    save: async () => {
      throw new Error("SQLite write failed");
    },
  };
  await expect(
    saveWebResearchConfiguration({
      settings,
      secrets: {
        ...secrets,
        remove: async (value) => {
          removed.push(value);
        },
      },
      provider: "brave",
      newKey: "fixture-key",
    }),
  ).rejects.toThrow(/SQLite write failed/);
  expect(removed).toEqual([ref]);
  expect(await settings.read()).toEqual(previous);
});

it("does not save a Brave selection when secure storage fails or no key was entered", async () => {
  let saved = false;
  const settings = {
    read: async () => ({ provider: "public" as const, credentialRef: null }),
    save: async () => {
      saved = true;
    },
  };
  await expect(
    saveWebResearchConfiguration({ settings, secrets, provider: "brave" }),
  ).rejects.toThrow(/Enter a Brave/);
  await expect(
    saveWebResearchConfiguration({
      settings,
      secrets: {
        ...secrets,
        put: async () => {
          throw new Error("Secure storage failed");
        },
      },
      provider: "brave",
      newKey: "fixture-key",
    }),
  ).rejects.toThrow(/Secure storage failed/);
  expect(saved).toBe(false);
});

it("preserves both save and secure rollback causes with an opaque reference for retry", async () => {
  const saveCause = new Error("SQLite write failed during fixture save");
  const cleanupCause = new Error(
    "Secure deletion unavailable during fixture rollback",
  );
  try {
    await saveWebResearchConfiguration({
      settings: {
        read: async () => ({ provider: "public", credentialRef: null }),
        save: async () => {
          throw saveCause;
        },
      },
      secrets: {
        ...secrets,
        remove: async () => {
          throw cleanupCause;
        },
      },
      provider: "brave",
      newKey: "fixture-key",
    });
    throw new Error("Expected fixture save to reject");
  } catch (cause) {
    expect(cause).toBeInstanceOf(WebResearchCleanupError);
    const error = cause as WebResearchCleanupError;
    expect(error.pendingCleanupRef).toBe(ref);
    expect(error.cause).toBe(saveCause);
    expect(error.message).toContain(cleanupCause.message);
    expect(error.message).not.toContain("fixture-key");
  }
});

it("reports committed settings separately from failed previous-key removal", async () => {
  const previousRef = "sec_00000000-0000-4000-8000-000000000002" as SecretRef;
  const cleanupCause = new Error(
    "Secure deletion unavailable during fixture replacement",
  );
  let committed: unknown;
  const result = await saveWebResearchConfiguration({
    settings: {
      read: async () => ({ provider: "brave", credentialRef: previousRef }),
      save: async (value) => {
        committed = value;
      },
    },
    secrets: {
      ...secrets,
      remove: async () => {
        throw cleanupCause;
      },
    },
    provider: "brave",
    newKey: "fixture-key",
  });
  expect(committed).toEqual({ provider: "brave", credentialRef: ref });
  expect(result.replacedKeyRemoved).toBe(false);
  expect(result.cleanupError).toBe(cleanupCause);
  expect(result.pendingCleanupRef).toBe(previousRef);
});

it("loads the configured choice per send but never resolves a Brave key for page-only research", async () => {
  let resolved = false;
  let apiRequested = false;
  const client = await createConfiguredWebResearchClient({
    settings: {
      read: async () => ({ provider: "brave", credentialRef: ref }),
      save: async () => {},
    },
    secrets: {
      ...secrets,
      resolveHeaders: async () => {
        resolved = true;
        throw new Error("Unavailable");
      },
    },
    publicFetch: async () =>
      new Response(
        "Title: Expo docs\nMarkdown Content:\nActual public page excerpt.",
      ),
    searchApiFetch: async () => {
      apiRequested = true;
      throw new Error("Must not request");
    },
  });
  expect((await client.fetchPage("https://docs.expo.dev", signal())).kind).toBe(
    "page-excerpt",
  );
  expect(resolved).toBe(false);
  await expect(client.search("Question", signal())).rejects.toThrow(
    /saved Brave Search key is unavailable/,
  );
  expect(apiRequested).toBe(false);
});
