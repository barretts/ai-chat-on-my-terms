import type { EntityId } from "@locallab/contracts/identity";
import {
  MediaJobService,
  SqliteMediaReviewStore,
} from "@locallab/media-engine";
import {
  SqliteMediaServerConfigStore,
  SqliteMediaSettingsStore,
  buildMediaBackend,
  type MediaBackendSelection,
  type MediaFailure,
  type MediaServerConfig,
} from "@locallab/media-integration";
import type { ComfySocketLike } from "@locallab/media-comfyui";
import type { BlobStore } from "@locallab/storage-blobs";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { createMobileJobScheduler } from "../../platform/jobs";

/** Stable local device identity for job leases (single-user phones). */
const MEDIA_DEVICE_ID: EntityId =
  "00000000-0000-7000-8000-000000000159";

/** Host-bound dev default; LAN/API-key backends arrive with T103-class sync. */
const DEFAULT_SERVER: MediaServerConfig = {
  backend: "comfyui",
  baseUrl: "http://127.0.0.1:8188",
};

export interface MediaRuntime {
  /** Present only when a backend passed config validation. */
  service?: MediaJobService;
  settings: SqliteMediaSettingsStore;
  serverConfigs: SqliteMediaServerConfigStore;
  reviews: SqliteMediaReviewStore;
  scheduler: ReturnType<typeof createMobileJobScheduler>;
  selection: MediaBackendSelection;
  failure?: MediaFailure;
}

export interface MediaRuntimeParts {
  db: SQLiteDatabasePort;
  blobs: BlobStore;
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
}

/** Expo/WebSocket → adapter socket shape (progress pushes, never logs urls). */
function comfySocket(url: string): Promise<ComfySocketLike> {
  const { promise, resolve, reject } = Promise.withResolvers<ComfySocketLike>();
  const socket = new WebSocket(url);
  socket.addEventListener("open", () =>
    resolve({
      onMessage: (handler) =>
        socket.addEventListener("message", (event) =>
          handler(String(event.data)),
        ),
      onClose: (handler) =>
        socket.addEventListener("close", () => handler()),
      close: () => socket.close(),
    }),
  );
  socket.addEventListener("error", () =>
    reject(new Error("ComfyUI progress socket could not connect.")),
  );
  return promise;
}

/**
 * Opens every media store, recovers interrupted jobs, and resolves the
 * configured backend. Config failures stay typed (never thrown) so the panel
 * can explain what to fix, matching the integration package's distinctions.
 */
export async function createMediaRuntime(
  parts: MediaRuntimeParts,
): Promise<MediaRuntime> {
  const { db, blobs } = parts;
  const settings = new SqliteMediaSettingsStore(db);
  const serverConfigs = new SqliteMediaServerConfigStore(db);
  const reviews = new SqliteMediaReviewStore(db);
  await settings.initialize();
  await serverConfigs.initialize();
  await reviews.initialize();
  const scheduler = createMobileJobScheduler(db, MEDIA_DEVICE_ID);
  await scheduler.recover();
  const config = (await serverConfigs.load()) ?? DEFAULT_SERVER;
  const selection = buildMediaBackend(config, {
    db,
    blobSink: async (bytes, mimeType) =>
      (await blobs.importBytes(bytes, { mimeType })).id,
    ...(parts.fetchImpl ? { fetchImpl: parts.fetchImpl } : {}),
    socketFactory: comfySocket,
  });
  if (!selection.ok)
    return { settings, serverConfigs, reviews, scheduler, selection, failure: selection.failure };
  const service = new MediaJobService(
    scheduler,
    settings,
    selection.backend,
    reviews,
  );
  return { service, settings, serverConfigs, reviews, scheduler, selection };
}
