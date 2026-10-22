import type { ProviderPort } from "@locallab/contracts/ports";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { createHttpTransport } from "@locallab/network-http";
import { createCompatibleLocalProvider } from "@locallab/provider-compatible-local";

/**
 * DEV-ONLY group-chat harness (hermetic UI lane).
 *
 * Group rooms normally bind ONLY to installed GGUF models, and the web
 * build refuses local GGUF inference by design — so the room engine could
 * never be driven end-to-end in a browser. This module injects one extra
 * room model whose port is the REAL OpenAI-compatible provider adapter
 * pointed at a developer-run server (`tools/fake-model-server.mjs` by
 * default). Everything downstream — route bootstrap, GroupModelRuntime
 * lease, GroupTurnDriver prompts, selector parsing, name-prefix stripping,
 * the streaming transcript UI — is the untouched product code path.
 *
 * Enabled only in `__DEV__` bundles AND when `EXPO_PUBLIC_DEV_GROUP_HTTP`
 * is set at Metro start. Store builds are already blocked from carrying
 * any `EXPO_PUBLIC_DEV_*` value by the `app.config.js` guard.
 */

/** Sentinel provider row + fixed model-record ids, mirroring the local-GGUF
 * sentinel (…026). The harness never rotates, so ids are stable. */
export const DEV_GROUP_LAB_PROVIDER_ID = "00000000-0000-7000-8000-000000000027";
export const DEV_GROUP_LAB_MODEL_RECORD_ID =
  "00000000-0000-7000-8000-000000000028";

/** Stored `sharedModelId` value for the harness model (picker convention). */
export const DEV_GROUP_LAB_MODEL_ID = "dev:group-lab";

/**
 * The configured harness endpoint as an exact HTTP(S) origin, or null when
 * disabled. Accepts the bare origin or its `/v1` API base; the compatible
 * adapter re-appends `/v1/...` paths itself, so only the origin survives.
 */
export function devGroupLabBaseUrl(
  env: string | undefined = process.env.EXPO_PUBLIC_DEV_GROUP_HTTP,
  dev: boolean = __DEV__,
): string | null {
  if (!dev) return null;
  const raw = env?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    !["", "/", "/v1", "/v1/"].includes(url.pathname)
  )
    return null;
  return url.origin;
}

/** Picker option for the room-settings shared-model dropdown. */
export function devGroupLabChoice(baseUrl: string): {
  value: string;
  label: string;
} {
  return { value: DEV_GROUP_LAB_MODEL_ID, label: `Dev harness — ${baseUrl}` };
}

/** Reuse (or insert) the provider/model rows backing the harness binding. */
export async function ensureDevGroupLabModel(
  db: SQLiteDatabasePort,
  modelId: string = DEV_GROUP_LAB_MODEL_ID,
): Promise<string> {
  await db.runAsync(
    "INSERT INTO providers(id,kind,name,config_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
    DEV_GROUP_LAB_PROVIDER_ID,
    "dev-group-lab",
    "dev-group-lab",
    "{}",
    new Date().toISOString(),
  );
  const existing = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM models WHERE provider_id=? AND name=?",
    DEV_GROUP_LAB_PROVIDER_ID,
    modelId,
  );
  if (existing) return existing.id;
  await db.runAsync(
    "INSERT INTO models(id,provider_id,name,runtime,format,capabilities_json,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
    DEV_GROUP_LAB_MODEL_RECORD_ID,
    DEV_GROUP_LAB_PROVIDER_ID,
    modelId,
    "openai-compat",
    "json",
    JSON.stringify({ streaming: true }),
    new Date().toISOString(),
  );
  return DEV_GROUP_LAB_MODEL_RECORD_ID;
}

/**
 * A live ProviderPort for the harness model: the same
 * `createCompatibleLocalProvider` adapter production uses for
 * OpenAI-compatible connections, bound to the dev endpoint origin.
 */
export function createDevGroupLabPort(baseUrl: string): ProviderPort {
  const origin = new URL(baseUrl).origin;
  const connection = { provider: "custom", origin } as const;
  const transport = createHttpTransport({
    // Browsers reject bare `globalThis.fetch` calls (`Illegal invocation`);
    // invoke through the window receiver like every other call site.
    fetch: (input, init) => globalThis.fetch(input, init),
    policy: {
      authorizedOrigins: [origin],
      cleartextLanOrigins: origin.startsWith("http:") ? [origin] : [],
    },
  });
  const adapter = createCompatibleLocalProvider({
    transport,
    resolveConnection: async () => connection,
  });
  return {
    listModels: (_ignored, signal) => adapter.listModels(connection, signal),
    getCapabilities: (_ignored, modelId, signal) =>
      adapter.getCapabilities(connection, modelId, signal),
    startRun: (request, signal) => adapter.startRun(request, signal),
    dispose: () => adapter.dispose?.(),
  };
}
