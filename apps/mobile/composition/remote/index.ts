/**
 * T103 (PL-04/PL-05, SY glue) — composition layer wiring the sealed remote
 * session to the phone's chat, photo-upload, and sync features.
 *
 * `RemoteSessionPort` is a structural port: the sibling integration package
 * adapts the pairing client's sealed channel (mobile.toCompanion.seal /
 * fromCompanion.open) to it. This layer owns only conversation bookkeeping:
 * the chat-over-session body convention ({tag:"request"} chat-request /
 * chat-complete, tag:event RunEvent frames, {tag:"cancel"}), segmented
 * binary payloads for camera photos, sync-transport glue, and the revoked-
 * pairing guard. It performs no transport, crypto, or hashing work — the
 * sha256 for a media transfer is supplied by the camera pipeline that
 * captured the bytes (expo-crypto on device), never node:crypto here.
 */
import { createUuidV7 } from "@locallab/remote-crypto";
import {
  EncryptedPayloadSchema,
  MAX_MEDIA_CHUNK_BYTES,
  type EncryptedPayload,
} from "@locallab/service-contracts/relay";
import type { StoredPairing } from "../../features/remote";

export interface RemoteChatMessage {
  role: string;
  content: string;
}

/** Sealed per-pair session channel (structurally satisfied by the client). */
export interface RemoteSessionPort {
  send(payload: EncryptedPayload): void;
  onPayload(cb: (payload: EncryptedPayload) => void): void;
  close(reason?: string): void;
}

export interface RemoteChatConnection {
  /** Relay-routed chat: a logical descriptor, not an HTTP endpoint. */
  baseUrl: string;
  chatPath: string;
  modelId: string;
  streamRun(
    messages: readonly RemoteChatMessage[],
    routeId: string,
    handlers: { onDelta(text: string): void },
  ): Promise<{ runId: string; text: string }>;
  cancelRun(runId: string): void;
}

/** Companion refusal of the sync route (fail-closed for un-opted-in pairs). */
export interface SyncRefused {
  type: "sync-refused";
  reason: string;
}

/**
 * Structural twin of `@locallab/sync-transport`'s `SyncSendPort` (batch
 * payload + UUIDv7 requestId): assignable at the wiring site, so mobile
 * compiles without pulling that package's sources into its program.
 */
export type RemoteSyncSendPort = (
  payload: Extract<EncryptedPayload, { tag: "sync-batch" }>,
  requestId: string,
) => Promise<void>;

export interface RemoteSyncPorts {
  send: RemoteSyncSendPort;
  /** Validate a decrypted sync-ack payload and route it to the transport. */
  handleAck(frame: unknown): boolean;
  /** Latest refusal, if the companion rejected this pair's sync route. */
  refused(): SyncRefused | null;
  /** Composition calls this when it sees the companion's chat-refusal body. */
  refuse(reason?: string): void;
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;
/** Encoded chars for one max-size byte chunk (base64 pads per chunk). */
const MAX_CHUNK_CHARS = 4 * Math.ceil(MAX_MEDIA_CHUNK_BYTES / 3);

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** One in-flight chat run: accumulated deltas + the completion latch. */
interface RunWaiter {
  text: string;
  onDelta(text: string): void;
  settled: PromiseWithResolvers<{ runId: string; text: string }>;
}

function requestSettlement(body: unknown): { type: string; runId: string | null; reason?: string | undefined } | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as { type?: unknown; runId?: unknown; reason?: unknown };
  if (typeof candidate.type !== "string") return null;
  if (candidate.type !== "chat-complete" && candidate.type !== "chat-refused") return null;
  const runId = typeof candidate.runId === "string" ? candidate.runId : null;
  return { type: candidate.type, runId, reason: typeof candidate.reason === "string" ? candidate.reason : undefined };
}

/**
 * Chat-over-sealed-session connection for one paired device. `streamRun`
 * speaks the session body convention and resolves when the companion
 * answers the matching chat-complete frame — or REJECTS with the refusal
 * reason if the companion settles the run with chat-refused (R028: a
 * refusal must never leave the chat screen waiting). Every TextDelta in
 * between feeds `handlers.onDelta` and the accumulated `text`.
 */
export function createRemoteChatConnection(
  session: RemoteSessionPort,
  pairing: { routeId: string; label: string },
): RemoteChatConnection {
  const waiters = new Map<string, RunWaiter>();
  let listening = false;

  function listen(): void {
    if (listening) return;
    listening = true;
    session.onPayload((payload) => {
      if (payload.tag === "event") {
        const waiter = waiters.get(payload.event.runId);
        if (waiter && payload.event.type === "TextDelta") {
          waiter.text += payload.event.text;
          waiter.onDelta(payload.event.text);
        }
        return;
      }
      if (payload.tag !== "request") return;
      const settlement = requestSettlement(payload.body);
      if (settlement === null || settlement.runId === null) return;
      const waiter = waiters.get(settlement.runId);
      if (!waiter) return;
      waiters.delete(settlement.runId);
      // R028: a refusal is terminal — settle the waiter (reject) so the
      // phone's chat never hangs forever on a companion that will not
      // serve the request (unknown chat-request version, policy refusal).
      if (settlement.type === "chat-refused") {
        waiter.settled.reject(new Error(settlement.reason ?? "chat request refused"));
      } else {
        waiter.settled.resolve({ runId: settlement.runId, text: waiter.text });
      }
    });
  }

  return {
    baseUrl: `relay://companion/${pairing.routeId}`,
    chatPath: "/remote-chat",
    modelId: pairing.label,
    streamRun(messages, routeId, handlers) {
      const runId = createUuidV7();
      listen();
      const waiter: RunWaiter = {
        text: "",
        onDelta: handlers.onDelta,
        settled: Promise.withResolvers<{ runId: string; text: string }>(),
      };
      waiters.set(runId, waiter);
      session.send({
        tag: "request",
        body: { type: "chat-request", version: 1, runId, routeId, messages: [...messages], tools: [] },
      });
      return waiter.settled.promise;
    },
    cancelRun(runId) {
      session.send({ tag: "cancel", reason: runId });
    },
  };
}

/**
 * Photo upload segmented into ≤ MAX_MEDIA_CHUNK_BYTES binary payloads.
 * `sha256` is the digest of the bytes as captured: the camera pipeline
 * owns hashing on device, so composition only validates the shape
 * (lowercase/uppercase hex-64) and passes it through to binary-start.
 */
export function photoUploadPort(
  session: RemoteSessionPort,
): (bytes: Uint8Array, mimeType: string, sha256: string) => Promise<void> {
  return async (bytes, mimeType, sha256) => {
    if (!SHA256_HEX.test(sha256)) {
      throw new Error("photo upload needs the sha256 hex digest from the camera pipeline");
    }
    const transferId = createUuidV7();
    session.send({ tag: "binary-start", transferId, mimeType, length: bytes.length, sha256 });
    let index = 0;
    // Each chunk is encoded independently: base64 groups span 3 source
    // bytes and MAX_MEDIA_CHUNK_BYTES boundaries do not land on group
    // multiples, so per-slice encoding is what keeps every chunk
    // decodable on its own for the companion's BinaryReceiver.
    for (let offset = 0; offset < bytes.length; offset += MAX_MEDIA_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(offset + MAX_MEDIA_CHUNK_BYTES, bytes.length));
      session.send({ tag: "binary-chunk", transferId, index, bytesBase64Url: bytesToBase64Url(chunk) });
      index += 1;
    }
    session.send({ tag: "binary-end", transferId });
  };
}

/**
 * Sync glue for one pair: a `SyncSendPort` the SyncTransport hands its
 * batches to (refusing while the pair is not opted in or the companion has
 * refused), plus ack routing so decrypted sync-ack payloads reach the
 * caller's `SyncTransport.handleAck`. No batching/retry logic lives here.
 */
export function remoteSyncPorts(
  session: RemoteSessionPort,
  routeId: string,
  allowed: () => boolean,
  onSyncAck: (payload: Extract<EncryptedPayload, { tag: "sync-ack" }>) => void,
): RemoteSyncPorts {
  let refused: SyncRefused | null = null;
  session.onPayload((payload) => {
    if (payload.tag === "sync-ack") onSyncAck(payload);
  });
  return {
    send: async (payload) => {
      if (refused) throw new Error(`sync refused by the paired device (route ${routeId})`);
      if (!allowed()) throw new Error(`sync is not allowed for this pair (route ${routeId})`);
      session.send(payload);
    },
    handleAck(frame) {
      const parsed = EncryptedPayloadSchema.safeParse(frame);
      if (!parsed.success || parsed.data.tag !== "sync-ack") return false;
      onSyncAck(parsed.data);
      return true;
    },
    refused() {
      return refused;
    },
    refuse(reason) {
      refused = { type: "sync-refused", reason: reason ?? "the paired device refused sync" };
      session.close("sync-refused");
    },
  };
}

/**
 * Remote-use guard: a revoked pairing (revokedAt set) must never open a
 * session or route traffic; the note is the UI-facing re-pair hint.
 */
export function remoteConnectionGuarded(
  pairings: readonly StoredPairing[],
  routeId: string,
): { ok: true } | { ok: false; note: string } {
  const pairing = pairings.find((record) => record.qr.companionRouteId === routeId);
  if (!pairing) return { ok: false, note: "This device is not paired. Scan a fresh QR from the desktop app." };
  if (pairing.revokedAt !== null) return { ok: false, note: `Pairing “${pairing.label}” was revoked. Re-pair from the desktop app to use it again.` };
  return { ok: true };
}
