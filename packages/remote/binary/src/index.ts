/**
 * T097 (RE-04, IM-12) — encrypted binary image/speech forwarding.
 *
 * Transport-neutral transfer engine over the frozen relay payload tags
 * (`binary-start` / `binary-chunk` / `binary-end`, `cancel`): declared MIME,
 * bounded declared length, sha256 integrity, chunk de-duplication for slow
 * relays and reconnects, request/run identity carried at the sealing layer
 * (every frame's `requestId` + `MediaReference` run events name the job).
 *
 * Binary stays binary end-to-end (step 3): bytes travel as base64url inside
 * encrypted payloads — never re-encoded through lossy text or JSON escapes.
 * Flow control is credit-based (`BinaryWindow`): a sender may keep only
 * `windowChunks` un-acked chunks in flight; the receiver credits chunks back
 * with `binary-ack` control bodies carried in `request` envelopes.
 */
import { createHash } from "node:crypto";
import {
  MAX_MEDIA_CHUNK_BYTES,
  type EncryptedPayload,
} from "@locallab/service-contracts/relay";

/** Hard bound on one transfer; generous for ComfyUI images and Kokoro audio. */
export const MAX_BINARY_TOTAL_BYTES = 64 * 1024 * 1024;

export class BinaryTransferError extends Error {
  constructor(
    readonly kind: "oversize" | "sequence" | "checksum" | "state",
    message: string,
  ) {
    super(message);
    this.name = "BinaryTransferError";
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x10_000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x10_000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const clean = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface BinarySendMeta {
  transferId: string;
  mimeType: string;
}

/** Sender framing: one start, chunk stream (each <= MAX_MEDIA_CHUNK_BYTES), end. */
export function* binaryFrames(meta: BinarySendMeta, bytes: Uint8Array): Generator<EncryptedPayload> {
  if (meta.mimeType.length === 0 || meta.mimeType.length > 128)
    throw new BinaryTransferError("state", "mimeType must be 1..128 characters");
  if (bytes.length > MAX_BINARY_TOTAL_BYTES)
    throw new BinaryTransferError("oversize", `transfer exceeds ${MAX_BINARY_TOTAL_BYTES} bytes`);
  yield {
    tag: "binary-start",
    transferId: meta.transferId,
    mimeType: meta.mimeType,
    length: bytes.length,
    sha256: sha256Hex(bytes),
  };
  let index = 0;
  for (let offset = 0; offset < bytes.length; offset += MAX_MEDIA_CHUNK_BYTES, index += 1) {
    yield {
      tag: "binary-chunk",
      transferId: meta.transferId,
      index,
      bytesBase64Url: toBase64Url(bytes.subarray(offset, offset + MAX_MEDIA_CHUNK_BYTES)),
    };
  }
  yield { tag: "binary-end", transferId: meta.transferId };
}

export type ReceiveOutcome = "accepted" | "duplicate" | "finished";

/**
 * Receiver assembly. Re-delivered chunks (slow relay, reconnect replay) are
 * idempotent: an already-seen chunk index is counted `duplicate`, never
 * appended twice. Integrity fails closed: gaps, overruns or a sha256
 * mismatch reject the whole transfer.
 */
export class BinaryReceiver {
  private phase: "idle" | "receiving" | "done" = "idle";
  private transferId = "";
  private mimeType = "";
  private length = 0;
  private declaredSha = "";
  private totalBytes = 0;
  private chunks = new Map<number, Uint8Array>();
  private assembled: Uint8Array | undefined;

  push(payload: EncryptedPayload): ReceiveOutcome {
    switch (payload.tag) {
      case "binary-start": {
        if (this.phase !== "idle")
          throw new BinaryTransferError("state", "a transfer is already in progress");
        if (payload.length > MAX_BINARY_TOTAL_BYTES)
          throw new BinaryTransferError("oversize", "declared transfer exceeds the bound");
        this.phase = "receiving";
        this.transferId = payload.transferId;
        this.mimeType = payload.mimeType;
        this.length = payload.length;
        this.declaredSha = payload.sha256.toLowerCase();
        this.totalBytes = 0;
        this.chunks = new Map();
        return "accepted";
      }
      case "binary-chunk": {
        if (this.phase !== "receiving")
          throw new BinaryTransferError("state", "chunk before binary-start");
        if (payload.transferId !== this.transferId)
          throw new BinaryTransferError("state", "chunk belongs to a different transfer");
        const bytes = fromBase64Url(payload.bytesBase64Url);
        if (bytes.length > MAX_MEDIA_CHUNK_BYTES)
          throw new BinaryTransferError("oversize", "chunk exceeds the chunk bound");
        if (this.chunks.has(payload.index)) return "duplicate";
        if (this.totalBytes + bytes.length > this.length)
          throw new BinaryTransferError("oversize", "chunk stream exceeds the declared length");
        this.chunks.set(payload.index, bytes);
        this.totalBytes += bytes.length;
        return "accepted";
      }
      case "binary-end": {
        if (this.phase !== "receiving")
          throw new BinaryTransferError("state", "end before binary-start");
        if (payload.transferId !== this.transferId)
          throw new BinaryTransferError("state", "end belongs to a different transfer");
        if (this.totalBytes !== this.length)
          throw new BinaryTransferError(
            "sequence",
            `transfer ended after ${this.totalBytes} of ${this.length} bytes`,
          );
        const maxIndex = Math.max(...this.chunks.keys());
        if (this.chunks.size !== maxIndex + 1 || !this.chunks.has(0))
          throw new BinaryTransferError("sequence", "transfer is missing chunks");
        const out = new Uint8Array(this.totalBytes);
        let offset = 0;
        for (let index = 0; index <= maxIndex; index += 1) {
          const chunk = this.chunks.get(index);
          if (chunk === undefined) throw new BinaryTransferError("sequence", "missing chunk in gap");
          out.set(chunk, offset);
          offset += chunk.length;
        }
        if (sha256Hex(out) !== this.declaredSha)
          throw new BinaryTransferError("checksum", "assembled bytes do not match the declared sha256");
        this.assembled = out;
        this.phase = "done";
        return "finished";
      }
      case "cancel": {
        this.reset();
        return "accepted";
      }
      default:
        throw new BinaryTransferError("state", "payload is not a binary transfer frame");
    }
  }

  reset(): void {
    this.phase = "idle";
    this.transferId = "";
    this.mimeType = "";
    this.length = 0;
    this.declaredSha = "";
    this.totalBytes = 0;
    this.chunks = new Map();
    this.assembled = undefined;
  }

  bytes(): Uint8Array {
    if (this.phase !== "done" || this.assembled === undefined)
      throw new BinaryTransferError("state", "transfer has not completed");
    return this.assembled;
  }

  mime(): string {
    return this.mimeType;
  }
}

/** Credit accounting: at most `windowChunks` un-acked chunks stay in flight. */
export class BinaryWindow {
  private sent = 0;
  private ackedThrough = -1;

  constructor(private readonly windowChunks: number) {
    if (windowChunks < 1) throw new BinaryTransferError("state", "window must be >= 1 chunk");
  }

  canSend(): boolean {
    return this.sent - (this.ackedThrough + 1) < this.windowChunks;
  }

  onSent(): void {
    this.sent += 1;
  }

  ack(index: number): void {
    if (index > this.ackedThrough) this.ackedThrough = index;
  }

  inFlight(): number {
    return this.sent - (this.ackedThrough + 1);
  }
}

/** Receiver credits: binary-ack bodies ride `request` envelopes. */
export function binaryAckPayload(transferId: string, index: number): EncryptedPayload {
  return { tag: "request", body: { type: "binary-ack", transferId, index } };
}

export function readBinaryAck(payload: EncryptedPayload): { transferId: string; index: number } | null {
  if (payload.tag !== "request" || typeof payload.body !== "object" || payload.body === null)
    return null;
  const body = payload.body as Record<string, unknown>;
  if (body["type"] !== "binary-ack") return null;
  if (typeof body["transferId"] !== "string" || typeof body["index"] !== "number") return null;
  return { transferId: body["transferId"], index: body["index"] };
}
