/**
 * T103 (ER-07) — remote integration gate: a thin session multiplexer over an
 * already-paired sealed session plus the chat / media-binary / selective-sync
 * smoke helpers for the mobile <-> opaque relay <-> companion paths.
 *
 * The handle owns wire mechanics only: outbound payloads seal through the
 * session's SealingChannel with a fresh UUIDv7 requestId and travel as JSON
 * EncryptedRelayFrameV1 strings; inbound JSON frames open through the
 * session's OpeningChannel and failures (replay, foreign route, tampering)
 * surface via the onError listeners — never as exceptions escaping the socket
 * event listener. Sequence/replay state lives in the injected channels, so
 * composition MUST keep ONE session channel object per side across handshake
 * and traffic (a fresh channel restarts at sequence 0 and would trip the
 * peer's replay window). No timers live here: sync waits are driven purely by
 * ack arrivals plus whatever delay SyncTransport injects.
 */
import type { RunEvent } from "@locallab/contracts/run-events";
import {
  BinaryReceiver,
  binaryFrames,
  sha256Hex,
} from "@locallab/remote-binary";
import type { WebSocketLike } from "@locallab/remote-client";
import type { OpeningChannel, SealingChannel } from "@locallab/remote-crypto";
import { createUuidV7 } from "@locallab/remote-crypto";
import {
  validateRelayFrameSize,
  type EncryptedPayload,
  type EncryptedRelayFrameV1,
} from "@locallab/service-contracts/relay";
import type { MergeStore } from "@locallab/sync-merge";
import { SyncTransport } from "@locallab/sync-transport";
export type { SyncTransport };

/** Mobile-side view of one paired session (createSessionPairing().mobile). */
export interface MobileSessionChannel {
  toCompanion: SealingChannel;
  fromCompanion: OpeningChannel;
}

/** Companion-side view of one paired session (createSessionPairing().companion). */
export interface CompanionSessionChannel {
  toMobile: SealingChannel;
  fromMobile: OpeningChannel;
}

/** Both sides of the same pairing, as createSessionPairing returns them. */
export interface SessionChannels {
  mobile: MobileSessionChannel;
  companion: CompanionSessionChannel;
}

export type RemoteSessionChannel = MobileSessionChannel | CompanionSessionChannel;

export interface RemoteSessionHandle {
  /** Seal with a fresh UUIDv7 requestId and push the JSON frame to the socket. */
  send(payload: EncryptedPayload): void;
  /** Receive decrypted payloads; open() failures NEVER reach listeners. */
  onPayload(listener: (payload: EncryptedPayload) => void): void;
  /** Frames whose open() throws (replay/tamper/foreign route) surface here. */
  onError(listener: (error: unknown) => void): void;
  /** Best-effort sealed close payload, then the socket close handshake. */
  close(reason?: string): void;
}

export interface RemoteSessionInput {
  /** One side of a paired session; direction is chosen by its channel shape. */
  channel: RemoteSessionChannel;
  /** The live relay socket for this side (same WebSocketLike shape as the pairing client). */
  socket: WebSocketLike;
}

export function attachRemoteSession(input: RemoteSessionInput): RemoteSessionHandle {
  const { channel, socket } = input;
  const mobile = "toCompanion" in channel;
  const seal = mobile ? channel.toCompanion : channel.toMobile;
  const open = mobile ? channel.fromCompanion : channel.fromMobile;
  const payloadListeners: ((payload: EncryptedPayload) => void)[] = [];
  const errorListeners: ((error: unknown) => void)[] = [];
  socket.addEventListener("message", (event) => {
    let payload: EncryptedPayload;
    try {
      payload = open.open(JSON.parse(String(event.data)));
    } catch (error) {
      // A hostile or replayed frame must never crash the receive loop.
      for (const listener of errorListeners) listener(error);
      return;
    }
    for (const listener of payloadListeners) listener(payload);
  });
  return {
    send(payload) {
      socket.send(JSON.stringify(seal.seal(payload, createUuidV7())));
    },
    onPayload(listener) {
      payloadListeners.push(listener);
    },
    onError(listener) {
      errorListeners.push(listener);
    },
    close(reason) {
      try {
        socket.send(JSON.stringify(seal.seal({ tag: "close", reason }, createUuidV7())));
      } catch {
        // best-effort: the close handshake below still runs
      }
      socket.close(1000, reason);
    },
  };
}

export interface ChatMessage {
  role: string;
  content: string;
}

export interface ChatRequest {
  runId: string;
  routeId: string;
  messages: readonly ChatMessage[];
  tools: readonly unknown[];
}

function isBodyType(body: unknown, type: string): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && "type" in body && body.type === type;
}

/** Mobile side: send the chat-request body convention over the sealed channel. */
export function sendChatRequest(
  handle: RemoteSessionHandle,
  request: ChatRequest,
): void {
  handle.send({
    tag: "request",
    body: {
      type: "chat-request",
      runId: request.runId,
      routeId: request.routeId,
      messages: request.messages,
      tools: request.tools,
    },
  });
}

/**
 * Mobile side: chat-request out, then collect tag:event frames for this runId
 * until the companion's chat-complete request arrives. A close payload (or a
 * sealed close frame) rejects the stream.
 */
export function streamChat(
  handle: RemoteSessionHandle,
  request: ChatRequest,
): Promise<RunEvent[]> {
  const settled = Promise.withResolvers<RunEvent[]>();
  const events: RunEvent[] = [];
  let done = false;
  handle.onPayload((payload) => {
    if (done) return;
    if (payload.tag === "event" && payload.event.runId === request.runId)
      events.push(payload.event);
    else if (
      payload.tag === "request" &&
      isBodyType(payload.body, "chat-complete") &&
      "runId" in payload.body && payload.body.runId === request.runId
    ) {
      done = true;
      settled.resolve(events);
    } else if (payload.tag === "close") {
      done = true;
      settled.reject(new Error(`chat stream closed before completion: ${payload.reason ?? "no reason"}`));
    }
  });
  sendChatRequest(handle, request);
  return settled.promise;
}

/** Companion side: emit the run events, then the chat-complete convention frame. */
export function respondToChat(
  handle: RemoteSessionHandle,
  opts: { runId: string; events: readonly RunEvent[] },
): void {
  for (const event of opts.events) handle.send({ tag: "event", event });
  handle.send({ tag: "request", body: { type: "chat-complete", runId: opts.runId } });
}

/**
 * Mobile side: cancel the active run. The frozen cancel payload carries only
 * the reason (single-run channels); runId is kept in the signature so
 * multi-run channels can route the cancel without an API break.
 */
export function cancelChat(handle: RemoteSessionHandle, runId: string, reason: string): void {
  void runId;
  handle.send({ tag: "cancel", reason });
}

export interface BinaryTransferOptions {
  transferId: string;
  mimeType: string;
}

export interface BinaryTransferResult {
  bytes: Uint8Array;
  sha256: string;
}

/**
 * Mobile side -> companion: stream bytes as sealed binary frames. Resolves
 * once the companion-side receiver assembles a checksum-verified transfer;
 * receiver-side assembly errors reject the promise instead of crashing.
 */
export function sendBinary(
  mobileHandle: RemoteSessionHandle,
  companionHandle: RemoteSessionHandle,
  opts: BinaryTransferOptions,
  bytes: Uint8Array,
): Promise<BinaryTransferResult> {
  const settled = Promise.withResolvers<BinaryTransferResult>();
  const receiver = new BinaryReceiver();
  let done = false;
  companionHandle.onPayload((payload) => {
    if (done) return;
    try {
      if (receiver.push(payload) === "finished") {
        done = true;
        const assembled = receiver.bytes();
        settled.resolve({ bytes: assembled, sha256: sha256Hex(assembled) });
      }
    } catch (error) {
      done = true;
      settled.reject(error);
    }
  });
  for (const payload of binaryFrames({ transferId: opts.transferId, mimeType: opts.mimeType }, bytes))
    mobileHandle.send(payload);
  return settled.promise;
}

export interface SyncGate {
  /** Mirror of the Rust fail-closed sync gate: false refuses the batch. */
  allow: (routeId: string) => boolean;
  reason?: string;
}

/**
 * Companion side: receive one sync-batch payload. With the gate open the
 * changes land in the MergeStore and only ACCEPTED record ids are acked
 * (malformed changes are dropped, never acked). With the gate closed nothing
 * is stored or acked and a sealed sync-refused request goes back instead
 * (fail-closed mirror of the Rust SyncSetup gate).
 */
export function ackSyncBatch(
  handle: RemoteSessionHandle,
  payload: Extract<EncryptedPayload, { tag: "sync-batch" }>,
  store: MergeStore,
  gate?: SyncGate,
): string[] {
  if (gate !== undefined && !gate.allow(payload.records[0]?.entityId ?? "")) {
    handle.send({
      tag: "request",
      body: { type: "sync-refused", reason: gate.reason ?? "sync is off for this pair" },
    });
    return [];
  }
  const accepted: string[] = [];
  for (const change of payload.records) {
    try {
      store.apply(change);
      accepted.push(change.id);
    } catch {
      // Dropped per the transport contract: never ack what the store rejected.
    }
  }
  if (accepted.length > 0) handle.send({ tag: "sync-ack", recordIds: accepted });
  return accepted;
}

/**
 * Mobile side: sync one conversation's records over the sealed handle. The
 * SyncTransport send port rides the handle's sealing channel; companion
 * sync-acks arrive as payloads and feed handleAck. Resolves with the live
 * transport once the queue drains (idle, pendingRecords 0); a sealed
 * sync-refused rejects. Await-based only: no timers here.
 */
export function syncOneConversation(
  mobileHandle: RemoteSessionHandle,
  records: readonly unknown[],
): Promise<SyncTransport> {
  const settled = Promise.withResolvers<SyncTransport>();
  const transport = new SyncTransport({
    routeId: "",
    allowed: () => true,
    send: async (payload) => {
      mobileHandle.send(payload);
    },
  });
  let done = false;
  const finishIfDrained = () => {
    if (done) return;
    const status = transport.status();
    if (status.pendingRecords === 0 && status.resumeCursor > 0) {
      done = true;
      settled.resolve(transport);
    }
  };
  mobileHandle.onPayload((payload) => {
    if (done) return;
    if (payload.tag === "sync-ack") {
      transport.handleAck(payload);
      void transport.sendPending().then(finishIfDrained);
    } else if (payload.tag === "request" && isBodyType(payload.body, "sync-refused")) {
      done = true;
      settled.reject(
        new Error(
          `sync refused by the paired device: ${"reason" in payload.body ? String(payload.body.reason) : "no reason"}`,
        ),
      );
    }
  });
  transport.enqueue(records);
  void transport.sendPending().then(finishIfDrained);
  return settled.promise;
}

/** Envelope-level size guard the composition runs BEFORE sealing/opening. */
export function validateFrameOpaque(frame: EncryptedRelayFrameV1): void {
  validateRelayFrameSize(frame);
}

/** Relay socket wrapper that remembers the last sealed JSON frame written. */
export interface RecordingSocket {
  socket: WebSocketLike;
  sentFrame(): string;
}

/** Public seam: hostile-branch tests replay exact frame bytes without touching sequence state. */
export function recordingSocket(inner: WebSocketLike): RecordingSocket {
  let last = "";
  return {
    socket: {
      send(data) {
        last = data;
        inner.send(data);
      },
      close(code, reason) {
        inner.close(code, reason);
      },
      addEventListener(type, listener) {
        inner.addEventListener(type, listener);
      },
    },
    sentFrame: () => last,
  };
}
