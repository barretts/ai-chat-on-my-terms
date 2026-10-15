import { z } from "zod";
import { TypedErrorSchema } from "@locallab/contracts/entities";
import { A1111Client, A1111MediaBackend } from "@locallab/media-a1111";
import {
  ComfyUiClient,
  ComfyUiMediaBackend,
  type ComfySocketFactory,
} from "@locallab/media-comfyui";
import {
  MediaSettingsSchema,
  type MediaBackendPort,
  type MediaSettings,
} from "@locallab/media-engine";
import { RecoveringMediaBackend, SqliteServerJobLedger } from "@locallab/media-queue";

export type MediaFailure = z.infer<typeof TypedErrorSchema>;

/** Backends selectable in Settings; coreml only resolves on eligible iPhones. */
export const MEDIA_BACKEND_IDS = ["comfyui", "a1111", "coreml"] as const;
export type MediaBackendId = (typeof MEDIA_BACKEND_IDS)[number];

export const MediaServerConfigSchema = z
  .object({
    backend: z.string().min(1),
    baseUrl: z.string().min(1),
  })
  .strict();
export type MediaServerConfig = z.infer<typeof MediaServerConfigSchema>;

export interface MediaBackendDeps {
  /** Durable ledger database for reconnect/resume bookkeeping. */
  db: {
    execAsync(sql: string): Promise<void>;
    runAsync(sql: string, ...params: unknown[]): Promise<unknown>;
    getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  };
  /** Managed blob write; returns the stored ref. Never logged. */
  blobSink: (bytes: Uint8Array, mimeType: string) => Promise<string>;
  fetchImpl?: (
    url: string,
    init?: {
      method?: string;
      body?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    },
  ) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
  socketFactory?: ComfySocketFactory;
  /** Injected only on hardware where Core ML exists (T088 device build). */
  coremlBackend?: MediaBackendPort;
  mimeType?: string;
}

export type MediaBackendSelection =
  | { ok: true; backend: MediaBackendPort; backendId: MediaBackendId }
  | { ok: false; failure: MediaFailure };

/**
 * Build-time config validation distinguishes the four operator-visible
 * mistakes: an unknown or ineligible backend id (`unsupported`), a malformed
 * server URL (`malformed`), and — at call time — the adapters' own typed
 * errors for missing API endpoints (`unsupported`), missing checkpoints
 * (`missing-model`) and unreachable transports (`offline`).
 */
export function buildMediaBackend(
  config: MediaServerConfig,
  deps: MediaBackendDeps,
): MediaBackendSelection {
  const failure = (code: MediaFailure["code"], message: string): MediaFailure => ({
    code,
    message,
    recoverable: code !== "malformed",
  });
  if (!MEDIA_BACKEND_IDS.includes(config.backend as MediaBackendId))
    return {
      ok: false,
      failure: failure(
        "unsupported",
        `No such image backend: "${config.backend}". Choose ComfyUI, A1111 or Core ML in Settings.`,
      ),
    };
  const backendId = config.backend as Exclude<MediaBackendId, "coreml">;
  if (config.backend === "coreml") {
    if (!deps.coremlBackend)
      return {
        ok: false,
        failure: failure(
          "unsupported",
          "Core ML image generation is only available on an eligible iPhone. Choose ComfyUI or A1111.",
        ),
      };
    return { ok: true, backend: deps.coremlBackend, backendId: "coreml" };
  }
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    return {
      ok: false,
      failure: failure(
        "malformed",
        `"${config.baseUrl}" is not a valid server address.`,
      ),
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return {
      ok: false,
      failure: failure(
        "malformed",
        "Image servers must be reached over http or https.",
      ),
    };
  const inner: MediaBackendPort =
    config.backend === "comfyui"
      ? new ComfyUiMediaBackend(
          new ComfyUiClient(url.toString(), {
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
            ...(deps.socketFactory ? { socketFactory: deps.socketFactory } : {}),
          }),
          deps.blobSink,
          deps.mimeType,
        )
      : new A1111MediaBackend(
          new A1111Client(url.toString(), deps.fetchImpl),
          deps.blobSink,
          deps.mimeType,
        );
  return {
    ok: true,
    backend: new RecoveringMediaBackend(
      inner,
      new SqliteServerJobLedger(deps.db),
      backendId,
    ),
    backendId,
  };
}

const SETTINGS_ROW = "media";

/** Durable Settings-page media toggles (single-row JSON). */
export class SqliteMediaSettingsStore {
  constructor(private readonly db: {
    execAsync(sql: string): Promise<void>;
    runAsync(sql: string, ...params: unknown[]): Promise<unknown>;
    getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  }) {}

  initialize(): Promise<void> {
    return this.db.execAsync(`
CREATE TABLE IF NOT EXISTS media_settings (
  id TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json))
);`);
  }

  async load(): Promise<MediaSettings> {
    const row = await this.db.getFirstAsync<{ value_json: string }>(
      `SELECT value_json FROM media_settings WHERE id = ?`,
      SETTINGS_ROW,
    );
    if (!row)
      return MediaSettingsSchema.parse({
        enabled: false,
        promptReview: false,
        autoGenerate: false,
      });
    return MediaSettingsSchema.parse(JSON.parse(row.value_json));
  }

  async save(settings: MediaSettings): Promise<void> {
    const next = MediaSettingsSchema.parse(settings);
    await this.db.runAsync(
      `INSERT INTO media_settings (id, value_json) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json`,
      SETTINGS_ROW,
      JSON.stringify(next),
    );
  }
}

/** Durable media server pick (host-bound URLs only; never logged). */
export class SqliteMediaServerConfigStore {
  constructor(private readonly db: {
    execAsync(sql: string): Promise<void>;
    runAsync(sql: string, ...params: unknown[]): Promise<unknown>;
    getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  }) {}

  initialize(): Promise<void> {
    return this.db.execAsync(`
CREATE TABLE IF NOT EXISTS media_server_config (
  id TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json))
);`);
  }

  async load(): Promise<MediaServerConfig | undefined> {
    const row = await this.db.getFirstAsync<{ value_json: string }>(
      `SELECT value_json FROM media_server_config WHERE id = ?`,
      SETTINGS_ROW,
    );
    return row ? MediaServerConfigSchema.parse(JSON.parse(row.value_json)) : undefined;
  }

  async save(config: MediaServerConfig): Promise<void> {
    const next = MediaServerConfigSchema.parse(config);
    await this.db.runAsync(
      `INSERT INTO media_server_config (id, value_json) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json`,
      SETTINGS_ROW,
      JSON.stringify(next),
    );
  }
}
