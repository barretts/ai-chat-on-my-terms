/**
 * T096 end-to-end pairing smoke: real relay (createRelayServer) + scripted
 * companion + the mobile pairing client. Proves the card smoke criteria at
 * unit level: pairing works over our own stack, invalid/old QR text can
 * never pair, and no official LM Mini format is accepted.
 *
 * Timing note: the relay DROPS frames when the target peer is offline, so
 * the scripted companion must REGISTER before the mobile connects; hello
 * then flows immediately once the mobile opens.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelayServer } from "@locallab/relay";
import {
  PairingCryptoError,
  createHandshakePairing,
  createPairingQrV1,
  createPairingRecord,
  createSessionPairing,
  createUuidV7,
  deriveSessionSalts,
  encodePairingQrPayload,
  generateSessionSalt,
  helloProof,
  mobileRouteTicketHash,
  verifyHelloProof,
  type OpeningChannel,
} from "@locallab/remote-crypto";
import { type PairingQrV1 } from "@locallab/service-contracts/pairing";
import {
  createPairingClient,
  revokePairedDevice,
  rotatePairedDevice,
  storePairedDevice,
  usablePairing,
  type PairingRecord,
  type PairingVault,
} from "@locallab/remote-client";

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

interface CompanionSim {
  socket: WebSocket;
  hello: () => Promise<unknown>;
  ready: (
    protocol: { major: number; minor: number },
    routes: { routeId: string; backend: string; label: string }[],
    proof?: string,
  ) => void;
  receivedClose: () => Promise<{ reason?: string }>;
}

/**
 * Registers a scripted companion on the relay and answers sealed hellos.
 * R007 framing: hello/ready ride the deterministic handshake channel;
 * once both sides' ephemerals are exchanged the companion opens later
 * frames (close etc.) on the per-connection data channel.
 */
async function registerCompanion(base: string, qr: PairingQrV1): Promise<CompanionSim> {
  const secret = Buffer.from(qr.pairingSecret, "base64url");
  const { mobileSalt, companionSalt } = deriveSessionSalts(secret, qr.companionRouteId);
  const handshake = createHandshakePairing(secret, mobileSalt, companionSalt, qr.companionRouteId).companion;
  const socket = new WebSocket(
    `${base.replace("http://", "ws://")}/companion?routeId=${qr.companionRouteId}` +
      "&credential=companion-credential-0000" +
      `&mobileTicketHash=${mobileRouteTicketHash(qr.mobileRouteTicket)}`,
  );
  const opened = Promise.withResolvers<void>();
  socket.addEventListener("open", () => opened.resolve());
  await opened.promise;
  const helloSeen = Promise.withResolvers<unknown>();
  const closeSeen = Promise.withResolvers<{ reason?: string }>();
  let mobileEphemeral: Uint8Array | undefined;
  let dataFromMobile: OpeningChannel | undefined;
  socket.addEventListener("message", (event) => {
    const payload = (dataFromMobile ?? handshake.fromMobile).open(JSON.parse(String(event.data)));
    if (payload.tag === "request") {
      const salt = (payload.body as { sessionSalt?: unknown }).sessionSalt;
      if (typeof salt === "string") mobileEphemeral = new Uint8Array(Buffer.from(salt, "base64url"));
      helloSeen.resolve(payload.body);
    } else if (payload.tag === "close") closeSeen.resolve({ reason: payload.reason });
  });
  const proof = helloProof(secret, mobileSalt, companionSalt, qr.companionRouteId);
  return {
    socket,
    hello: () => helloSeen.promise,
    ready: (protocol, routes, proofOut = proof) => {
      const companionEphemeral = generateSessionSalt();
      socket.send(
        JSON.stringify(
          handshake.toMobile.seal(
            {
              tag: "request",
              body: {
                type: "pairing-ready",
                proof: proofOut,
                protocol,
                routes,
                sessionSalt: Buffer.from(companionEphemeral).toString("base64url"),
              },
            },
            createUuidV7(),
          ),
        ),
      );
      if (mobileEphemeral !== undefined) {
        dataFromMobile = createSessionPairing(
          secret,
          mobileSalt,
          companionSalt,
          { mobileEphemeral, companionEphemeral },
          qr.companionRouteId,
        ).companion.fromMobile;
      }
    },
    receivedClose: () => closeSeen.promise,
  };
}

const wsFactory = (url: string) => new WebSocket(url) as never;

test("pairs over the live relay and negotiates route capabilities", async () => {
  const { relay, base } = await startRelay();
  try {
    const qr = makeQr(base);
    const companion = await registerCompanion(base, qr);
    const client = createPairingClient({ qrText: encodePairingQrPayload(qr), webSocket: wsFactory });
    const connecting = client.connect();
    const body = (await companion.hello()) as { type: string; proof: string };
    assert.equal(body.type, "pairing-hello");
    const secret = Buffer.from(qr.pairingSecret, "base64url");
    const salts = deriveSessionSalts(secret, qr.companionRouteId);
    assert.ok(verifyHelloProof(body.proof, secret, salts.mobileSalt, salts.companionSalt, qr.companionRouteId));
    companion.ready({ major: 1, minor: 0 }, [
      { routeId: "route-lmstudio", backend: "lmstudio", label: "LM Studio" },
      { routeId: "route-ollama", backend: "ollama", label: "Ollama" },
    ]);
    const routes = await connecting;
    assert.equal(client.state(), "ready");
    assert.deepEqual(routes.map((entry) => entry.label), ["LM Studio", "Ollama"]);
    client.disconnect("bye");
    const closed = await companion.receivedClose();
    assert.equal(closed.reason, "bye");
  } finally {
    await relay.close();
  }
});

test("hello travels mobile -> relay -> companion sealed", async () => {
  const { relay, base } = await startRelay();
  try {
    const qr = makeQr(base);
    const companion = await registerCompanion(base, qr);
    const client = createPairingClient({ qrText: encodePairingQrPayload(qr), webSocket: wsFactory });
    const connecting = client.connect();
    const body = (await companion.hello()) as { client: string; protocol: { major: number; minor: number } };
    assert.equal(body.client, "locallab-mobile");
    assert.deepEqual(body.protocol, { major: 1, minor: 2 });
    companion.ready(body.protocol, [{ routeId: "route-local", backend: "local", label: "Local runtime" }]);
    const routes = await connecting;
    assert.equal(client.state(), "ready");
    assert.equal(routes[0]?.backend, "local");
  } finally {
    await relay.close();
  }
});

test("version mismatch ends in an explicit re-pair help state", async () => {
  const { relay, base } = await startRelay();
  try {
    const qr = makeQr(base);
    const companion = await registerCompanion(base, qr);
    const client = createPairingClient({ qrText: encodePairingQrPayload(qr), webSocket: wsFactory });
    const connecting = client.connect();
    await companion.hello();
    companion.ready({ major: 2, minor: 0 }, []);
    await assert.rejects(connecting);
    assert.equal(client.state(), "version-mismatch");
    assert.match(client.note(), /QR code/i);
  } finally {
    await relay.close();
  }
});

test("a companion that cannot prove possession forces re-pair", async () => {
  const { relay, base } = await startRelay();
  try {
    const qr = makeQr(base);
    const companion = await registerCompanion(base, qr);
    const client = createPairingClient({ qrText: encodePairingQrPayload(qr), webSocket: wsFactory });
    const connecting = client.connect();
    await companion.hello();
    companion.ready({ major: 1, minor: 0 }, [], "bogus-proof-value-000000");
    await assert.rejects(connecting);
    assert.equal(client.state(), "re-pair-required");
    assert.match(client.note(), /fresh QR code/i);
  } finally {
    await relay.close();
  }
});

test("old or foreign QR payloads cannot pair", () => {
  // Official LM Mini payloads and pre-v1 drafts are rejected by the strict
  // QrV1 schema — no interop is attempted.
  for (const text of [
    JSON.stringify({ pairingCode: "LM-MINI-4821", pin: "123456" }),
    JSON.stringify({ version: 0, secret: "x" }),
    "not json at all",
  ]) {
    assert.throws(() => createPairingClient({ qrText: text, webSocket: wsFactory }), PairingCryptoError);
  }
});

test("a stale mobile ticket is rejected by the relay and forces re-pair", async () => {
  const { relay, base } = await startRelay();
  try {
    const qr = makeQr(base);
    const companion = await registerCompanion(base, qr);
    // Route exists (registered), but this QR copy carries a different ticket.
    const stale = { ...qr, mobileRouteTicket: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
    const client = createPairingClient({ qrText: encodePairingQrPayload(stale), webSocket: wsFactory });
    await assert.rejects(client.connect());
    assert.equal(client.state(), "re-pair-required");
    assert.equal(client.note().length > 0, true);
    companion.socket.close();
  } finally {
    await relay.close();
  }
});

test("revoke and rotation lifecycle: old pairs never connect again", async () => {
  const { relay, base } = await startRelay();
  try {
    const memory: { records: PairingRecord[] } = { records: [] };
    const vault: PairingVault = {
      load: async () => memory.records,
      save: async (records) => {
        memory.records = [...records];
      },
    };
    const first = createPairingRecord({
      relayUrl: base,
      serverIdentityFingerprint: fingerprint,
      label: "My Mac",
      now: new Date().toISOString(),
    });
    await storePairedDevice(vault, first);
    assert.equal(usablePairing(memory.records, first.qr.companionRouteId).label, "My Mac");

    const rotation = await rotatePairedDevice(vault, first.qr.companionRouteId, new Date().toISOString());
    assert.ok(rotation.old.revokedAt !== null);
    assert.notEqual(rotation.next.qr.companionRouteId, first.qr.companionRouteId);
    assert.throws(
      () => usablePairing(memory.records, first.qr.companionRouteId),
      (error: unknown) => error instanceof PairingCryptoError && /invalidated/i.test(error.message),
    );

    // The rotated pairing pairs fresh on its new route...
    const companion = await registerCompanion(base, rotation.next.qr);
    const client = createPairingClient({ qrText: encodePairingQrPayload(rotation.next.qr), webSocket: wsFactory });
    const connecting = client.connect();
    const body = (await companion.hello()) as { protocol: { major: number; minor: number } };
    companion.ready(body.protocol, [{ routeId: "route-omlx", backend: "omlx", label: "oMLX" }]);
    const routes = await connecting;
    assert.equal(client.state(), "ready");
    assert.equal(routes[0]?.label, "oMLX");
    client.disconnect();

    // ...while the OLD QR's route no longer exists and cannot pair.
    const staleClient = createPairingClient({ qrText: encodePairingQrPayload(first.qr), webSocket: wsFactory });
    await assert.rejects(staleClient.connect());
    assert.equal(staleClient.state(), "re-pair-required");

    const revoked = await revokePairedDevice(vault, rotation.next.qr.companionRouteId, new Date().toISOString());
    assert.ok(revoked.revokedAt !== null);
    assert.throws(() => usablePairing(memory.records, rotation.next.qr.companionRouteId), PairingCryptoError);
  } finally {
    await relay.close();
  }
});
