import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import type { CapabilityMap } from "@locallab/contracts/ports";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import {
  createWebResearchClient,
  offlineInstructionRequested,
  resolveWebResearchIntent,
  type WebResearchIntent,
} from "./web-research";
import { createBraveResearchClient } from "./brave-web-search";
import { BRAVE_SEARCH_ORIGIN, BRAVE_SEARCH_HEADER } from "./brave-web-search";
import { normalizeSearxngBaseUrl } from "@locallab/tools-searxng";
import { createSearxngResearchClient } from "./searxng-web-search";
import { describeError } from "../../features/diagnostics/errors";

export type WebResearchMode = "auto" | "manual" | "off";
export interface WebResearchSettings {
  provider: "public" | "brave" | "searxng";
  credentialRef: SecretRef | null;
  /** Saved SearXNG instance base URL, or null when any other service is selected. */
  endpoint: string | null;
  /** App-wide automatic web policy. A saved or supplied missing mode defaults to auto. */
  mode?: WebResearchMode;
}
export interface WebResearchSettingsStore {
  read(): Promise<WebResearchSettings>;
  save(value: WebResearchSettings): Promise<void>;
  readConversationOverride(conversationId: string): Promise<WebResearchMode | null>;
  saveConversationOverride(conversationId: string, mode: WebResearchMode): Promise<void>;
  removeConversationOverride(conversationId: string): Promise<void>;
}

/** A conversation with no override inherits the app-wide mode; one with an override always wins. */
export function resolveEffectiveWebResearchMode(
  appWide: WebResearchMode,
  override: WebResearchMode | null,
): WebResearchMode {
  if (appWide !== "auto" && appWide !== "manual" && appWide !== "off")
    throw new Error("Web search settings are unreadable. Save the search service again.");
  if (override !== null && override !== "auto" && override !== "manual" && override !== "off")
    throw new Error("Web search settings are unreadable. Save the search service again.");
  return override ?? appWide;
}

/** One turn's research facts: saved policy, actual model capability and the message. */
export interface WebResearchPolicy {
  effectiveMode: WebResearchMode;
  /** Automatic research tools need auto mode plus an actual yes tool capability. */
  automaticTools: boolean;
  /** Explicitly requested manual research for this turn, kept separate from tool eligibility. */
  intent: WebResearchIntent;
}

/** A conversation with no override inherits the current app-wide mode when the policy resolves. */
export function resolveWebResearchPolicy(options: {
  appWideMode: WebResearchMode;
  conversationOverride: WebResearchMode | null;
  capabilities: CapabilityMap;
  text: string;
  searchEnabled?: boolean | undefined;
  fetchPagesEnabled?: boolean | undefined;
  /** An explicit per-turn off choice vetoes research; the old default-false chip stays neutral. */
  searchOverride?: boolean | undefined;
  previousUserMessages?: readonly string[] | undefined;
}): WebResearchPolicy {
  const effectiveMode = resolveEffectiveWebResearchMode(
    options.appWideMode,
    options.conversationOverride,
  );
  if (effectiveMode === "off")
    return {
      effectiveMode,
      automaticTools: false,
      intent: { search: false, fetchPages: false },
    };
  const vetoed =
    options.searchOverride === false ||
    offlineInstructionRequested(options.text);
  const intent = resolveWebResearchIntent({
    text: options.text,
    searchEnabled: options.searchEnabled,
    fetchPagesEnabled: options.fetchPagesEnabled,
    searchOverride: options.searchOverride,
    previousUserMessages: options.previousUserMessages,
  });
  // A per-turn off choice or offline instruction vetoes search and the automatic
  // tool grant; an enabled page-fetch chip stays neutral, matching the legacy pins.
  return {
    effectiveMode,
    automaticTools:
      !vetoed &&
      effectiveMode === "auto" &&
      options.capabilities.tools === "yes",
    intent: vetoed ? { ...intent, search: false } : intent,
  };
}

/** Keeps the opaque reference available to retry a failed rollback removal. */
export class WebResearchCleanupError extends Error {
  constructor(
    readonly pendingCleanupRef: SecretRef,
    cleanupCause: unknown,
    saveCause: unknown,
  ) {
    super(
      describeError(cleanupCause, {
        operation: "Remove unsaved Brave Search key",
        recovery:
          "The search settings were not saved. Use Retry secure cleanup to remove the pending key.",
      }),
      { cause: saveCause },
    );
    this.name = "WebResearchCleanupError";
  }
}

/** This preference contains only a provider name, an opaque secret reference and the saved mode. */
export class SQLiteWebResearchSettings implements WebResearchSettingsStore {
  private ready: Promise<void> | undefined;
  constructor(private readonly database: SQLiteDatabasePort) {}
  private ensureSchema() {
    this.ready ??= this.database
      .execAsync(
        `CREATE TABLE IF NOT EXISTS web_research_settings_local (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      provider TEXT NOT NULL CHECK (provider IN ('public','brave','searxng')),
      credential_ref TEXT,
      mode TEXT CHECK (mode IN ('auto','manual','off')),
      endpoint TEXT
    );
    CREATE TABLE IF NOT EXISTS web_research_conversation_overrides (
      conversation_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK (mode IN ('auto','manual','off'))
    );`,
      )
      .then(async () => {
        // Upgraded installs keep their existing row; added columns start NULL,
        // which read resolves to the defaults.
        const columns = await this.database.getAllAsync<{ name: string }>(
          "PRAGMA table_info(web_research_settings_local)",
        );
        if (!columns.some((column) => column.name === "mode"))
          await this.database.execAsync(
            "ALTER TABLE web_research_settings_local ADD COLUMN mode TEXT CHECK (mode IN ('auto','manual','off'))",
          );
        const schema = await this.database.getFirstAsync<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='web_research_settings_local'",
        );
        if (!(schema?.sql ?? "").includes("'searxng'")) {
          // The old table forbade the searxng provider in a CHECK constraint;
          // SQLite cannot relax a CHECK in place, so copy the row into a new
          // table and rename. Existing public/brave selections survive intact.
          await this.database.execAsync(
            `CREATE TABLE web_research_settings_v2 (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      provider TEXT NOT NULL CHECK (provider IN ('public','brave','searxng')),
      credential_ref TEXT,
      mode TEXT CHECK (mode IN ('auto','manual','off')),
      endpoint TEXT
    );
    INSERT INTO web_research_settings_v2 (id,provider,credential_ref,mode)
      SELECT id,provider,credential_ref,mode FROM web_research_settings_local;
    DROP TABLE web_research_settings_local;
    ALTER TABLE web_research_settings_v2 RENAME TO web_research_settings_local;`,
          );
        } else if (
          !(
            await this.database.getAllAsync<{ name: string }>(
              "PRAGMA table_info(web_research_settings_local)",
            )
          ).some((column) => column.name === "endpoint")
        )
          await this.database.execAsync(
            "ALTER TABLE web_research_settings_local ADD COLUMN endpoint TEXT",
          );
      })
      .catch((cause) => {
        this.ready = undefined;
        throw cause;
      });
    return this.ready;
  }
  async read(): Promise<WebResearchSettings> {
    await this.ensureSchema();
    const row = await this.database.getFirstAsync<{
      provider: string;
      credential_ref: string | null;
      mode: string | null;
      endpoint: string | null;
    }>(
      "SELECT provider, credential_ref, mode, endpoint FROM web_research_settings_local WHERE id=1",
    );
    const value: WebResearchSettings = row
      ? {
          provider: row.provider as WebResearchSettings["provider"],
          credentialRef: row.credential_ref as SecretRef | null,
          endpoint: row.endpoint ?? null,
          mode: (row.mode ?? "auto") as WebResearchMode,
        }
      : { provider: "public", credentialRef: null, endpoint: null, mode: "auto" };
    validate(value);
    return value;
  }
  async save(value: WebResearchSettings): Promise<void> {
    validate(value);
    await this.ensureSchema();
    await this.database.runAsync(
      "INSERT INTO web_research_settings_local (id,provider,credential_ref,mode,endpoint) VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,credential_ref=excluded.credential_ref,mode=excluded.mode,endpoint=excluded.endpoint",
      value.provider,
      value.credentialRef,
      value.mode ?? null,
      value.endpoint ?? null,
    );
  }
  /** Returns null when the conversation has no stored override; callers fall back to the app-wide mode. */
  async readConversationOverride(
    conversationId: string,
  ): Promise<WebResearchMode | null> {
    await this.ensureSchema();
    const row = await this.database.getFirstAsync<{ mode: string }>(
      "SELECT mode FROM web_research_conversation_overrides WHERE conversation_id=?",
      conversationId,
    );
    return row ? (row.mode as WebResearchMode) : null;
  }
  async saveConversationOverride(
    conversationId: string,
    mode: WebResearchMode,
  ): Promise<void> {
    if (mode !== "auto" && mode !== "manual" && mode !== "off")
      throw new Error("Invalid web research mode");
    await this.ensureSchema();
    await this.database.runAsync(
      "INSERT INTO web_research_conversation_overrides (conversation_id,mode) VALUES (?,?) ON CONFLICT(conversation_id) DO UPDATE SET mode=excluded.mode",
      conversationId,
      mode,
    );
  }
  async removeConversationOverride(conversationId: string): Promise<void> {
    await this.ensureSchema();
    await this.database.runAsync(
      "DELETE FROM web_research_conversation_overrides WHERE conversation_id=?",
      conversationId,
    );
  }
}
function validate(value: WebResearchSettings) {
  const endpoint = value.endpoint ?? null;
  let endpointUrl: URL | undefined;
  if (endpoint !== null)
    try {
      endpointUrl = new URL(endpoint);
    } catch {
      endpointUrl = undefined;
    }
  if (
    !["public", "brave", "searxng"].includes(value.provider) ||
    (value.provider === "searxng" && endpoint === null) ||
    (value.credentialRef !== null &&
      !/^sec_[0-9a-f-]{36}$/i.test(value.credentialRef)) ||
    (value.mode !== undefined &&
      !["auto", "manual", "off"].includes(value.mode)) ||
    (endpoint !== null &&
      (endpointUrl === undefined ||
        (endpointUrl.protocol !== "http:" &&
          endpointUrl.protocol !== "https:") ||
        endpointUrl.username !== "" ||
        endpointUrl.password !== ""))
  )
    throw new Error(
      "Web search settings are unreadable. Save the search service again.",
    );
}

/** Persist only after secure storage succeeds; clean up an uncommitted new key. */
export async function saveWebResearchConfiguration(options: {
  settings: WebResearchSettingsStore;
  secrets: SecretStore;
  provider: WebResearchSettings["provider"];
  /** SearXNG instance URL; required when provider is "searxng", ignored otherwise. */
  endpoint?: string | null;
  mode?: WebResearchMode;
  newKey?: string;
  clearKey?: boolean;
}) {
  const previous = await options.settings.read();
  const endpoint =
    options.provider === "searxng"
      ? normalizeSearxngBaseUrl(options.endpoint ?? "")
      : null;
  let added: SecretRef | undefined;
  let saved = false;
  let primaryFailure: unknown;
  try {
    if (!options.clearKey && options.newKey?.trim())
      added = (
        await options.secrets.put(
          options.provider === "searxng"
            ? new URL(endpoint as string).origin
            : BRAVE_SEARCH_ORIGIN,
          options.provider === "searxng" ? "authorization" : BRAVE_SEARCH_HEADER,
          options.provider === "searxng"
            ? `Bearer ${options.newKey.trim()}`
            : options.newKey.trim(),
        )
      ).ref;
    const value: WebResearchSettings = {
      provider: options.provider,
      credentialRef: options.clearKey
        ? null
        : (added ?? previous.credentialRef),
      endpoint,
      mode: options.mode ?? previous.mode ?? "auto",
    };
    if (value.provider === "brave" && !value.credentialRef)
      throw new Error(
        "Enter a Brave Search API key before choosing Brave Search.",
      );
    await options.settings.save(value);
    saved = true;
    let replacedKeyRemoved = true;
    let cleanupError: unknown;
    if (
      previous.credentialRef &&
      previous.credentialRef !== value.credentialRef
    )
      try {
        await options.secrets.remove(previous.credentialRef);
      } catch (cause) {
        replacedKeyRemoved = false;
        cleanupError = cause;
      }
    return {
      value,
      replacedKeyRemoved,
      ...(!replacedKeyRemoved
        ? { cleanupError, pendingCleanupRef: previous.credentialRef! }
        : {}),
    };
  } catch (cause) {
    primaryFailure = cause;
    throw cause;
  } finally {
    if (added && !saved) {
      try {
        await options.secrets.remove(added);
      } catch (cause) {
        throw new WebResearchCleanupError(added, cause, primaryFailure);
      }
    }
  }
}

/** Reload preferences per send; resolve the selected key only when search runs. */
export async function createConfiguredWebResearchClient(options: {
  settings: WebResearchSettingsStore;
  secrets: SecretStore;
  publicFetch: typeof fetch;
  searchApiFetch: typeof fetch;
  /** Transport for the explicitly configured SearXNG server (may be local HTTP). */
  providerFetch: typeof fetch;
  timeoutMs?: number;
}) {
  const selected = await options.settings.read();
  const publicClient = createWebResearchClient(
    options.publicFetch,
    options.timeoutMs,
  );
  if (selected.provider === "brave")
    return createBraveResearchClient({
      publicClient,
      secrets: options.secrets,
      credentialRef: selected.credentialRef,
      fetcher: options.searchApiFetch,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    });
  if (selected.provider === "searxng")
    return createSearxngResearchClient({
      publicClient,
      secrets: options.secrets,
      credentialRef: selected.credentialRef,
      endpoint: selected.endpoint,
      fetcher: options.providerFetch,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    });
  return publicClient;
}
