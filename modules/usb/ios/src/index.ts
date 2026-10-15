/**
 * T101 (RE-11): iPhone-side port of the LocalLab USB route (modules/usb/ios).
 *
 * The cable carries THREE layers, all byte-compatible with the companion
 * Rust implementation in `apps/companion/usb` (golden vectors:
 * `fixtures/usb-frame-vectors.json` + the pairing vectors in
 * `packages/remote/crypto/fixtures/pairing-vectors.json`):
 * 1. frames  — u32-BE length-prefixed payloads over the verified USB
 *    mux stream (usbmuxd-style service connection; the mux itself is a
 *    native concern, this codec is the shared language above it).
 * 2. handshake — hello/ready exchanging the pairing hello proof
 *    (identical derivation to relay pairing, so a QR-paired iPhone and
 *    this Mac authenticate over USB with ZERO new secret material and
 *    the secret never touches the wire).
 * 3. sealed frames — remote-crypto sealPayload()/OpeningChannel output
 *    serialized as-is; the frame JSON field names match the relay
 *    golden vectors, so replay windows and AAD binding are identical.
 *
 * Mutual exclusion: ModeGuard mirrors the companion's guard on the
 * phone side — while a USB session is live the app refuses relay
 * reconnects for the same pairing (and vice versa), so sync cursors and
 * sequence windows can never fork.
 */

import { helloProof, verifyHelloProof } from "@locallab/remote-crypto";
import { z } from "zod";

export const USB_PROTOCOL = "locallab-usb-v1";
export const MAX_USB_PAYLOAD_BYTES = 1_048_576;

export class UsbFrameError extends Error {
  constructor(
    readonly kind: "framing" | "oversize",
    message: string,
  ) {
    super(message);
    this.name = "UsbFrameError";
  }
}

/** One payload into a length-prefixed USB frame (mirror of Rust encode_frame). */
export function encodeFrame(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_USB_PAYLOAD_BYTES) {
    throw new UsbFrameError("oversize", `payload of ${payload.length} exceeds the ${MAX_USB_PAYLOAD_BYTES} cap`);
  }
  const out = new Uint8Array(payload.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

/** Reassembles frames from arbitrarily chunked channel reads (mirror of Rust FrameDecoder). */
export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  push(bytes: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buffer.length + bytes.length);
    merged.set(this.buffer, 0);
    merged.set(bytes, this.buffer.length);
    this.buffer = merged;
    const frames: Uint8Array[] = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const len = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4).getUint32(0, false);
      if (len > MAX_USB_PAYLOAD_BYTES) {
        this.buffer = new Uint8Array(0);
        throw new UsbFrameError("oversize", `frame declares ${len} bytes, over the ${MAX_USB_PAYLOAD_BYTES} cap`);
      }
      if (this.buffer.length < 4 + len) break;
      frames.push(this.buffer.slice(4, 4 + len));
      this.buffer = this.buffer.slice(4 + len);
    }
    return frames;
  }

  buffered(): number {
    return this.buffer.length;
  }
}

export interface UsbPairingRecord {
  routeId: string;
  pairingSecret: Uint8Array;
  mobileSalt: Uint8Array;
  companionSalt: Uint8Array;
}

const RouteCapabilitySchema = z
  .object({
    id: z.string().min(1).max(128),
    backend: z.string().min(1).max(64),
    label: z.string().min(1).max(128),
  })
  .strict();

export type UsbRouteCapability = z.infer<typeof RouteCapabilitySchema>;

const HelloSchema = z
  .object({
    tag: z.literal("usb-hello"),
    side: z.literal("mobile"),
    protocol: z.string(),
    routeId: z.string().min(1).max(128),
    proof: z.string().min(16).max(256),
    sessionSalt: z.string().min(22).max(22),
  })
  .strict();

const ReadySchema = z
  .object({
    tag: z.literal("usb-ready"),
    protocol: z.string(),
    proof: z.string().min(16).max(256),
    routes: z.array(RouteCapabilitySchema).max(64),
    sessionSalt: z.string().min(22).max(22),
  })
  .strict();

/**
 * iPhone side: build the hello proving possession of the pairing secret.
 * R007: `mobileEphemeral` (fresh random 16 bytes this cable session) rides
 * the hello as base64url `sessionSalt`; the companion mixes it (plus its own
 * ephemeral, echoed in the ready) into the DATA-direction keys so two
 * sessions over one saved pairing never reuse a (key, nonce) pair.
 */
export function buildUsbHello(record: UsbPairingRecord, mobileEphemeral: Uint8Array) {
  return {
    tag: "usb-hello" as const,
    side: "mobile" as const,
    protocol: USB_PROTOCOL,
    routeId: record.routeId,
    proof: helloProof(record.pairingSecret, record.mobileSalt, record.companionSalt, record.routeId),
    sessionSalt: Buffer.from(mobileEphemeral).toString("base64url"),
  };
}

/** Companion-side mirror (integration tests + native bridges): verify the hello. */
export type UsbHelloVerdict =
  | { status: "authenticated"; routeId: string; mobileEphemeral: Uint8Array }
  | { status: "version-mismatch" }
  | { status: "unauthorized" }
  | { status: "malformed" };

const SessionSaltB64 = /^[A-Za-z0-9_-]{22}$/;

export function verifyUsbHello(hello: unknown, records: readonly UsbPairingRecord[]): UsbHelloVerdict {
  const parsed = HelloSchema.safeParse(hello);
  if (!parsed.success) return { status: "malformed" };
  if (parsed.data.protocol !== USB_PROTOCOL) return { status: "version-mismatch" };
  if (!SessionSaltB64.test(parsed.data.sessionSalt)) return { status: "malformed" };
  const record = records.find((candidate) => candidate.routeId === parsed.data.routeId);
  if (record === undefined) return { status: "unauthorized" };
  if (!verifyHelloProof(parsed.data.proof, record.pairingSecret, record.mobileSalt, record.companionSalt, record.routeId)) {
    return { status: "unauthorized" };
  }
  return {
    status: "authenticated",
    routeId: parsed.data.routeId,
    mobileEphemeral: new Uint8Array(Buffer.from(parsed.data.sessionSalt, "base64url")),
  };
}

/**
 * Companion echoes the same proof back (possession proof before traffic)
 * and contributes its own fresh 16-byte ephemeral for the data keys.
 */
export function buildUsbReady(
  record: UsbPairingRecord,
  routes: readonly UsbRouteCapability[],
  companionEphemeral: Uint8Array,
) {
  return {
    tag: "usb-ready" as const,
    protocol: USB_PROTOCOL,
    proof: helloProof(record.pairingSecret, record.mobileSalt, record.companionSalt, record.routeId),
    sessionSalt: Buffer.from(companionEphemeral).toString("base64url"),
    routes: [...routes],
  };
}

/** iPhone side: only trust the cable once the companion echoed the proof. */
export function verifyUsbReady(
  ready: unknown,
  record: UsbPairingRecord,
): { routes: UsbRouteCapability[]; companionEphemeral: Uint8Array } | null {
  const parsed = ReadySchema.safeParse(ready);
  if (!parsed.success) return null;
  if (parsed.data.protocol !== USB_PROTOCOL) return null;
  if (!SessionSaltB64.test(parsed.data.sessionSalt)) return null;
  if (!verifyHelloProof(parsed.data.proof, record.pairingSecret, record.mobileSalt, record.companionSalt, record.routeId)) {
    return null;
  }
  return {
    routes: parsed.data.routes,
    companionEphemeral: new Uint8Array(Buffer.from(parsed.data.sessionSalt, "base64url")),
  };
}

export type DeviceMode = "remote" | "usb";

export type ModeClaim = { ok: true } | { ok: false; kind: "excluded"; message: string };

/** Phone-side mirror of the companion ModeGuard: one live session per pairing. */
export class ModeGuard {
  private active: Record<string, DeviceMode> = {};

  claim(deviceId: string, mode: DeviceMode): ModeClaim {
    const current = this.active[deviceId];
    if (current === undefined) {
      this.active[deviceId] = mode;
      return { ok: true };
    }
    if (current === mode) return { ok: true };
    return {
      ok: false,
      kind: "excluded",
      message: `this Mac already has a live ${current} session; ${mode} is refused until it closes`,
    };
  }

  release(deviceId: string, mode: DeviceMode): boolean {
    if (this.active[deviceId] !== mode) return false;
    delete this.active[deviceId];
    return true;
  }

  modeOf(deviceId: string): DeviceMode | null {
    return this.active[deviceId] ?? null;
  }
}

export type UsbDeviceState = "unattached" | "untrusted" | "trusted" | "active";

/** iPhone-side view of the cable, mirroring the companion tracker states. */
export class UsbDeviceTracker {
  private state: UsbDeviceState = "unattached";

  current(): UsbDeviceState {
    return this.state;
  }

  attach(trusted: boolean): void {
    this.state = trusted ? "trusted" : "untrusted";
  }

  trustGranted(): void {
    if (this.state === "untrusted") this.state = "trusted";
  }

  markActive(): boolean {
    if (this.state !== "trusted") return false;
    this.state = "active";
    return true;
  }

  detach(): void {
    this.state = "unattached";
  }

  note(): string {
    switch (this.state) {
      case "unattached":
        return "No Mac connected over USB. Connect the cable to sync without any network.";
      case "untrusted":
        return "Cable connected — tap Trust on this iPhone to allow this Mac.";
      case "trusted":
        return "iPhone trusted this Mac — the LocalLab USB session can start.";
      case "active":
        return "USB session live — chat and sync run over the cable; Wi-Fi remote mode is off.";
    }
  }
}
