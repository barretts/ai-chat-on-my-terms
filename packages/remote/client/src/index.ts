/**
 * T096: mobile-side pairing session client (PL-07). Owns the pairing state
 * machine that turns a scanned/pasted Pairing QrV1 into a live relay session
 * with negotiated route capabilities, plus disconnect/revoke/rotation.
 *
 * Handshake wire contract (sealed EncryptedPayload envelopes only — the
 * relay is opaque and never sees plaintext, keys or the pairing secret):
 * 1. Mobile connects `GET /mobile?routeId=<companionRouteId>&ticket=<mobileRouteTicket>`
 *    and seals its first payload: { tag:"request", body:{ type:"pairing-hello",
 *    proof, protocol, client } } where proof = helloProof(secret, mobileSalt,
 *    companionSalt, routeId) with per-pairing salts from deriveSessionSalts
 *    (both peers derive the identical salts from QR data alone).
 * 2. Companion verifies the proof (possession of the 256-bit secret),
 *    negotiates protocol via assertProtocolCompatible, and seals back
 *    { tag:"request", body:{ type:"pairing-ready", proof, protocol, routes } }
 *    echoing the same proof string — the echo proves companion possession.
 *    `routes` are the configured backend routes this device may use.
 * 3. Either side may seal { tag:"close", reason }.
 *
 * Version mismatch or an invalidated pairing always resolves to a UI-visible
 * help state pointing at a fresh QR ("re-pair"); stale/old QR text can never
 * pair because the strict QrV1 schema and relay ticket binding reject it.
 */

import {
  PAIRING_PROTOCOL,
  assertProtocolCompatible,
  type PairingQrV1,
} from "@locallab/service-contracts/pairing";
import {
  PairingCryptoError,
  assertPairingUsable,
  createPairingRecord,
  createSessionPairing,
  createUuidV7,
  deriveSessionSalts,
  helloProof,
  parsePairingQrPayload,
  regeneratePairing,
  verifyHelloProof,
  type EncryptedPayload,
  type PairingRecord,
} from "@locallab/remote-crypto";
import { z } from "zod";

export type { PairingRecord };

const RouteCapabilitySchema = z
  .object({
    routeId: z.string().min(1).max(128),
    backend: z.string().min(1).max(64),
    label: z.string().min(1).max(128),
  })
  .strict();

const HelloBodySchema = z
  .object({
    type: z.literal("pairing-hello"),
    proof: z.string().min(16).max(256),
    protocol: z.object({ major: z.number().int(), minor: z.number().int().nonnegative() }).strict(),
    client: z.string().min(1).max(128),
  })
  .strict();

const ReadyBodySchema = z
  .object({
    type: z.literal("pairing-ready"),
    proof: z.string().min(16).max(256),
    protocol: z
      .object({ major: z.number().int(), minor: z.number().int().nonnegative() })
      .strict(),
    routes: z.array(RouteCapabilitySchema).max(64),
  })
  .strict();

export type RouteCapability = z.infer<typeof RouteCapabilitySchema>;
export type PairingClientState =
  | "idle"
  | "connecting"
  | "awaiting-peer"
  | "ready"
  | "closed"
  | "re-pair-required"
  | "version-mismatch";

export interface WebSocketEventLike {
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
}

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: WebSocketEventLike) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface PairingClientHandle {
  state(): PairingClientState;
  note(): string;
  routes(): readonly RouteCapability[];
  qr(): PairingQrV1;
  connect(): Promise<readonly RouteCapability[]>;
  disconnect(reason?: string): void;
}

function decodeBase64Url(value: string) {
  const clean = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function relaySocketUrl(relayUrl: string): string {
  const trimmed = relayUrl.endsWith("/") ? relayUrl.slice(0, -1) : relayUrl;
  if (trimmed.startsWith("wss://") || trimmed.startsWith("ws://")) return trimmed;
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  throw new PairingCryptoError("malformed", "relayUrl must be an http(s) or ws(s) origin");
}

export interface PairingClientOptions {
  /** Raw scanned or manually entered QR payload text. */
  qrText: string;
  webSocket: WebSocketFactory;
  clientLabel?: string;
}

export function createPairingClient(options: PairingClientOptions): PairingClientHandle {
  const qr = parsePairingQrPayload(options.qrText);
  const pairingSecret = decodeBase64Url(qr.pairingSecret);
  const { mobileSalt, companionSalt } = deriveSessionSalts(pairingSecret, qr.companionRouteId);
  const session = createSessionPairing(pairingSecret, mobileSalt, companionSalt, qr.companionRouteId);
  const proof = helloProof(pairingSecret, mobileSalt, companionSalt, qr.companionRouteId);

  let state: PairingClientState = "idle";
  let note = "";
  let routes: readonly RouteCapability[] = [];
  let socket: WebSocketLike | undefined;

  const setNote = (value: string) => {
    note = value;
  };

  function connect() {
    if (state !== "idle" && state !== "closed")
      throw new PairingCryptoError("malformed", `pairing client is already ${state}`);
    const settled = Promise.withResolvers<readonly RouteCapability[]>();
    state = "connecting";
    setNote("");
    const url =
      `${relaySocketUrl(qr.relayUrl)}/mobile` +
      `?routeId=${encodeURIComponent(qr.companionRouteId)}` +
      `&ticket=${encodeURIComponent(qr.mobileRouteTicket)}`;
    const next = options.webSocket(url);
    socket = next;
    next.addEventListener("open", () => {
      state = "awaiting-peer";
      next.send(
        JSON.stringify(
          session.mobile.toCompanion.seal(
            {
              tag: "request",
              body: {
                type: "pairing-hello",
                proof,
                protocol: { major: PAIRING_PROTOCOL.major, minor: PAIRING_PROTOCOL.minor },
                client: options.clientLabel ?? "locallab-mobile",
              },
            },
            createUuidV7(),
          ),
        ),
      );
    });
    next.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let payload: EncryptedPayload;
      try {
        payload = session.mobile.fromCompanion.open(JSON.parse(event.data));
      } catch (error) {
        const failure = error instanceof PairingCryptoError ? error : undefined;
        if (failure !== undefined && failure.message.includes("protocol")) {
          state = "version-mismatch";
          setNote("The desktop is speaking a different pairing protocol. Show a fresh QR code from an updated LocalLab desktop.");
        } else {
          state = "re-pair-required";
          setNote("The desktop sent something this pairing cannot read. Show a fresh QR code.");
        }
        settled.reject(failure ?? error);
        return;
      }
      if (payload.tag === "close") {
        const reason = payload.reason ?? "";
        if (reason.toLowerCase().includes("protocol")) {
          state = "version-mismatch";
          setNote(`Protocol mismatch (${reason}). Update the desktop app and scan a fresh QR code.`);
        } else {
          state = "re-pair-required";
          setNote("This pairing was closed by the desktop. Scan a fresh QR code to re-pair.");
        }
        settled.reject(new PairingCryptoError("unauthorized", note));
        return;
      }
      if (payload.tag !== "request") return;
      const ready = ReadyBodySchema.safeParse(payload.body);
      if (!ready.success) {
        state = "re-pair-required";
        setNote("The desktop hello response was not understood. Show a fresh QR code.");
        settled.reject(new PairingCryptoError("malformed", note));
        return;
      }
      try {
        assertProtocolCompatible(
          { major: PAIRING_PROTOCOL.major, minor: PAIRING_PROTOCOL.minor },
          { major: ready.data.protocol.major, minor: ready.data.protocol.minor },
        );
      } catch {
        state = "version-mismatch";
        setNote("The desktop uses a pairing protocol this app does not support. Update LocalLab and scan a fresh QR code.");
        settled.reject(new PairingCryptoError("unauthorized", note));
        return;
      }
      if (
        !verifyHelloProof(ready.data.proof, pairingSecret, mobileSalt, companionSalt, qr.companionRouteId)
      ) {
        state = "re-pair-required";
        setNote("The desktop could not prove possession of this pairing. Scan a fresh QR code.");
        settled.reject(new PairingCryptoError("unauthorized", note));
        return;
      }
      routes = ready.data.routes;
      state = "ready";
      settled.resolve(routes);
    });
    next.addEventListener("close", (event) => {
      if (state === "ready" || state === "closed" || state === "re-pair-required" || state === "version-mismatch") {
        if (state === "ready") state = "closed";
        return;
      }
      const reason = event.reason ?? "";
      if (event.code === 1008) {
        state = "re-pair-required";
        setNote("This pairing is no longer valid on this relay. Scan a fresh QR code from the desktop.");
      } else {
        state = "closed";
        setNote(reason === "" ? "The relay closed the connection." : `Relay closed: ${reason}.`);
      }
      settled.reject(new PairingCryptoError("unauthorized", note));
    });
    next.addEventListener("error", () => {
      if (state === "connecting" || state === "awaiting-peer") {
        state = "closed";
        setNote("The relay is unreachable. Check its URL and network.");
        settled.reject(new PairingCryptoError("unauthorized", note));
      }
    });
    return settled.promise;
  }

  function disconnect(reason = "client-disconnect") {
    if (socket !== undefined && (state === "ready" || state === "awaiting-peer")) {
      try {
        socket.send(
          JSON.stringify(session.mobile.toCompanion.seal({ tag: "close", reason }, createUuidV7())),
        );
      } catch {
        // best-effort: close below regardless
      }
      socket.close(1000, reason);
    }
    if (state === "ready" || state === "awaiting-peer" || state === "connecting") state = "closed";
  }

  return {
    state: () => state,
    note: () => note,
    routes: () => routes,
    qr: () => qr,
    connect,
    disconnect,
  };
}

/**
 * Pairing record vault: the UI persists PairingRecord JSON; the client
 * enforces lifecycle (step 3): disconnect is live-session, revoke marks the
 * record so it can never connect again, rotation mints a fresh secret AND a
 * fresh route (old pairs are invalid from that instant).
 */
export interface PairingVault {
  load(): Promise<PairingRecord[]>;
  save(records: readonly PairingRecord[]): Promise<void>;
}

export async function storePairedDevice(vault: PairingVault, record: PairingRecord): Promise<void> {
  const records = await vault.load();
  const kept = records.filter((entry) => entry.qr.companionRouteId !== record.qr.companionRouteId);
  kept.push(record);
  await vault.save(kept);
}

export function createStoredPairing(input: {
  relayUrl: string;
  serverIdentityFingerprint: string;
  label: string;
  now: string;
}): PairingRecord {
  return createPairingRecord(input);
}

export async function revokePairedDevice(vault: PairingVault, routeId: string, now: string): Promise<PairingRecord> {
  const records = await vault.load();
  const target = records.find((entry) => entry.qr.companionRouteId === routeId);
  if (target === undefined) throw new PairingCryptoError("unauthorized", `unknown pairing route ${routeId}`);
  target.revokedAt = now;
  await vault.save(records);
  return target;
}

export async function rotatePairedDevice(vault: PairingVault, routeId: string, now: string): Promise<{ old: PairingRecord; next: PairingRecord }> {
  const records = await vault.load();
  const index = records.findIndex((entry) => entry.qr.companionRouteId === routeId);
  if (index < 0) throw new PairingCryptoError("unauthorized", `unknown pairing route ${routeId}`);
  const rotation = regeneratePairing(records[index]!, now);
  records.splice(index, 1, rotation.old, rotation.next);
  await vault.save(records);
  return rotation;
}

export function usablePairing(records: readonly PairingRecord[], routeId: string): PairingRecord {
  const target = records.find((entry) => entry.qr.companionRouteId === routeId);
  if (target === undefined) throw new PairingCryptoError("unauthorized", `unknown pairing route ${routeId}`);
  assertPairingUsable(target);
  return target;
}
