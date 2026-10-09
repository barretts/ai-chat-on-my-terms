import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { createWebResearchClient } from "./web-research";
import { createBraveResearchClient } from "./brave-web-search";
import { BRAVE_SEARCH_ORIGIN, BRAVE_SEARCH_HEADER } from "./brave-web-search";
import { describeError } from "../../features/diagnostics/errors";

export interface WebResearchSettings {
  provider: "public" | "brave";
  credentialRef: SecretRef | null;
}
export interface WebResearchSettingsStore {
  read(): Promise<WebResearchSettings>;
  save(value: WebResearchSettings): Promise<void>;
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

/** This preference contains only a provider name and an opaque secret reference. */
export class SQLiteWebResearchSettings implements WebResearchSettingsStore {
  private ready: Promise<void> | undefined;
  constructor(private readonly database: SQLiteDatabasePort) {}
  private ensureSchema() {
    this.ready ??= this.database
      .execAsync(
        `CREATE TABLE IF NOT EXISTS web_research_settings_local (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      provider TEXT NOT NULL CHECK (provider IN ('public','brave')),
      credential_ref TEXT
    )`,
      )
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
    }>(
      "SELECT provider, credential_ref FROM web_research_settings_local WHERE id=1",
    );
    const value: WebResearchSettings = row
      ? {
          provider: row.provider as WebResearchSettings["provider"],
          credentialRef: row.credential_ref as SecretRef | null,
        }
      : { provider: "public", credentialRef: null };
    validate(value);
    return value;
  }
  async save(value: WebResearchSettings): Promise<void> {
    validate(value);
    await this.ensureSchema();
    await this.database.runAsync(
      "INSERT INTO web_research_settings_local (id,provider,credential_ref) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,credential_ref=excluded.credential_ref",
      value.provider,
      value.credentialRef,
    );
  }
}
function validate(value: WebResearchSettings) {
  if (
    !["public", "brave"].includes(value.provider) ||
    (value.credentialRef !== null &&
      !/^sec_[0-9a-f-]{36}$/i.test(value.credentialRef))
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
  newKey?: string;
  clearKey?: boolean;
}) {
  const previous = await options.settings.read();
  let added: SecretRef | undefined;
  let saved = false;
  let primaryFailure: unknown;
  try {
    if (!options.clearKey && options.newKey?.trim())
      added = (
        await options.secrets.put(
          BRAVE_SEARCH_ORIGIN,
          BRAVE_SEARCH_HEADER,
          options.newKey.trim(),
        )
      ).ref;
    const value: WebResearchSettings = {
      provider: options.provider,
      credentialRef: options.clearKey
        ? null
        : (added ?? previous.credentialRef),
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
  timeoutMs?: number;
}) {
  const selected = await options.settings.read();
  const publicClient = createWebResearchClient(
    options.publicFetch,
    options.timeoutMs,
  );
  return selected.provider === "brave"
    ? createBraveResearchClient({
        publicClient,
        secrets: options.secrets,
        credentialRef: selected.credentialRef,
        fetcher: options.searchApiFetch,
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
      })
    : publicClient;
}
