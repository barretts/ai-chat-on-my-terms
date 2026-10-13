import {
  type SecretRef,
  type SecretStore,
} from "@locallab/security-secrets";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { SQLiteModelSelectionRepository } from "../../features/models/selection";
import { putProviderCredential } from "./provider-setup-helpers";
import { SQLiteChatProviderRegistry } from "./providers";

/** Fixed id so repeat launches update one row instead of duplicating it. */
export const STRATA_CONNECTION_ID = "00000000-0000-7000-8000-000000000171";
export const STRATA_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
export const STRATA_DEFAULT_MODEL_ID = "qwen3.8-flash-next-iq3_s-128k";

export interface StrataSeedOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  modelId?: string | undefined;
}

async function credentialResolves(
  secrets: SecretStore,
  origin: string,
  ref: SecretRef,
): Promise<boolean> {
  try {
    await secrets.resolveHeaders(origin, [ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Seeds the developer's current omp model (the strata gateway at 127.0.0.1,
 * OpenAI-compatible, Bearer auth) as the default chat connection. The API key
 * reaches the app only through the secure store; without it, app state stays
 * exactly as before.
 */
export async function seedDefaultChatConnection(
  db: SQLiteDatabasePort,
  secrets: SecretStore,
  options: StrataSeedOptions,
): Promise<void> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) return;
  const baseUrl = options.baseUrl?.trim() || STRATA_DEFAULT_BASE_URL;
  const modelId = options.modelId?.trim() || STRATA_DEFAULT_MODEL_ID;
  const origin = new URL(baseUrl).origin;
  const registry = new SQLiteChatProviderRegistry(db);
  await registry.initialize();
  const existing = await registry.get(STRATA_CONNECTION_ID);
  if (existing) {
    if (
      existing.kind !== "compatible" ||
      existing.endpoint !== baseUrl ||
      existing.modelId !== modelId
    )
      return;
    // Web keys live only in the current tab, so a stored reference dangles in
    // each new tab; restore it from the configured key in that case only.
    if (
      existing.credentialRef &&
      (await credentialResolves(secrets, origin, existing.credentialRef))
    )
      return;
    const credential = await putProviderCredential(
      secrets,
      "compatible",
      origin,
      apiKey,
    );
    await registry.save({ ...existing, credentialRef: credential.ref });
    return;
  }
  const credential = await putProviderCredential(
    secrets,
    "compatible",
    origin,
    apiKey,
  );
  await registry.save({
    id: STRATA_CONNECTION_ID,
    label: "omp model (qwen3.8-flash-next 128K)",
    kind: "compatible",
    endpoint: baseUrl,
    modelId,
    credentialRef: credential.ref,
    cleartextAuthorized: true,
    allowCrossProviderRouting: false,
    favorite: true,
  });
  await db.execAsync(
    "CREATE TABLE IF NOT EXISTS phone_model_choice_local (singleton INTEGER PRIMARY KEY CHECK(singleton=1), provider_id TEXT NOT NULL)",
  );
  await db.runAsync(
    "INSERT INTO phone_model_choice_local(singleton,provider_id) VALUES(1,?) ON CONFLICT(singleton) DO NOTHING",
    STRATA_CONNECTION_ID,
  );
  const selections = new SQLiteModelSelectionRepository(db);
  await selections.initialize();
  if (!(await selections.active())) {
    await selections.chooseConnection(STRATA_CONNECTION_ID);
    await selections.selectModel(STRATA_CONNECTION_ID, modelId);
  }
}
