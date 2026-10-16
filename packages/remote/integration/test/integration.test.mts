/**
 * T103 integration gate smoke over the REAL relay (same wiring as
 * @locallab/remote-client's pairing smoke): after pairing proves ready, both
 * sides attach RemoteSessionHandles from ONE shared session and run chat,
 * image-binary, selective-sync, and hostile-branch paths end to end. The
 * relay only ever sees sealed envelopes — its audit ring and metrics must not
 * contain a single plaintext sentinel.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelayServer } from "@locallab/relay";
import {
  PairingCryptoError,
  createHandshakePairing,
  createPairingQrV1,
  createSessionPairing,
  createUuidV7,
  deriveSessionSalts,
  generateSessionSalt,
  helloProof,
  mobileRouteTicketHash,
} from "@locallab/remote-crypto";
import type { PairingQrV1 } from "@locallab/service-contracts/pairing";
import type { EncryptedPayload, EncryptedRelayFrameV1 } from "@locallab/service-contracts/relay";
import { createPairingClient, type WebSocketLike } from "@locallab/remote-client";
import { MergeStore } from "@locallab/sync-merge";
import { sha256Hex } from "@locallab/remote-binary";
import type { RunEvent } from "@locallab/contracts/run-events";
import {
  ackSyncBatch,
  attachRemoteSession,
  recordingSocket,
  respondToChat,
  sendBinary,
  streamChat,
  syncOneConversation,
  validateFrameOpaque,
  type RemoteSessionHandle,
  type SessionChannels,
} from "../src/index.js";

const fingerprint = `sha256:${"ab12cd34".repeat(8)}`;

async function startRelay() {
  const relay = createRelayServer();
  const listening = Promise.withResolvers<void>();
  relay.server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = relay.server.address();
  if (address === null || typeof address === "string") throw new Error("expected tcp address");
  return { relay, base: `http://127.0.0.1:${address.port}` };
}

function makeQr(relayBase: string): PairingQrV1 {
  return createPairingQrV1({ relayUrl: relayBase, serverIdentityFingerprint: fingerprint });
}

function wsUrl(base: string, path: string, query: string): string {
  return `${base.replace("http://", "ws://")}${path}?${query}`;
}

const wsFactory = (url: string) => new WebSocket(url) as never;

interface LiveSession {
  relay: ReturnType<typeof createRelayServer>;
  qr: PairingQrV1;
  channels: SessionChannels;
  mobileHandle: RemoteSessionHandle;
  companionHandle: RemoteSessionHandle;
  mobileSocket: WebSocket;
  mobileFrame(): string;
}

/** Data-phase wiring: one shared session, attached handles on both live sockets. */
async function openLiveSession(
  relay: ReturnType<typeof createRelayServer>,
  base: string,
  qr: PairingQrV1,
  onCompanionPayload: (session: LiveSession, payload: EncryptedPayload) => void,
  onCompanionError: (error: unknown) => void,
): Promise<LiveSession> {
  const secret = Buffer.from(qr.pairingSecret, "base64url");
  const salts = deriveSessionSalts(secret, qr.companionRouteId);
  // R007: the data phase rides ephemeral-mixed keys; both handles attach
  // to the SAME channels object so the pair matches either way.
  const entropy = { mobileEphemeral: generateSessionSalt(), companionEphemeral: generateSessionSalt() };
  const channels = createSessionPairing(secret, salts.mobileSalt, salts.companionSalt, entropy, qr.companionRouteId);
  const companionSocket = new WebSocket(
    wsUrl(base, "/companion", `routeId=${qr.companionRouteId}&credential=companion-credential-0000` +
      `&mobileTicketHash=${mobileRouteTicketHash(qr.mobileRouteTicket)}`),
  );
  const companionOpened = Promise.withResolvers<void>();
  companionSocket.addEventListener("open", () => companionOpened.resolve());
  await companionOpened.promise;
  const mobileSocket = new WebSocket(
    wsUrl(base, "/mobile", `routeId=${qr.companionRouteId}&ticket=${qr.mobileRouteTicket}`),
  );
  const mobileOpened = Promise.withResolvers<void>();
  mobileSocket.addEventListener("open", () => mobileOpened.resolve());
  await mobileOpened.promise;
  // The global WebSocket structurally satisfies the client socket shape; named aliases for the handle seams.
  const companionChannel = companionSocket as unknown as WebSocketLike;
  const mobileRecorder = recordingSocket(mobileSocket as unknown as WebSocketLike);
  const mobileHandle = attachRemoteSession({ channel: channels.mobile, socket: mobileRecorder.socket });
  const companionHandle = attachRemoteSession({ channel: channels.companion, socket: companionChannel });
  const session: LiveSession = {
    relay,
    qr,
    channels,
    mobileHandle,
    companionHandle,
    mobileSocket,
    mobileFrame: mobileRecorder.sentFrame,
  };
  companionHandle.onPayload((payload) => onCompanionPayload(session, payload));
  companionHandle.onError(onCompanionError);
  return session;
}

/**
 * Pairing-proof phase (client.test.mts pattern): scripted companion answers the
 * sealed hello, the REAL mobile client reaches "ready"; then the pairing
 * sockets close and the data-phase session attaches over the same relay.
 */
async function pairedRelaySession(
  onCompanionPayload: (session: LiveSession, payload: EncryptedPayload) => void,
  onCompanionError: (error: unknown) => void = () => {},
): Promise<LiveSession> {
  const { relay, base } = await startRelay();
  const qr = makeQr(base);
  const secret = Buffer.from(qr.pairingSecret, "base64url");
  const salts = deriveSessionSalts(secret, qr.companionRouteId);
  const handshake = createHandshakePairing(secret, salts.mobileSalt, salts.companionSalt, qr.companionRouteId).companion;
  const pairingCompanion = new WebSocket(
    wsUrl(base, "/companion", `routeId=${qr.companionRouteId}&credential=companion-credential-0000` +
      `&mobileTicketHash=${mobileRouteTicketHash(qr.mobileRouteTicket)}`),
  );
  const opened = Promise.withResolvers<void>();
  pairingCompanion.addEventListener("open", () => opened.resolve());
  await opened.promise;
  const readySent = Promise.withResolvers<void>();
  let mobileEphemeral: Uint8Array | undefined;
  let dataOpen: ReturnType<typeof createSessionPairing>["companion"]["fromMobile"] | undefined;
  pairingCompanion.addEventListener("message", (event) => {
    const payload = (dataOpen ?? handshake.fromMobile).open(JSON.parse(String(event.data)));
    if (payload.tag !== "request") return;
    if (mobileEphemeral === undefined) {
      const salt = (payload.body as { sessionSalt?: unknown }).sessionSalt;
      if (typeof salt === "string") mobileEphemeral = new Uint8Array(Buffer.from(salt, "base64url"));
    }
    const companionEphemeral = generateSessionSalt();
    pairingCompanion.send(
      JSON.stringify(
        handshake.toMobile.seal(
          {
            tag: "request",
            body: {
              type: "pairing-ready",
              proof: helloProof(secret, salts.mobileSalt, salts.companionSalt, qr.companionRouteId),
              protocol: { major: 1, minor: 2 },
              routes: [{ routeId: qr.companionRouteId, backend: "lmstudio", label: "LM Studio" }],
              sessionSalt: Buffer.from(companionEphemeral).toString("base64url"),
            },
          },
          createUuidV7(),
        ),
      ),
    );
    if (mobileEphemeral !== undefined) {
      dataOpen = createSessionPairing(
        secret,
        salts.mobileSalt,
        salts.companionSalt,
        { mobileEphemeral, companionEphemeral },
        qr.companionRouteId,
      ).companion.fromMobile;
    }
    readySent.resolve();
  });
  const client = createPairingClient({ qrText: JSON.stringify(qr), webSocket: wsFactory });
  const connecting = client.connect();
  await readySent.promise;
  await connecting;
  assert.equal(client.state(), "ready");
  // Full close of pairing sockets before the data-phase sockets re-register.
  client.disconnect("handover");
  const closed = Promise.withResolvers<void>();
  pairingCompanion.addEventListener("close", () => closed.resolve());
  pairingCompanion.close(1000, "handover");
  await closed.promise;
  return openLiveSession(relay, base, qr, onCompanionPayload, onCompanionError);
}

function runEvent(
  runId: string,
  sequence: number,
  spec:
    | { type: "RunStarted" }
    | { type: "TextDelta"; text: string }
    | { type: "RunCompleted"; finishReason?: string },
): RunEvent {
  const base = { runId, sequence, timestamp: new Date().toISOString() };
  if (spec.type === "RunStarted") return { ...base, type: "RunStarted" };
  if (spec.type === "TextDelta") return { ...base, type: "TextDelta", text: spec.text };
  return { ...base, type: "RunCompleted", finishReason: spec.finishReason };
}

const DEV = "0198f2a3-0000-7000-8000-0000000000aa";
const hex = (n: number) => n.toString(16).padStart(12, "0");
const syncId = (n: number) => `0198f2a3-0000-7000-8000-${hex(n)}`;
const T0 = "2026-10-01T00:00:00.000Z";

function syncRecord(n: number, text: string) {
  return {
    id: syncId(n),
    createdAt: T0,
    updatedAt: T0,
    revision: { wallMs: n, counter: 0, deviceId: DEV },
    entityType: "message",
    entityId: syncId(10_000 + n),
    payload: {
      id: syncId(10_000 + n),
      createdAt: T0,
      updatedAt: T0,
      revision: { wallMs: n, counter: 0, deviceId: DEV },
      conversationId: syncId(1),
      role: "user",
      parts: [{ type: "text", text }],
      selectedVariantId: null,
      runStatus: "completed",
    },
    acknowledgedAt: null,
  };
}

const drainWait = Promise.withResolvers<void>();

/**
 * The global WebSocket does NOT auto-flush queued sends on close(); the relay
 * heartbeats ping within ~10s and the ws pong handler drains the socket queue,
 * so smoke assertions that need peer delivery wait for a CLOSE-event (ws emits
 * it after flushing queued data).
 */
function drainSockets(session: LiveSession): void {
  session.mobileSocket.addEventListener("close", () => drainWait.resolve());
}

/** Contract fixture: a valid-shaped envelope carrying arbitrary ciphertext. */
const opaqueFrame: EncryptedRelayFrameV1 = {
  protocol: { major: 1, minor: 0 },
  routeId: syncId(9),
  requestId: syncId(8),
  sequence: 0,
  nonceBase64Url: "Zm9vYmFyYmF6cXV1eA",
  contentTag: "request",
  declaredSize: 26,
  ciphertextBase64Url: "aGVsbG93b3JsZDEyMzQ1Njc4OTBhYmNkZWY",
};

test("chat round-trip resolves exactly the emitted events; the companion sees the request body", async () => {
  const runId = syncId(7);
  const seenRequests: unknown[] = [];
  const session = await pairedRelaySession((live, payload) => {
    if (payload.tag !== "request") return;
    seenRequests.push(payload.body);
    const body = payload.body;
    if (typeof body === "object" && body !== null && "type" in body && body.type === "chat-request")
      respondToChat(live.companionHandle, {
        runId,
        events: [
          runEvent(runId, 0, { type: "RunStarted" }),
          runEvent(runId, 1, { type: "TextDelta", text: "chat-sentinel " }),
          runEvent(runId, 2, { type: "TextDelta", text: "chat-text-alpha" }),
          runEvent(runId, 3, { type: "RunCompleted", finishReason: "stop" }),
        ],
      });
  });
  const replayRejected = Promise.withResolvers<void>();
  let replayErrors = 0;
  session.companionHandle.onError((error) => {
    replayErrors += 1;
    if (replayErrors === 2) replayRejected.resolve();
  });
  try {
    const events = await streamChat(session.mobileHandle, {
      runId,
      routeId: session.qr.companionRouteId,
      messages: [{ role: "user", content: "chat-text-alpha" }],
      tools: [],
    });
    assert.deepEqual(events.map((event) => event.type), ["RunStarted", "TextDelta", "TextDelta", "RunCompleted"]);
    assert.deepEqual(
      events.filter((event) => event.type === "TextDelta").map((event) => event.text),
      ["chat-sentinel ", "chat-text-alpha"],
      "events arrive in send order",
    );
    assert.deepEqual(
      seenRequests[0],
      {
        type: "chat-request",
        version: 1,
        routeId: session.qr.companionRouteId,
        messages: [{ role: "user", content: "chat-text-alpha" }],
        tools: [],
      },
      "companion-side sees the full chat-request body (not the relay)",
    );

    // Hostile branch: the SAME sealed frame replayed through the relay twice —
    // every replayed open fails at the companion handle, while streamChat
    // already completed via the first pass.
    const replayFrame = session.mobileFrame();
    session.mobileSocket.send(replayFrame);
    session.mobileSocket.send(replayFrame);
    await replayRejected.promise;
  } finally {
    await session.relay.close();
  }
});

test("a sealed chat-refused settles streamChat with the refusal reason (R028)", async () => {
  // The version-guard counterpart on the phone side: a companion that
  // declines the payload (e.g. future chat-request version) must settle
  // the waiter — reject with the reason — never leave it pending.
  const runId = syncId(5);
  const session = await pairedRelaySession((live, payload) => {
    if (payload.tag !== "request") return;
    const body = payload.body;
    if (typeof body === "object" && body !== null && "type" in body && body.type === "chat-request")
      live.companionHandle.send({
        tag: "request",
        body: { type: "chat-refused", runId, reason: "unsupported chat-request version 2" },
      });
  });
  try {
    await assert.rejects(
      () =>
        streamChat(session.mobileHandle, {
          runId,
          routeId: session.qr.companionRouteId,
          messages: [{ role: "user", content: "future-payload" }],
          tools: [],
        }),
      /unsupported chat-request version 2/,
      "the refusal reason surfaces to the awaiting caller",
    );
  } finally {
    await session.relay.close();
  }
});

test("700 KB image streams mobile -> companion sealed; assembled sha256 matches", async () => {
  const { relay, base } = await startRelay();
  const qr = makeQr(base);
  const session = await openLiveSession(relay, base, qr, () => {}, () => {});
  try {
    const bytes = new Uint8Array(700_000);
    let x = 0x2f6e2b1;
    for (let i = 0; i < bytes.length; i += 1) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      bytes[i] = x & 0xff;
    }
    const transfer = sendBinary(session.mobileHandle, session.companionHandle, {
      transferId: syncId(42),
      mimeType: "image/jpeg",
    }, bytes);
    drainSockets(session);
    const result = await transfer;
    assert.equal(result.sha256, sha256Hex(bytes));
    assert.equal(result.bytes.length, 700_000);
    assert.deepEqual(Array.from(result.bytes.subarray(0, 16)), Array.from(bytes.subarray(0, 16)));
    assert.equal(result.sha256, sha256Hex(result.bytes));
    assert.ok(relay.metrics().framesForwarded >= 5, "the opaque relay ferried every chunk");
  } finally {
    await relay.close();
  }
});

test("one conversation syncs: transport drains to idle and the merge store applies all three", async () => {
  const companionStore = new MergeStore();
  const ackedIds: string[] = [];
  let syncedBatchId = "";
  const session = await pairedRelaySession((live, payload) => {
    if (payload.tag === "sync-batch") {
      syncedBatchId = payload.batchId;
      ackedIds.push(...ackSyncBatch(live.companionHandle, payload, companionStore));
    }
  });
  try {
    const records = [
      syncRecord(1, "sync-sentinel-alpha"),
      syncRecord(2, "sync-sentinel-beta"),
      syncRecord(3, "sync-sentinel-gamma"),
    ];
    const transport = await syncOneConversation(session.mobileHandle, records);
    assert.deepEqual(ackedIds, records.map((record) => record.id));
    assert.equal(companionStore.liveCount(), 3);
    assert.equal(transport.status().state, "idle");
    assert.equal(transport.status().pendingRecords, 0);

    // Ack-redelivery tolerance: the companion redelivers the same ack over the
    // relay; the mobile transport absorbs it idempotently.
    const secondAckSeen = Promise.withResolvers<Extract<EncryptedPayload, { tag: "sync-ack" }>>();
    session.mobileHandle.onPayload((payload) => {
      if (payload.tag === "sync-ack") secondAckSeen.resolve(payload);
    });
    session.companionHandle.send({
      tag: "sync-ack",
      batchId: syncedBatchId,
      recordIds: records.map((record) => record.id),
    });
    const echoed = await secondAckSeen.promise;
    transport.handleAck(echoed);
    assert.equal(transport.status().state, "idle");
    assert.equal(transport.status().pendingRecords, 0);
  } finally {
    await session.relay.close();
  }
});

test("sync-batch to a refused gate: companion sends sync-refused, nothing is stored or acked", async () => {
  const companionStore = new MergeStore();
  const session = await pairedRelaySession((live, payload) => {
    if (payload.tag === "sync-batch")
      ackSyncBatch(live.companionHandle, payload, companionStore, {
        allow: () => false,
        reason: "sync opt-in missing",
      });
  });
  const refused = Promise.withResolvers<unknown>();
  session.mobileHandle.onPayload((payload) => {
    if (payload.tag === "request" && typeof payload.body === "object" && payload.body !== null
      && "type" in payload.body && payload.body.type === "sync-refused")
      refused.resolve(payload.body);
  });
  try {
    await assert.rejects(
      syncOneConversation(session.mobileHandle, [
        syncRecord(1, "sync-sentinel-refused"),
        syncRecord(2, "never-synced"),
      ]),
      /sync refused by the paired device: sync opt-in missing/,
    );
    const body = await refused.promise;
    assert.ok(typeof body === "object" && body !== null);
    assert.ok("type" in body && body.type === "sync-refused");
    assert.ok("reason" in body && body.reason === "sync opt-in missing");
    assert.equal(companionStore.liveCount(), 0, "fail-closed: refused records never land");
  } finally {
    await session.relay.close();
  }
});

test("validateFrameOpaque rejects mismatched declaredSize (contract fixture)", () => {
  validateFrameOpaque(opaqueFrame);
  assert.throws(() => validateFrameOpaque({ ...opaqueFrame, declaredSize: 999 }), /declared size/);
  assert.throws(() => validateFrameOpaque({ ...opaqueFrame, declaredSize: 0 }), /declared size/);
});

test("replayed and tampered sealed frames surface as PairingCryptoErrors, never crashes", async () => {
  const runId = syncId(11);
  const session = await pairedRelaySession((live, payload) => {
    if (payload.tag !== "request") return;
    const body = payload.body;
    if (typeof body === "object" && body !== null && "type" in body && body.type === "chat-request")
      respondToChat(live.companionHandle, {
        runId,
        events: [
          runEvent(runId, 0, { type: "RunStarted" }),
          runEvent(runId, 1, { type: "RunCompleted" }),
        ],
      });
  });
  const tamperRejected = Promise.withResolvers<unknown>();
  session.companionHandle.onError((error) => tamperRejected.resolve(error));
  try {
    const events = await streamChat(session.mobileHandle, {
      runId,
      routeId: session.qr.companionRouteId,
      messages: [{ role: "user", content: "hostile-path-check" }],
      tools: [],
    });
    assert.deepEqual(events.map((event) => event.type), ["RunStarted", "RunCompleted"]);
    // Replay: the identical recorded frame again (its sequence is spent).
    session.mobileSocket.send(session.mobileFrame());
    const first = await tamperRejected.promise;
    assert.ok(first instanceof PairingCryptoError, `replay must reject, saw ${String(first)}`);
    // Tamper: seal a FRESH payload on the shared channel, then flip trailing
    // ciphertext bytes after sealing — the envelope stays schema-valid and
    // authenticated decryption MUST fail closed.
    const fresh = session.channels.mobile.toCompanion.seal(
      { tag: "cancel", reason: "tamper-probe" },
      createUuidV7(),
    );
    const tampered: EncryptedRelayFrameV1 = {
      ...fresh,
      ciphertextBase64Url: `${fresh.ciphertextBase64Url.slice(0, -2)}XX`,
    };
    const rejected = Promise.withResolvers<unknown>();
    session.companionHandle.onError((error) => rejected.resolve(error));
    session.mobileSocket.send(JSON.stringify(tampered));
    const second = await rejected.promise;
    assert.ok(second instanceof PairingCryptoError, "tampering must fail closed");
  } finally {
    await session.relay.close();
  }
});

test("the opaque relay never sees plaintext: audit ring and metrics carry no sentinels", async () => {
  const runId = syncId(12);
  const session = await pairedRelaySession((live, payload) => {
    if (payload.tag === "request") {
      const body = payload.body;
      if (typeof body === "object" && body !== null && "type" in body && body.type === "chat-request")
        respondToChat(live.companionHandle, {
          runId,
          events: [
            runEvent(runId, 0, { type: "RunStarted" }),
            runEvent(runId, 1, { type: "TextDelta", text: "opaque-sentinel-chat" }),
            runEvent(runId, 2, { type: "RunCompleted" }),
          ],
        });
    } else if (payload.tag === "sync-batch") {
      ackSyncBatch(live.companionHandle, payload, new MergeStore());
    }
  });
  try {
    await streamChat(session.mobileHandle, {
      runId,
      routeId: session.qr.companionRouteId,
      messages: [{ role: "user", content: "opaque-sentinel-chat" }],
      tools: [],
    });
    // Sync one conversation: ride the sealed path to an observable idle drain.
    const transport = await syncOneConversation(session.mobileHandle, [
      syncRecord(1, "opaque-sentinel-sync"),
    ]);
    assert.equal(transport.status().state, "idle");
    assert.equal(transport.status().pendingRecords, 0);
    const auditDump = JSON.stringify(session.relay.auditEvents());
    const metricsDump = JSON.stringify(session.relay.metrics());
    for (const sentinel of ["opaque-sentinel-chat", "opaque-sentinel-sync", runId]) {
      assert.ok(!auditDump.includes(sentinel), `audit ring must not contain ${sentinel}`);
      assert.ok(!metricsDump.includes(sentinel), `metrics must not contain ${sentinel}`);
    }
    assert.ok(session.relay.metrics().framesForwarded > 0, "traffic really crossed the relay");
  } finally {
    await session.relay.close();
  }
});
