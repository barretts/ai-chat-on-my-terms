/** Account-assisted PIN recovery grants (DA-08). A recovery grant is a
 * signed, expiring, device-bound, single-use claim; nothing about the PIN
 * or chats ever leaves the device. The device keeps a random recovery
 * secret; the service only ever sees its SHA-256 hash. */

import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";

export const GRANT_VERSION = 1;
export const DEFAULT_GRANT_TTL_MS = 30 * 60 * 1000;

export interface GrantPayload {
  v: 1;
  enrollmentId: string;
  deviceIdHash: string;
  /** Issued-at / expiry as epoch milliseconds. */
  iat: number;
  exp: number;
  nonce: string;
}

export type GrantVerifyResult =
  | { ok: true; payload: GrantPayload }
  | { ok: false; code: "malformed" | "bad-signature" | "expired" };

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0)
    throw new Error("bad hex string");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function b64Char(value: number): string {
  return B64[value & 63] ?? "";
}

function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    out += b64Char(b0 >> 2) + b64Char(((b0 & 3) << 4) | (b1 >> 4));
    if (i + 1 < bytes.length) out += b64Char(((b1 & 15) << 2) | (b2 >> 6));
    if (i + 2 < bytes.length) out += b64Char(b2 & 63);
  }
  return out;
}

function base64UrlDecode(text: string): Uint8Array {
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const char of text) {
    const index = B64.indexOf(char);
    if (index < 0) throw new Error("bad base64url character");
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 255);
    }
  }
  return Uint8Array.from(bytes);
}

export function sha256Hex(text: string): string {
  return toHex(sha256(new TextEncoder().encode(text)));
}

/** Payload JSON is built from a fixed-order literal so the signed bytes
 * are canonical. */
export function canonicalGrantJson(payload: GrantPayload): string {
  return `{"v":${payload.v},"enrollmentId":${JSON.stringify(payload.enrollmentId)},"deviceIdHash":${JSON.stringify(payload.deviceIdHash)},"iat":${payload.iat},"exp":${payload.exp},"nonce":${JSON.stringify(payload.nonce)}}`;
}

export function issueGrant(
  payload: GrantPayload,
  signingKeyHex: string,
): string {
  const body = base64UrlEncode(
    new TextEncoder().encode(canonicalGrantJson(payload)),
  );
  const signature = hmac(
    sha256,
    fromHex(signingKeyHex),
    new TextEncoder().encode(body),
  );
  return `${body}.${base64UrlEncode(signature)}`;
}

export function verifyGrant(
  grant: string,
  signingKeyHex: string,
  nowMs: number,
): GrantVerifyResult {
  const dot = grant.indexOf(".");
  if (dot <= 0 || dot === grant.length - 1)
    return { ok: false, code: "malformed" };
  const body = grant.slice(0, dot);
  const signature = grant.slice(dot + 1);
  let payload: GrantPayload;
  try {
    const json = new TextDecoder().decode(base64UrlDecode(body));
    const parsed = JSON.parse(json) as GrantPayload;
    if (
      parsed.v !== GRANT_VERSION ||
      typeof parsed.enrollmentId !== "string" ||
      typeof parsed.deviceIdHash !== "string" ||
      typeof parsed.iat !== "number" ||
      typeof parsed.exp !== "number" ||
      typeof parsed.nonce !== "string" ||
      canonicalGrantJson(parsed) !== json
    )
      return { ok: false, code: "malformed" };
    payload = parsed;
  } catch {
    return { ok: false, code: "malformed" };
  }
  const expected = hmac(sha256, fromHex(signingKeyHex), new TextEncoder().encode(body));
  const provided = base64UrlDecode(signature);
  if (
    provided.length !== expected.length ||
    !constantTimeEquals(provided, expected)
  )
    return { ok: false, code: "bad-signature" };
  if (nowMs >= payload.exp) return { ok: false, code: "expired" };
  return { ok: true, payload };
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Device-side recovery identity: the secret never leaves the device and
 * the hash cannot reveal it; enrolling leaks nothing about PINs or chats. */
export interface DeviceRecoveryIdentity {
  deviceSecret: string;
  deviceIdHash: string;
}

export function createDeviceRecoveryIdentity(
  random?: (length: number) => Uint8Array,
): DeviceRecoveryIdentity {
  const bytes =
    random !== undefined
      ? random(32)
      : globalThis.crypto.getRandomValues(new Uint8Array(32));
  const deviceSecret = toHex(bytes);
  return { deviceSecret, deviceIdHash: sha256Hex(deviceSecret) };
}

export interface RecoveryEnrollment {
  id: string;
  userId: string;
  email: string;
  deviceIdHash: string;
  createdAt: string;
}

export interface RecoveryStore {
  insertEnrollment(enrollment: RecoveryEnrollment): Promise<void>;
  enrollmentsByEmail(email: string): Promise<RecoveryEnrollment[]>;
  findEnrollment(id: string): Promise<RecoveryEnrollment | null>;
  /** Marks a grant nonce consumed; returns false when already consumed. */
  consumeNonce(nonce: string): Promise<boolean>;
}

export function memoryRecoveryStore(): RecoveryStore {
  const enrollments: RecoveryEnrollment[] = [];
  const consumed = new Set<string>();
  return {
    async insertEnrollment(enrollment) {
      enrollments.push({ ...enrollment });
    },
    async enrollmentsByEmail(email) {
      return enrollments
        .filter((item) => item.email.toLowerCase() === email.toLowerCase())
        .map((item) => ({ ...item }));
    },
    async findEnrollment(id) {
      const found = enrollments.find((item) => item.id === id);
      return found === undefined ? null : { ...found };
    },
    async consumeNonce(nonce) {
      if (consumed.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    },
  };
}
