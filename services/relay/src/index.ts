import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import wsModule from "ws";
import type { WebSocket } from "ws";
import { EntityIdSchema } from "@locallab/contracts/identity";
import { PAIRING_PROTOCOL } from "@locallab/service-contracts/pairing";
import {
  EncryptedRelayFrameV1Schema,
  MAX_RELAY_FRAME_BYTES,
  validateRelayFrameSize,
} from "@locallab/service-contracts/relay";
import { mobileRouteTicketHash } from "@locallab/remote-crypto";

export const RELAY_VERSION = "0.1.0";
export const CLOSE_POLICY_VIOLATION = 1008;
export const CLOSE_MESSAGE_TOO_BIG = 1009;

export type RelayLimits = {
  maxFrameBytes: number;
  maxConnections: number;
  messagesPerSecond: number;
  bytesPerSecond: number;
  highWaterBytes: number;
  routeTtlMs: number;
  idleTimeoutMs: number;
  sweepIntervalMs: number;
  heartbeatIntervalMs: number;
};

export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  maxFrameBytes: MAX_RELAY_FRAME_BYTES,
  maxConnections: 64,
  messagesPerSecond: 100,
  bytesPerSecond: 4_194_304,
  highWaterBytes: 524_288,
  routeTtlMs: 30 * 24 * 60 * 60 * 1000,
  idleTimeoutMs: 30_000,
  sweepIntervalMs: 10_000,
  heartbeatIntervalMs: 10_000,
};

/**
 * Audit events carry routing metadata only: route IDs, roles, byte counts and
 * rejection reasons. Frame payloads are never logged or retained, so an audit
 * dump cannot contain chat content.
 */
export type RelayAuditEvent = {
  at: number;
  kind:
    | "peer-connected"
    | "peer-disconnected"
    | "frame-forwarded"
    | "dropped-no-target"
    | "rejected"
    | "backpressure"
    | "route-expired";
  routeId?: string;
  role?: "mobile" | "companion";
  bytes?: number;
  reason?: string;
};

export type RelayMetrics = {
  version: string;
  protocol: { major: number; minor: number };
  uptimeMs: number;
  activeConnections: number;
  activeRoutes: number;
  framesForwarded: number;
  bytesForwarded: number;
  droppedNoTarget: number;
  rejectedInvalid: number;
  rejectedRate: number;
  rejectedAuth: number;
  oversizedMessages: number;
  backpressureEpisodes: number;
  connectionRejections: Record<string, number>;
};

type RouteState = {
  routeId: string;
  credentialHash: string;
  mobileTicketHash: string;
  expiresAtMs: number;
  companion: WebSocket | undefined;
  mobile: WebSocket | undefined;
};

type PeerState = {
  role: "mobile" | "companion";
  routeId: string;
  windowStartedMs: number;
  windowMessages: number;
  windowBytes: number;
  alive: boolean;
  lastSeenMs: number;
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Opaque relay: forwards validated EncryptedRelayFrameV1 messages between the
 * paired companion and mobile connections for a route. It authenticates peers
 * (companion credential hash, mobile route-ticket HMAC), enforces size, rate,
 * connection and expiry limits, applies backpressure, and persists nothing:
 * all state is in-memory and frame content is never parsed beyond its routing
 * envelope. Replay/sequence protection is a peer-layer concern (see
 * @locallab/remote-crypto OpeningChannel); the relay stays stateless per frame.
 */
export function createRelayServer(
  options: { limits?: Partial<RelayLimits>; onAudit?: (event: RelayAuditEvent) => void } = {},
): { server: Server; close: () => Promise<void>; metrics: () => RelayMetrics; auditEvents: () => RelayAuditEvent[] } {
  const limits: RelayLimits = { ...DEFAULT_RELAY_LIMITS, ...options.limits };
  const startedMs = Date.now();
  const routes = new Map<string, RouteState>();
  const peers = new Map<WebSocket, PeerState>();
  const auditRing: RelayAuditEvent[] = [];
  const rejectionCounts: Record<string, number> = {};
  let framesForwarded = 0;
  let bytesForwarded = 0;
  let droppedNoTarget = 0;
  let rejectedInvalid = 0;
  let rejectedRate = 0;
  let rejectedAuth = 0;
  let oversizedMessages = 0;
  let backpressureEpisodes = 0;

  function audit(kind: RelayAuditEvent["kind"], fields: Omit<RelayAuditEvent, "at" | "kind">): void {
    auditRing.push({ at: Date.now(), kind, ...fields });
    if (auditRing.length > 512) auditRing.shift();
    if (options.onAudit !== undefined) options.onAudit({ at: Date.now(), kind, ...fields });
  }

  function reject(reason: string, fields: Omit<RelayAuditEvent, "at" | "kind">): void {
    rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
    audit("rejected", { ...fields, reason });
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    if (request.method === "GET" && path === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          version: RELAY_VERSION,
          uptimeMs: Date.now() - startedMs,
          routes: routes.size,
          connections: peers.size,
        }),
      );
      return;
    }
    if (request.method === "GET" && path === "/metrics") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(publicMetrics()));
      return;
    }
    if (request.method === "GET" && path === "/release/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          version: RELAY_VERSION,
          protocolMajor: PAIRING_PROTOCOL.major,
          protocolMinor: PAIRING_PROTOCOL.minor,
        }),
      );
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  const wss = new wsModule.Server({ server, maxPayload: limits.maxFrameBytes });

  function publicMetrics(): RelayMetrics {
    return {
      version: RELAY_VERSION,
      protocol: { major: PAIRING_PROTOCOL.major, minor: PAIRING_PROTOCOL.minor },
      uptimeMs: Date.now() - startedMs,
      activeConnections: peers.size,
      activeRoutes: routes.size,
      framesForwarded,
      bytesForwarded,
      droppedNoTarget,
      rejectedInvalid,
      rejectedRate,
      rejectedAuth,
      oversizedMessages,
      backpressureEpisodes,
      connectionRejections: { ...rejectionCounts },
    };
  }

  function detachPeer(socket: WebSocket, peer: PeerState): void {
    const route = routes.get(peer.routeId);
    if (route === undefined) return;
    if (route.companion === socket) route.companion = undefined;
    if (route.mobile === socket) route.mobile = undefined;
  }

  function sendFrame(target: WebSocket, source: WebSocket, text: string, bytes: number, routeId: string): void {
    if (target.bufferedAmount >= limits.highWaterBytes) {
      backpressureEpisodes += 1;
      audit("backpressure", { routeId, bytes });
      source._socket.pause();
      target._socket.once("drain", () => {
        source._socket.resume();
      });
    }
    target.send(text);
    framesForwarded += 1;
    bytesForwarded += bytes;
    audit("frame-forwarded", { routeId, bytes });
  }

  function handlePeerMessage(socket: WebSocket, peer: PeerState, data: unknown): void {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    const bytes = Buffer.byteLength(text, "utf8");
    const now = Date.now();
    if (now - peer.windowStartedMs >= 1000) {
      peer.windowStartedMs = now;
      peer.windowMessages = 0;
      peer.windowBytes = 0;
    }
    peer.windowMessages += 1;
    peer.windowBytes += bytes;
    if (peer.windowMessages > limits.messagesPerSecond || peer.windowBytes > limits.bytesPerSecond) {
      rejectedRate += 1;
      reject("rate limit", { routeId: peer.routeId, role: peer.role });
      socket.close(CLOSE_POLICY_VIOLATION, "rate limit");
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      frame = null;
    }
    const parsed = EncryptedRelayFrameV1Schema.safeParse(frame);
    if (!parsed.success) {
      rejectedInvalid += 1;
      reject("malformed frame", { routeId: peer.routeId, role: peer.role });
      socket.close(CLOSE_POLICY_VIOLATION, "malformed frame");
      return;
    }
    const envelope = parsed.data;
    if (envelope.routeId !== peer.routeId) {
      rejectedInvalid += 1;
      reject("route mismatch", { routeId: peer.routeId, role: peer.role });
      socket.close(CLOSE_POLICY_VIOLATION, "route mismatch");
      return;
    }
    if (
      envelope.protocol.major > PAIRING_PROTOCOL.major ||
      envelope.protocol.minor > PAIRING_PROTOCOL.minor
    ) {
      rejectedInvalid += 1;
      reject("protocol mismatch", { routeId: peer.routeId, role: peer.role });
      socket.close(CLOSE_POLICY_VIOLATION, "protocol mismatch");
      return;
    }
    try {
      validateRelayFrameSize(envelope);
    } catch {
      rejectedInvalid += 1;
      reject("size mismatch", { routeId: peer.routeId, role: peer.role });
      socket.close(CLOSE_POLICY_VIOLATION, "size mismatch");
      return;
    }
    const route = routes.get(peer.routeId);
    const target = route === undefined ? undefined : peer.role === "mobile" ? route.companion : route.mobile;
    if (target === undefined || target.readyState !== 1) {
      droppedNoTarget += 1;
      audit("dropped-no-target", { routeId: peer.routeId, role: peer.role, bytes });
      return;
    }
    sendFrame(target, socket, text, bytes, peer.routeId);
  }

  function acceptConnection(socket: WebSocket, request: IncomingMessage): void {
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    const role = url.pathname === "/companion" ? "companion" : url.pathname === "/mobile" ? "mobile" : undefined;
    if (role === undefined) {
      reject("unknown path", {});
      socket.close(CLOSE_POLICY_VIOLATION, "unknown path");
      return;
    }
    if (peers.size >= limits.maxConnections) {
      reject("connection limit", { role });
      socket.close(CLOSE_POLICY_VIOLATION, "connection limit");
      return;
    }
    const routeId = url.searchParams.get("routeId") ?? "";
    if (!EntityIdSchema.safeParse(routeId).success) {
      reject("bad route id", { role });
      socket.close(CLOSE_POLICY_VIOLATION, "bad route id");
      return;
    }
    let route = routes.get(routeId);
    if (role === "companion") {
      const credential = url.searchParams.get("credential");
      const mobileTicketHash = url.searchParams.get("mobileTicketHash");
      if (
        typeof credential !== "string" ||
        credential.length < 16 ||
        typeof mobileTicketHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(mobileTicketHash)
      ) {
        rejectedAuth += 1;
        reject("registration required", { routeId, role });
        socket.close(CLOSE_POLICY_VIOLATION, "registration required");
        return;
      }
      const credentialHash = sha256Hex(credential);
      if (route !== undefined && route.credentialHash !== credentialHash) {
        rejectedAuth += 1;
        reject("credential mismatch", { routeId, role });
        socket.close(CLOSE_POLICY_VIOLATION, "credential mismatch");
        return;
      }
      if (route === undefined) {
        route = {
          routeId,
          credentialHash,
          mobileTicketHash,
          expiresAtMs: Date.now() + limits.routeTtlMs,
          companion: undefined,
          mobile: undefined,
        };
        routes.set(routeId, route);
      } else {
        route.credentialHash = credentialHash;
        route.mobileTicketHash = mobileTicketHash;
        route.expiresAtMs = Date.now() + limits.routeTtlMs;
      }
      if (route.companion !== undefined && route.companion !== socket) {
        route.companion.close(CLOSE_POLICY_VIOLATION, "replaced");
      }
      route.companion = socket;
    } else {
      const ticket = url.searchParams.get("ticket");
      if (route === undefined || typeof ticket !== "string") {
        rejectedAuth += 1;
        reject("route unavailable", { routeId, role });
        socket.close(CLOSE_POLICY_VIOLATION, "route unavailable");
        return;
      }
      let presented: Buffer | undefined;
      try {
        presented = Buffer.from(mobileRouteTicketHash(ticket), "hex");
      } catch {
        presented = undefined;
      }
      const expected = Buffer.from(route.mobileTicketHash, "hex");
      if (presented === undefined || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        rejectedAuth += 1;
        reject("ticket rejected", { routeId, role });
        socket.close(CLOSE_POLICY_VIOLATION, "ticket rejected");
        return;
      }
      if (route.mobile !== undefined && route.mobile !== socket) {
        route.mobile.close(CLOSE_POLICY_VIOLATION, "replaced");
      }
      route.mobile = socket;
    }
    const peer: PeerState = {
      role,
      routeId,
      windowStartedMs: Date.now(),
      windowMessages: 0,
      windowBytes: 0,
      alive: true,
      lastSeenMs: Date.now(),
    };
    peers.set(socket, peer);
    audit("peer-connected", { routeId, role });
    socket.on("pong", () => {
      peer.alive = true;
      peer.lastSeenMs = Date.now();
    });
    socket.on("message", (data: unknown) => {
      peer.alive = true;
      peer.lastSeenMs = Date.now();
      handlePeerMessage(socket, peer, data);
    });
    socket.on("error", (error: Error) => {
      if (/Max payload size exceeded/i.test(error.message)) {
        oversizedMessages += 1;
        reject("oversized", { routeId: peer.routeId, role: peer.role });
      }
      peers.delete(socket);
      detachPeer(socket, peer);
    });
    socket.on("close", () => {
      peers.delete(socket);
      detachPeer(socket, peer);
      audit("peer-disconnected", { routeId: peer.routeId, role: peer.role });
    });
  }

  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    try {
      acceptConnection(socket, request);
    } catch {
      rejectedInvalid += 1;
      reject("connection rejected", {});
      socket.close(CLOSE_POLICY_VIOLATION, "connection rejected");
    }
  });

  const heartbeatTimer = setInterval(() => {
    const deadline = Date.now() - limits.idleTimeoutMs;
    for (const [socket, peer] of peers) {
      if (!peer.alive && peer.lastSeenMs < deadline) {
        socket.terminate();
        continue;
      }
      peer.alive = false;
      socket.ping();
    }
  }, limits.heartbeatIntervalMs);

  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [routeId, route] of routes) {
      if (route.expiresAtMs > now) continue;
      route.companion?.close(CLOSE_POLICY_VIOLATION, "route expired");
      route.mobile?.close(CLOSE_POLICY_VIOLATION, "route expired");
      routes.delete(routeId);
      audit("route-expired", { routeId });
    }
  }, limits.sweepIntervalMs);

  function publicClose(): Promise<void> {
    const finished = Promise.withResolvers<void>();
    clearInterval(heartbeatTimer);
    clearInterval(sweepTimer);
    for (const socket of peers.keys()) socket.terminate();
    wss.close();
    server.close(() => finished.resolve());
    server.closeAllConnections();
    return finished.promise;
  }

  server.on("close", () => {
    clearInterval(heartbeatTimer);
    clearInterval(sweepTimer);
  });

  return {
    server,
    close: publicClose,
    metrics: publicMetrics,
    auditEvents: () => auditRing.slice(),
  };
}

