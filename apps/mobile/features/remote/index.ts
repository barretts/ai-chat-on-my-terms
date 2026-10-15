/**
 * T096 (PL-07) remote pairing — headless view layer.
 *
 * Everything here is pure and RN-safe (no node:crypto, no Buffer): the
 * sealed-frame pairing engine (@locallab/remote-client) needs a native
 * crypto binding on device and is injected as `PairingEngine`. The QR the
 * app accepts is the project-owned pairing v1 payload — official LM Mini
 * pairing codes are foreign payloads and are rejected outright; no
 * interop with LM Mini is claimed anywhere in this flow.
 */
import { PairingQrV1Schema, type PairingQrV1 } from "@locallab/service-contracts/pairing";

export type { PairingQrV1 };
export interface StoredPairing {
  qr: PairingQrV1;
  createdAt: string;
  revokedAt: string | null;
  label: string;
}

export interface PairedVaultPort {
  load(): Promise<readonly StoredPairing[]>;
  save(records: readonly StoredPairing[]): Promise<void>;
}

/** Route capabilities negotiated during pairing (what the desktop allows). */
export interface RouteCapabilityView {
  routeId: string;
  backend: string;
  label: string;
}

/**
 * Sealed-frame pairing engine injected by composition. The connect promise
 * resolves with negotiated capabilities once the desktop answers the
 * pairing hello; failures land in `state()`/`note()` for the UI to render.
 */
export interface PairingEngine {
  state(): string;
  note(): string;
  routes(): readonly RouteCapabilityView[];
  connect(): Promise<readonly RouteCapabilityView[]>;
  disconnect(reason?: string): void;
}

export type ScanNote =
  | { kind: "valid"; summary: { host: string; fingerprintTail: string; routeId: string } }
  | { kind: "invalid"; message: string };

function hostOf(url: string): string {
  const match = /^[a-z+]+:\/\/([^/?#]+)/i.exec(url);
  return match?.[1] ?? url;
}

/**
 * Validate scanned or manually entered pairing text against the project-
 * owned QR v1 schema. Foreign/old payloads (including official LM Mini
 * pairing codes) are invalid by construction: the strict schema pins the
 * v1 shape, so there is no compatibility branch to drift.
 */
export function parsePairingScanNote(text: string): ScanNote {
  const trimmed = text.trim();
  if (trimmed === "")
    return { kind: "invalid", message: "Scan the QR from LocalLab desktop, or paste its pairing text." };
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    return {
      kind: "invalid",
      message: "That is not a LocalLab pairing code. Codes start on LocalLab desktop under Connect.",
    };
  }
  const payload = PairingQrV1Schema.safeParse(decoded);
  if (!payload.success) {
    return {
      kind: "invalid",
      message:
        "That pairing code is not supported. Only LocalLab pairing v1 codes work here; official LM Mini codes cannot pair with this app.",
    };
  }
  return {
    kind: "valid",
    summary: {
      host: hostOf(payload.data.relayUrl),
      fingerprintTail: payload.data.serverIdentityFingerprint.slice(-8),
      routeId: payload.data.companionRouteId,
    },
  };
}

/** Gate for pairing: sharing is opt-in and must be consented explicitly. */
export function pairingBlockedReason(consent: boolean, scan: ScanNote): string {
  if (scan.kind === "invalid") return scan.message;
  if (!consent) return "Turn on sharing to pair. Pairing shares this device's chat traffic with your own desktop only.";
  return "";
}

export interface PairedDeviceRow {
  routeId: string;
  label: string;
  host: string;
  fingerprintTail: string;
  createdAt: string;
  status: "active" | "revoked";
}

/** Stored pairings -> device list rows (newest first). */
export function pairedDeviceViews(records: readonly StoredPairing[]): PairedDeviceRow[] {
  return [...records]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((record) => ({
      routeId: record.qr.companionRouteId,
      label: record.label,
      host: hostOf(record.qr.relayUrl),
      fingerprintTail: record.qr.serverIdentityFingerprint.slice(-8),
      createdAt: record.createdAt,
      status: record.revokedAt === null ? "active" : "revoked",
    }));
}

export function storeStoredPairing(
  records: readonly StoredPairing[],
  record: StoredPairing,
): StoredPairing[] {
  const kept = records.filter((entry) => entry.qr.companionRouteId !== record.qr.companionRouteId);
  return [...kept, record];
}

export function revokeStoredPairing(
  records: readonly StoredPairing[],
  routeId: string,
  now: string,
): StoredPairing[] {
  return records.map((record) =>
    record.qr.companionRouteId === routeId && record.revokedAt === null
      ? { ...record, revokedAt: now }
      : record,
  );
}

/**
 * User-facing connection state text. Terminal help always points at a
 * fresh QR from LocalLab desktop — the only pairing source this app has.
 */
export function connectionNote(state: string, note: string): string {
  switch (state) {
    case "idle":
      return "Not connected. Scan a QR from LocalLab desktop under Connect.";
    case "connecting":
      return "Reaching the relay…";
    case "awaiting-peer":
      return "Waiting for the desktop to answer. Leave LocalLab desktop open.";
    case "ready":
      return "Paired and connected.";
    case "closed":
      return note === "" ? "Disconnected." : note;
    case "re-pair-required":
      return "This pairing is no longer valid. Show a fresh QR from LocalLab desktop and scan it again. (Rotated or revoked pairings cannot reconnect; official LM Mini codes were never valid here.)";
    case "version-mismatch":
      return "The desktop speaks a newer pairing protocol. Update LocalLab desktop, then scan its fresh QR.";
    default:
      return note;
  }
}

/** Build a stored record from a scanned QR; pure (no entropy needed). */
export function recordFromScan(qr: PairingQrV1, label: string, now: string): StoredPairing {
  return { qr, createdAt: now, revokedAt: null, label };
}
