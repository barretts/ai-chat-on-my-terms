import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  HostScopedSecretStore,
  type SecretRef,
  type SecretStore,
} from "@locallab/security-secrets";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import {
  resolveEffectiveWebResearchMode,
  resolveWebResearchPolicy,
  saveWebResearchConfiguration,
  SQLiteWebResearchSettings,
  type WebResearchMode,
} from "./web-research-settings";
import { BRAVE_SEARCH_ORIGIN } from "./brave-web-search";

const ref = "sec_00000000-0000-4000-8000-000000000001" as SecretRef;

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

function keyStore(): SecretStore {
  const store = new Map<string, string>();
  return new HostScopedSecretStore(
    {
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => {
        store.set(key, value);
      },
      delete: async (key) => {
        store.delete(key);
      },
    },
    "settings-test",
    () => "00000000-0000-4000-8000-000000000001",
  );
}

it("defaults the app-wide mode to auto and persists manual or off across reopening", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const settings = new SQLiteWebResearchSettings(sqlitePort(database));
    expect(await settings.read()).toMatchObject({ mode: "auto" });
    await settings.save({
      provider: "public",
      credentialRef: null,
      mode: "manual",
    });
    expect(
      await new SQLiteWebResearchSettings(sqlitePort(database)).read(),
    ).toEqual({
      provider: "public",
      credentialRef: null,
      endpoint: null,
      mode: "manual",
    });
    await new SQLiteWebResearchSettings(sqlitePort(database)).save({
      provider: "public",
      credentialRef: null,
      mode: "off",
    });
    expect(await settings.read()).toMatchObject({ mode: "off" });
    await settings.save({ provider: "public", credentialRef: null });
    expect(await settings.read()).toMatchObject({ mode: "auto" });
  } finally {
    database.close();
  }
});

it("upgrades an installed table without a mode column without touching the provider or key row", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(
      `CREATE TABLE web_research_settings_local (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        provider TEXT NOT NULL CHECK (provider IN ('public','brave')),
        credential_ref TEXT
      );
      INSERT INTO web_research_settings_local VALUES (1,'brave','${ref}');`,
    );
    const settings = new SQLiteWebResearchSettings(sqlitePort(database));
    expect(await settings.read()).toEqual({
      provider: "brave",
      credentialRef: ref,
      endpoint: null,
      mode: "auto",
    });
    await settings.save({ provider: "brave", credentialRef: ref, mode: "off" });
    expect(
      await new SQLiteWebResearchSettings(sqlitePort(database)).read(),
    ).toEqual({
      provider: "brave",
      credentialRef: ref,
      endpoint: null,
      mode: "off",
    });
  } finally {
    database.close();
  }
});

it("keeps the saved mode while adding, replacing or removing the search key", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const settings = new SQLiteWebResearchSettings(sqlitePort(database));
    await settings.save({
      provider: "public",
      credentialRef: null,
      mode: "manual",
    });
    const secure = keyStore();
    await saveWebResearchConfiguration({
      settings,
      secrets: secure,
      provider: "brave",
      newKey: "private-fixture-token",
    });
    expect(
      await new SQLiteWebResearchSettings(sqlitePort(database)).read(),
    ).toEqual({
      provider: "brave",
      credentialRef: ref,
      endpoint: null,
      mode: "manual",
    });
    await saveWebResearchConfiguration({
      settings,
      secrets: secure,
      provider: "brave",
      newKey: "replacement-fixture-token",
    });
    expect(await settings.read()).toMatchObject({
      provider: "brave",
      mode: "manual",
    });
    await saveWebResearchConfiguration({
      settings,
      secrets: secure,
      provider: "public",
      clearKey: true,
    });
    expect(
      await new SQLiteWebResearchSettings(sqlitePort(database)).read(),
    ).toEqual({
      provider: "public",
      credentialRef: null,
      endpoint: null,
      mode: "manual",
    });
  } finally {
    database.close();
  }
});

it("rejects an unreadable mode instead of silently changing the saved policy", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const settings = new SQLiteWebResearchSettings(sqlitePort(database));
    await settings.save({
      provider: "public",
      credentialRef: null,
      mode: "off",
    });
    await expect(
      settings.save({
        provider: "public",
        credentialRef: null,
        mode: "silent" as WebResearchMode,
      }),
    ).rejects.toThrow(/unreadable/);
    expect(await settings.read()).toMatchObject({ mode: "off" });
  } finally {
    database.close();
  }
});

it("persists conversation overrides across reopening", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const settings = new SQLiteWebResearchSettings(sqlitePort(database));
    expect(await settings.readConversationOverride("missing")).toBeNull();
    await settings.saveConversationOverride("chat-a", "manual");
    expect(
      await new SQLiteWebResearchSettings(sqlitePort(database)).readConversationOverride("chat-a"),
    ).toBe("manual");
    await settings.saveConversationOverride("chat-a", "off");
    expect(
      await new SQLiteWebResearchSettings(sqlitePort(database)).readConversationOverride("chat-a"),
    ).toBe("off");
  } finally {
    database.close();
  }
});

it("resolves the app-wide mode once a conversation override is removed", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const settings = new SQLiteWebResearchSettings(sqlitePort(database));
    await settings.save({ provider: "public", credentialRef: null, mode: "manual" });
    await settings.saveConversationOverride("chat-a", "off");
    expect(
      resolveEffectiveWebResearchMode(
        "manual",
        await settings.readConversationOverride("chat-a"),
      ),
    ).toBe("off");
    await settings.removeConversationOverride("chat-a");
    expect(await settings.readConversationOverride("chat-a")).toBeNull();
    expect(
      resolveEffectiveWebResearchMode(
        await settings.read().then((value) => value.mode),
        await settings.readConversationOverride("chat-a"),
      ),
    ).toBe("manual");
    expect(
      resolveEffectiveWebResearchMode(
        "auto",
        "auto",
      ),
    ).toBe("auto");
  } finally {
    database.close();
  }
});

it("keeps overrides isolated between conversations", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const settings = new SQLiteWebResearchSettings(sqlitePort(database));
    await settings.save({ provider: "public", credentialRef: null, mode: "off" });
    await settings.saveConversationOverride("chat-a", "manual");
    await settings.saveConversationOverride("chat-b", "auto");
    expect(await settings.readConversationOverride("chat-b")).toBe("auto");
    expect(
      await new SQLiteWebResearchSettings(sqlitePort(database)).readConversationOverride("chat-a"),
    ).toBe("manual");
    await settings.removeConversationOverride("chat-a");
    expect(await settings.readConversationOverride("chat-a")).toBeNull();
    expect(await settings.readConversationOverride("chat-b")).toBe("auto");
  } finally {
    database.close();
  }
});

it("grants automatic tools only to auto mode with an actual yes tool capability", () => {
  expect(
    resolveWebResearchPolicy({
      appWideMode: "auto",
      conversationOverride: null,
      capabilities: { tools: "yes" },
      text: "What is new with Expo?",
    }).automaticTools,
  ).toBe(true);
  for (const capabilities of [
    { tools: "no" as const },
    { tools: "unknown" as const },
    {},
  ])
    expect(
      resolveWebResearchPolicy({
        appWideMode: "auto",
        conversationOverride: null,
        capabilities,
        text: "What is new with Expo?",
      }).automaticTools,
    ).toBe(false);
});

it("keeps explicitly requested manual search and link reading when the capability blocks automatic tools", () => {
  for (const tools of ["no", "unknown"] as const) {
    const policy = resolveWebResearchPolicy({
      appWideMode: "auto",
      conversationOverride: null,
      capabilities: { tools },
      text: "Check web for Expo SDK changes and read https://docs.expo.dev",
    });
    expect(policy.automaticTools).toBe(false);
    expect(policy.intent.search).toBe(true);
    expect(policy.intent.fetchPages).toBe(true);
  }
});

it("never grants automatic tools in manual mode and inherits the current app-wide default", () => {
  const policy = resolveWebResearchPolicy({
    appWideMode: "manual",
    conversationOverride: null,
    capabilities: { tools: "yes" },
    text: "Please search the web for Expo SDK changes",
  });
  expect(policy.effectiveMode).toBe("manual");
  expect(policy.automaticTools).toBe(false);
  expect(policy.intent.search).toBe(true);
  const overriding = resolveWebResearchPolicy({
    appWideMode: "off",
    conversationOverride: "manual",
    capabilities: { tools: "yes" },
    text: "Please search the web for Expo SDK changes",
  });
  expect(overriding.effectiveMode).toBe("manual");
  expect(overriding.intent.search).toBe(true);
});

it("vetoes every research request in off mode despite chips, capability or explicit wording", () => {
  for (const conversationOverride of [null, "off" as const]) {
    const policy = resolveWebResearchPolicy({
      appWideMode: conversationOverride === null ? "off" : "auto",
      conversationOverride,
      capabilities: { tools: "yes" },
      text: "Check web for Expo SDK changes",
      searchEnabled: true,
      fetchPagesEnabled: true,
      searchOverride: true,
    });
    expect(policy.effectiveMode).toBe("off");
    expect(policy.automaticTools).toBe(false);
    expect(policy.intent).toEqual({ search: false, fetchPages: false });
  }
});

it("vetoes search and tool grants for a per-turn off choice or offline instruction while an enabled fetch chip stays neutral", () => {
  const offChoice = resolveWebResearchPolicy({
    appWideMode: "auto",
    conversationOverride: null,
    capabilities: { tools: "yes" },
    text: "Check web for Expo SDK changes",
    searchOverride: false,
  });
  expect(offChoice.automaticTools).toBe(false);
  expect(offChoice.intent.search).toBe(false);
  const offFetch = resolveWebResearchPolicy({
    appWideMode: "auto",
    conversationOverride: null,
    capabilities: { tools: "yes" },
    text: "Read https://docs.expo.dev",
    searchOverride: false,
    fetchPagesEnabled: true,
  });
  expect(offFetch.automaticTools).toBe(false);
  expect(offFetch.intent.search).toBe(false);
  expect(offFetch.intent.fetchPages).toBe(true);
  const offline = resolveWebResearchPolicy({
    appWideMode: "auto",
    conversationOverride: null,
    capabilities: { tools: "yes" },
    text: "Answer offline: what changed in the new Expo release?",
  });
  expect(offline.automaticTools).toBe(false);
  expect(offline.intent).toEqual({ search: false, fetchPages: false });
  const phrasing = resolveWebResearchPolicy({
    appWideMode: "auto",
    conversationOverride: null,
    capabilities: { tools: "yes" },
    text: "Do not look this up online.",
  });
  expect(phrasing.automaticTools).toBe(false);
  expect(phrasing.intent).toEqual({ search: false, fetchPages: false });
  for (const [text, search] of [
    ["What is new with Expo?", false],
    ["Check web for Expo SDK changes", true],
  ] as const) {
    expect(
      resolveWebResearchPolicy({
        appWideMode: "auto",
        conversationOverride: null,
        capabilities: { tools: "yes" },
        text,
        searchEnabled: false,
      }).intent.search,
    ).toBe(search);
  }
});

it("persists a SearXNG server address across reopening and refuses incomplete rows", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const settings = new SQLiteWebResearchSettings(sqlitePort(database));
    await settings.save({
      provider: "searxng",
      credentialRef: null,
      endpoint: "http://search.invalid-lab.example:8888/",
      mode: "auto",
    });
    expect(
      await new SQLiteWebResearchSettings(sqlitePort(database)).read(),
    ).toEqual({
      provider: "searxng",
      credentialRef: null,
      endpoint: "http://search.invalid-lab.example:8888/",
      mode: "auto",
    });
    await expect(
      settings.save({ provider: "searxng", credentialRef: null, mode: "auto" }),
    ).rejects.toThrow(/unreadable/);
    await expect(
      settings.save({
        provider: "searxng",
        credentialRef: null,
        endpoint: "http://user:pass@search.invalid-lab.example/",
      }),
    ).rejects.toThrow(/unreadable/);
    await expect(
      settings.save({
        provider: "searxng",
        credentialRef: null,
        endpoint: "ftp://search.invalid-lab.example/",
      }),
    ).rejects.toThrow(/unreadable/);
  } finally {
    database.close();
  }
});

it("migrates a provider-checking table so SearXNG can be chosen without losing the saved service", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(
      `CREATE TABLE web_research_settings_local (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        provider TEXT NOT NULL CHECK (provider IN ('public','brave')),
        credential_ref TEXT,
        mode TEXT CHECK (mode IN ('auto','manual','off'))
      );
      INSERT INTO web_research_settings_local VALUES (1,'brave','${ref}','manual');`,
    );
    const settings = new SQLiteWebResearchSettings(sqlitePort(database));
    expect(await settings.read()).toEqual({
      provider: "brave",
      credentialRef: ref,
      endpoint: null,
      mode: "manual",
    });
    await settings.save({
      provider: "searxng",
      credentialRef: ref,
      endpoint: "http://search.invalid-lab.example/",
      mode: "manual",
    });
    expect(
      await new SQLiteWebResearchSettings(sqlitePort(database)).read(),
    ).toEqual({
      provider: "searxng",
      credentialRef: ref,
      endpoint: "http://search.invalid-lab.example/",
      mode: "manual",
    });
  } finally {
    database.close();
  }
});

it("keeps the Brave key usable when switching to SearXNG and stores SearXNG keys for their own server", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const settings = new SQLiteWebResearchSettings(sqlitePort(database));
    const secure = keyStore();
    const brave = await saveWebResearchConfiguration({
      settings,
      secrets: secure,
      provider: "brave",
      newKey: "brave-fixture-token",
      mode: "manual",
    });
    const switched = await saveWebResearchConfiguration({
      settings,
      secrets: secure,
      provider: "searxng",
      endpoint: "http://search.invalid-lab.example:8888/",
    });
    expect(switched.value).toMatchObject({
      provider: "searxng",
      endpoint: "http://search.invalid-lab.example:8888",
      mode: "manual",
    });
    expect(await secure.resolveHeaders(BRAVE_SEARCH_ORIGIN, [ref])).toEqual({
      "x-subscription-token": "brave-fixture-token",
    });
    const keyed = await saveWebResearchConfiguration({
      settings,
      secrets: secure,
      provider: "searxng",
      endpoint: "http://127.0.0.1:8899",
      newKey: "searxng-fixture-token",
    });
    expect(keyed.value).toMatchObject({
      provider: "searxng",
      endpoint: "http://127.0.0.1:8899",
    });
    const searxngRef = keyed.value.credentialRef as SecretRef;
    expect(
      await secure.resolveHeaders("http://127.0.0.1:8899", [searxngRef]),
    ).toEqual({ authorization: "Bearer searxng-fixture-token" });
    expect(
      await new SQLiteWebResearchSettings(sqlitePort(database)).read(),
    ).toMatchObject({
      provider: "searxng",
      endpoint: "http://127.0.0.1:8899",
      credentialRef: searxngRef,
    });
  } finally {
    database.close();
  }
});

it("refuses to persist a SearXNG selection whose address cannot be used", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const settings = new SQLiteWebResearchSettings(sqlitePort(database));
    await settings.save({
      provider: "public",
      credentialRef: null,
      endpoint: null,
      mode: "auto",
    });
    await expect(
      saveWebResearchConfiguration({
        settings,
        secrets: keyStore(),
        provider: "searxng",
        endpoint: "search.invalid-lab.example",
      }),
    ).rejects.toThrow(/absolute URL|complete HTTP or HTTPS/);
    expect(
      await new SQLiteWebResearchSettings(sqlitePort(database)).read(),
    ).toMatchObject({ provider: "public", endpoint: null });
  } finally {
    database.close();
  }
});
