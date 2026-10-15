import { setTimeout as sleep } from "node:timers/promises";
import wsModule from "ws";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OpeningChannel,
  createPairingQrV1,
  deriveNonceKey,
  deriveSessionKey,
  encodePairingQrPayload,
  generateSessionSalt,
  mobileRouteTicketHash,
  parsePairingQrPayload,
  sealPayload,
  type EncryptedPayload,
  type EncryptedRelayFrameV1,
} from "@locallab/remote-crypto";
import {
  CLOSE_MESSAGE_TOO_BIG,
  createRelayServer,
  type RelayAuditEvent,
  type RelayLimits,
  CLOSE_POLICY_VIOLATION,
  RELAY_VERSION,
} from "../src/index.js";

class TestSocket {
  private readonly socket: WebSocket;
  private readonly queue: string[] = [];
  private waiter: { resolve: (value: string) => void } | undefined;
  readonly opened: Promise<void>;
  readonly closed: Promise<{ code: number }>;

  constructor(url: string) {
    const open = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<{ code: number }>();
    this.opened = open.promise;
    this.closed = closed.promise;
    this.socket = new WebSocket(url);
    this.socket.addEventListener("open", () => open.resolve());
    this.socket.addEventListener("error", () => open.reject(new Error("websocket open failed")));
    this.socket.addEventListener("message", (event: MessageEvent) => {
      const text = String(event.data);
      const pending = this.waiter;
      if (pending !== undefined) {
        this.waiter = undefined;
        pending.resolve(text);
      } else {
        this.queue.push(text);
      }
    });
    this.socket.addEventListener("close", (event: CloseEvent) => closed.resolve({ code: event.code }));
  }

  send(text: string): void {
    this.socket.send(text);
  }

  next(): Promise<string> {
    const head = this.queue.shift();
    if (head !== undefined) return Promise.resolve(head);
    const pending = Promise.withResolvers<string>();
    this.waiter = { resolve: pending.resolve };
    return pending.promise;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  close(): void {
    this.socket.close();
  }
}

async function startRelay(limits?: Partial<RelayLimits>): Promise<{
  port: number;
  base: string;
  close: () => Promise<void>;
  metrics: () => ReturnType<ReturnType<typeof createRelayServer>["metrics"]>;
  auditEvents: () => RelayAuditEvent[];
}> {
  const relay = createRelayServer({ limits });
  const listening = Promise.withResolvers<void>();
  relay.server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = relay.server.address();
  if (address === null || typeof address === "string") throw new Error("expected tcp address");
  return {
    port: address.port,
    base: `ws://127.0.0.1:${address.port}`,
    close: relay.close,
    metrics: relay.metrics,
    auditEvents: relay.auditEvents,
  };
}

function makePairing() {
  const qr = parsePairingQrPayload(
    encodePairingQrPayload(
      createPairingQrV1({ relayUrl: "ws://relay.invalid/r", serverIdentityFingerprint: `sha256:${"ab12cd34".repeat(8)}` }),
    ),
  );
  const pairingSecret = new Uint8Array(Buffer.from(qr.pairingSecret, "base64url"));
  const mobileSalt = generateSessionSalt();
  const companionSalt = generateSessionSalt();
  const keys = (from: "mobile" | "companion", to: "mobile" | "companion") => ({
    directionKey: deriveSessionKey(pairingSecret, mobileSalt, companionSalt, qr.companionRouteId, from, to),
    nonceKey: deriveNonceKey(pairingSecret, mobileSalt, companionSalt, qr.companionRouteId, from, to),
  });
  return { qr, mobileSalt, companionSalt, m2c: keys("mobile", "companion"), c2m: keys("companion", "mobile") };
}

function companionUrl(base: string, qr: ReturnType<typeof makePairing>["qr"], credential: string): string {
  return `${base}/companion?routeId=${qr.companionRouteId}&credential=${credential}&mobileTicketHash=${mobileRouteTicketHash(qr.mobileRouteTicket)}`;
}

function mobileUrl(base: string, qr: ReturnType<typeof makePairing>["qr"], ticket: string = qr.mobileRouteTicket): string {
  return `${base}/mobile?routeId=${qr.companionRouteId}&ticket=${ticket}`;
}

async function connectedCompanion(relay: Awaited<ReturnType<typeof startRelay>>, pairing: ReturnType<typeof makePairing>, credential = "companion-credential-32-bytes!!") {
  const socket = new TestSocket(companionUrl(relay.base, pairing.qr, credential));
  await socket.opened;
  return socket;
}

test("paired round trip forwards sealed frames both directions and open() recovers payloads", async () => {
  const relay = await startRelay();
  try {
    const pairing = makePairing();
    const companion = await connectedCompanion(relay, pairing);
    const mobile = new TestSocket(mobileUrl(relay.base, pairing.qr));
    await mobile.opened;

    const ping: EncryptedPayload = { tag: "request", body: { marker: "opaque-plaintext-marker" } };
    mobile.send(JSON.stringify(sealPayload(ping, pairing.m2c.directionKey, pairing.m2c.nonceKey, pairing.qr.companionRouteId, "0198f2a3-0000-7000-8000-0000000000a1", 0)));
    const relayed = JSON.parse(await companion.next()) as EncryptedRelayFrameV1;
    assert.equal(relayed.routeId, pairing.qr.companionRouteId);
    assert.equal(relayed.sequence, 0);

    const fromMobile = new OpeningChannel(pairing.m2c.directionKey, pairing.m2c.nonceKey, pairing.qr.companionRouteId);
    const opened = fromMobile.open(relayed);
    assert.deepEqual(opened, ping);

    const reply: EncryptedPayload = { tag: "health", nonce: "relay-round-trip-health-nonce-1" };
    companion.send(JSON.stringify(sealPayload(reply, pairing.c2m.directionKey, pairing.c2m.nonceKey, pairing.qr.companionRouteId, "0198f2a3-0000-7000-8000-0000000000a2", 0)));
    const mobileFrame = JSON.parse(await mobile.next()) as EncryptedRelayFrameV1;
    const fromCompanion = new OpeningChannel(pairing.c2m.directionKey, pairing.c2m.nonceKey, pairing.qr.companionRouteId);
    assert.deepEqual(fromCompanion.open(mobileFrame), reply);

    const metrics = relay.metrics();
    assert.equal(metrics.framesForwarded, 2);
    assert.ok(metrics.bytesForwarded > 0);
  } finally {
    await relay.close();
  }
});

test("operator view contains no plaintext and audit stays routing-only", async () => {
  const observed: RelayAuditEvent[] = [];
  const relay = createRelayServer({ onAudit: (event) => observed.push(event) });
  const listening = Promise.withResolvers<void>();
  relay.server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = relay.server.address();
  if (address === null || typeof address === "string") throw new Error("expected tcp address");
  const base = `ws://127.0.0.1:${address.port}`;
  try {
    const pairing = makePairing();
    const companion = new TestSocket(companionUrl(base, pairing.qr, "companion-credential-32-bytes!!"));
    await companion.opened;
    const mobile = new TestSocket(mobileUrl(base, pairing.qr));
    await mobile.opened;
    const secretPayload: EncryptedPayload = { tag: "request", body: { confession: "opaque-plaintext-marker-do-not-leak" } };
    mobile.send(JSON.stringify(sealPayload(secretPayload, pairing.m2c.directionKey, pairing.m2c.nonceKey, pairing.qr.companionRouteId, "0198f2a3-0000-7000-8000-0000000000b1", 7)));
    await companion.next();
    const dumps = JSON.stringify(observed) + JSON.stringify(relay.auditEvents());
    assert.ok(!dumps.includes("opaque-plaintext-marker-do-not-leak"));
    assert.ok(!dumps.includes("confession"));
    assert.ok(observed.some((event) => event.kind === "frame-forwarded" && typeof event.bytes === "number"));
  } finally {
    await relay.close();
  }
});

test("unauthenticated peers are closed with policy violations", async () => {
  const relay = await startRelay();
  try {
    const pairing = makePairing();
    const companion = new TestSocket(companionUrl(relay.base, pairing.qr, "attacker-credential-not-the-pair!!"));
    await companion.opened;
    const wrongTicket = new TestSocket(mobileUrl(relay.base, pairing.qr, "EJ8lYk3wP7oq3XvF2mQdRw"));
    const wrongTicketClose = wrongTicket.closed;
    await wrongTicket.opened;
    assert.equal((await wrongTicketClose).code, CLOSE_POLICY_VIOLATION);

    const stranger = makePairing();
    const unregistered = new TestSocket(mobileUrl(relay.base, stranger.qr));
    const unregisteredClose = unregistered.closed;
    await unregistered.opened;
    assert.equal((await unregisteredClose).code, CLOSE_POLICY_VIOLATION);
    const hijack = new TestSocket(companionUrl(relay.base, pairing.qr, "wrong-credential-entirely!!!"));
    const hijackClose = hijack.closed;
    await hijack.opened;
    assert.equal((await hijackClose).code, CLOSE_POLICY_VIOLATION);
    assert.ok(relay.metrics().rejectedAuth >= 3);
  } finally {
    await relay.close();
  }
});

test("malformed, route-mismatched and size-lie frames are rejected without forwarding", async () => {
  const relay = await startRelay();
  try {
    const pairing = makePairing();
    const companion = await connectedCompanion(relay, pairing);
    const mobile = new TestSocket(mobileUrl(relay.base, pairing.qr));
    await mobile.opened;

    mobile.send("this is not json{{{");
    const malformedClose = mobile.closed;
    assert.equal((await malformedClose).code, CLOSE_POLICY_VIOLATION);

    const foreign = sealPayload({ tag: "health", nonce: "aaaaaaaaaaaaaaaaaaaaaaaa" }, pairing.m2c.directionKey, pairing.m2c.nonceKey, pairing.qr.companionRouteId, "0198f2a3-0000-7000-8000-0000000000c1", 0);
    const sizeLie: EncryptedRelayFrameV1 = { ...foreign, declaredSize: foreign.declaredSize + 8 };
    const liar = new TestSocket(mobileUrl(relay.base, pairing.qr));
    await liar.opened;
    liar.send(JSON.stringify(sizeLie));
    const liarClose = liar.closed;
    assert.equal((await liarClose).code, CLOSE_POLICY_VIOLATION);

    const routeMismatch = new TestSocket(mobileUrl(relay.base, pairing.qr));
    await routeMismatch.opened;
    routeMismatch.send(JSON.stringify({ ...foreign, routeId: "0198f2a3-0000-7000-8000-0000000000ff" }));
    const mismatchClose = routeMismatch.closed;
    assert.equal((await mismatchClose).code, CLOSE_POLICY_VIOLATION);

    assert.equal(relay.metrics().framesForwarded, 0);
    assert.ok(relay.metrics().rejectedInvalid >= 3);
    assert.equal(companion.queueLength, 0);
  } finally {
    await relay.close();
  }
});

test("oversized messages beyond the frame limit close the sender with 1009", async () => {
  const relay = await startRelay({ maxFrameBytes: 1024 });
  try {
    const pairing = makePairing();
    const companion = await connectedCompanion(relay, pairing);
    const blaster = new TestSocket(mobileUrl(relay.base, pairing.qr));
    await blaster.opened;
    blaster.send(JSON.stringify(sealPayload({ tag: "request", body: "x".repeat(2048) }, pairing.m2c.directionKey, pairing.m2c.nonceKey, pairing.qr.companionRouteId, "0198f2a3-0000-7000-8000-0000000000d1", 0)));
    const blasterClose = blaster.closed;
    assert.equal((await blasterClose).code, CLOSE_MESSAGE_TOO_BIG);
    await sleep(20);
    assert.ok(relay.metrics().oversizedMessages >= 1);
    const stillAlive = new TestSocket(mobileUrl(relay.base, pairing.qr));
    await stillAlive.opened;
    stillAlive.send(JSON.stringify(sealPayload({ tag: "health", nonce: "bbbbbbbbbbbbbbbbbbbbbbbb" }, pairing.m2c.directionKey, pairing.m2c.nonceKey, pairing.qr.companionRouteId, "0198f2a3-0000-7000-8000-0000000000d2", 1)));
    JSON.parse(await companion.next());
  } finally {
    await relay.close();
  }
});

test("rate limits close noisy connections and stop forwarding", async () => {
  const relay = await startRelay({ messagesPerSecond: 3 });
  try {
    const pairing = makePairing();
    const companion = await connectedCompanion(relay, pairing);
    const spammer = new TestSocket(mobileUrl(relay.base, pairing.qr));
    await spammer.opened;
    for (let sequence = 0; sequence < 10; sequence += 1) {
      spammer.send(JSON.stringify(sealPayload({ tag: "health", nonce: "cccccccccccccccccccccccc" }, pairing.m2c.directionKey, pairing.m2c.nonceKey, pairing.qr.companionRouteId, "0198f2a3-0000-7000-8000-0000000000e1", sequence)));
    }
    const spammerClose = spammer.closed;
    assert.equal((await spammerClose).code, CLOSE_POLICY_VIOLATION);
    assert.ok(relay.metrics().rejectedRate >= 1);
    const delivered = relay.metrics().framesForwarded;
    await sleep(30);
    assert.equal(relay.metrics().framesForwarded, delivered);
  } finally {
    await relay.close();
  }
});

test("companion reconnect keeps framing and session sequences intact", async () => {
  const relay = await startRelay();
  try {
    const pairing = makePairing();
    const first = await connectedCompanion(relay, pairing);
    const mobile = new TestSocket(mobileUrl(relay.base, pairing.qr));
    await mobile.opened;
    const fromMobile = new OpeningChannel(pairing.m2c.directionKey, pairing.m2c.nonceKey, pairing.qr.companionRouteId);

    const frame0 = sealPayload({ tag: "request", body: { step: 1 } }, pairing.m2c.directionKey, pairing.m2c.nonceKey, pairing.qr.companionRouteId, "0198f2a3-0000-7000-8000-0000000000f1", 0);
    mobile.send(JSON.stringify(frame0));
    assert.deepEqual(fromMobile.open(JSON.parse(await first.next()) as EncryptedRelayFrameV1), { tag: "request", body: { step: 1 } });

    first.close();
    await first.closed;
    const second = await connectedCompanion(relay, pairing);
    const frame1 = sealPayload({ tag: "request", body: { step: 2 } }, pairing.m2c.directionKey, pairing.m2c.nonceKey, pairing.qr.companionRouteId, "0198f2a3-0000-7000-8000-0000000000f2", 1);
    mobile.send(JSON.stringify(frame1));
    assert.deepEqual(fromMobile.open(JSON.parse(await second.next()) as EncryptedRelayFrameV1), { tag: "request", body: { step: 2 } });
  } finally {
    await relay.close();
  }
});

test("slow clients get backpressure without losing or corrupting frames", async () => {
  const relay = await startRelay({ highWaterBytes: 1 });
  const pairing = makePairing();
  const companion = new wsModule(companionUrl(relay.base, pairing.qr, "companion-credential-32-bytes!!"));
  const companionOpen = Promise.withResolvers<void>();
  companion.on("open", () => companionOpen.resolve());
  const received: string[] = [];
  companion.on("message", (data) => received.push(data.toString("utf8")));
  try {
    await companionOpen.promise;
    companion._socket.pause();
    const mobile = new TestSocket(mobileUrl(relay.base, pairing.qr));
    await mobile.opened;
    const chunk: EncryptedPayload = { tag: "binary-chunk", transferId: "0198f2a3-0000-7000-8000-0000000000d3", index: 0, bytesBase64Url: "A".repeat(11_000) };
    for (let sequence = 0; sequence < 16; sequence += 1) {
      mobile.send(JSON.stringify(sealPayload(chunk, pairing.m2c.directionKey, pairing.m2c.nonceKey, pairing.qr.companionRouteId, "0198f2a3-0000-7000-8000-0000000000d4", sequence)));
    }
    await sleep(50);
    assert.ok(relay.metrics().backpressureEpisodes >= 1);
    assert.ok(received.length < 16);
    companion._socket.resume();
    while (received.length < 16) await sleep(20);
    const fromMobile = new OpeningChannel(pairing.m2c.directionKey, pairing.m2c.nonceKey, pairing.qr.companionRouteId);
    for (let sequence = 0; sequence < 16; sequence += 1) {
      const frame = JSON.parse(received[sequence] ?? "") as EncryptedRelayFrameV1;
      assert.equal(frame.sequence, sequence);
      assert.deepEqual(fromMobile.open(frame), chunk);
    }
  } finally {
    companion.close();
    await relay.close();
  }
});

test("expired routes are swept and their peers are closed", async () => {
  const relay = await startRelay({ routeTtlMs: 400, sweepIntervalMs: 100 });
  try {
    const pairing = makePairing();
    const companion = await connectedCompanion(relay, pairing);
    const companionClose = companion.closed;
    const mobile = new TestSocket(mobileUrl(relay.base, pairing.qr));
    await mobile.opened;
    assert.equal(relay.metrics().activeRoutes, 1);
    assert.equal((await companionClose).code, CLOSE_POLICY_VIOLATION);
    assert.equal(relay.metrics().activeRoutes, 0);
  } finally {
    await relay.close();
  }
});

test("health, metrics and version endpoints expose only operational metadata", async () => {
  const relay = await startRelay();
  try {
    const health = (await (await fetch(`http://127.0.0.1:${relay.port}/healthz`)).json()) as { ok: boolean; version: string; routes: number };
    assert.equal(health.ok, true);
    assert.equal(health.version, RELAY_VERSION);
    const version = (await (await fetch(`http://127.0.0.1:${relay.port}/release/version`)).json()) as { version: string; protocolMajor: number; protocolMinor: number };
    assert.equal(version.protocolMajor, 1);
    const metrics = (await (await fetch(`http://127.0.0.1:${relay.port}/metrics`)).json()) as { framesForwarded: number; connectionRejections: Record<string, number> };
    assert.equal(metrics.framesForwarded, 0);
    const missing = await fetch(`http://127.0.0.1:${relay.port}/nothing`);
    assert.equal(missing.status, 404);
  } finally {
    await relay.close();
  }
});
