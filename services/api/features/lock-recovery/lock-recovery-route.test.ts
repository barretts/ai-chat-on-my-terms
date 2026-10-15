import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import test from "node:test";
import { memoryAuthStore } from "../auth/index.js";
import {
  NO_RECOVERY_GUIDANCE,
  registerLockRecoveryRoutes,
} from "./index.js";
import {
  createDeviceRecoveryIdentity,
  memoryRecoveryStore,
} from "@locallab/security-recovery";

const KEY = "8f".repeat(32);

function build(nowMs: { value: number }) {
  const app = Fastify();
  const auth = memoryAuthStore();
  const recovery = memoryRecoveryStore();
  const sent: { to: string; subject: string; body: string }[] = [];
  registerLockRecoveryRoutes(app, {
    auth,
    recovery,
    mail: {
      async send(to, subject, body) {
        sent.push({ to, subject, body });
      },
    },
    signingKeyHex: KEY,
    grantTtlMs: 30 * 60 * 1000,
    now: () => new Date(nowMs.value),
  });
  const identity = createDeviceRecoveryIdentity();
  const token = "session-token-1";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return { app, auth, recovery, sent, identity, token, nowMs };
}

async function enroll(
  app: ReturnType<typeof Fastify>,
  token: string,
  deviceIdHash: string,
  email: string,
) {
  return await app.inject({
    method: "POST",
    url: "/lock-recovery/enroll",
    headers: { authorization: `Bearer ${token}` },
    payload: { deviceIdHash, email },
  });
}

const grantFrom = (body: string): string => {
  const match = /PIN: (\S+)$/.exec(body);
  if (match === null) throw new Error("no grant in mail");
  return match[1];
};

test("enrollment only stores a device hash, never a secret", async () => {
  const nowMs = { value: Date.parse("2026-10-14T00:00:00.000Z") };
  const { app, auth, sent, token, identity } = build(nowMs);
  await auth.insertSession({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    userId: "user-1",
    createdAt: "2026-10-14T00:00:00.000Z",
  });
  const enrolled = await enroll(app, token, identity.deviceIdHash, "me@b.co");
  assert.equal(enrolled.statusCode, 200);
  // Even if a client enrolls the raw secret where a hash belongs, the
  // redeem side hashes again, so the chain cannot be shortcut.
  await enroll(app, token, identity.deviceSecret, "trick@b.co");
  await app.inject({
    method: "POST",
    url: "/lock-recovery/request",
    payload: { email: "trick@b.co" },
  });
  const trickGrant = grantFrom(sent[sent.length - 1].body);
  const trickRedeem = await app.inject({
    method: "POST",
    url: "/lock-recovery/redeem",
    payload: { grant: trickGrant, deviceSecret: identity.deviceSecret },
  });
  assert.equal(trickRedeem.statusCode, 403);
});

test("enroll requires an authenticated session", async () => {
  const nowMs = { value: 0 };
  const { app } = build(nowMs);
  const anon = await app.inject({
    method: "POST",
    url: "/lock-recovery/enroll",
    payload: { deviceIdHash: "ab".repeat(32), email: "x@b.co" },
  });
  assert.equal(anon.statusCode, 401);
});

test("full recovery: enroll, emailed grant, redeem on the bound device", async () => {
  const nowMs = { value: Date.parse("2026-10-14T00:00:00.000Z") };
  const { app, auth, sent, identity, token } = build(nowMs);
  await auth.insertSession({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    userId: "user-2",
    createdAt: "2026-10-14T00:00:00.000Z",
  });
  await enroll(app, token, identity.deviceIdHash, "me@b.co");
  const requested = await app.inject({
    method: "POST",
    url: "/lock-recovery/request",
    payload: { email: "me@b.co" },
  });
  assert.equal(requested.statusCode, 200);
  const grant = grantFrom(sent[0].body);
  const redeemed = await app.inject({
    method: "POST",
    url: "/lock-recovery/redeem",
    payload: { grant, deviceSecret: identity.deviceSecret },
  });
  assert.equal(redeemed.statusCode, 200);
  assert.equal(redeemed.json().cleared, "lock-verifier-only");
});

test("unlinked users get explicit no-recovery/reinstall guidance", async () => {
  const nowMs = { value: 0 };
  const { app } = build(nowMs);
  const requested = await app.inject({
    method: "POST",
    url: "/lock-recovery/request",
    payload: { email: "ghost@b.co" },
  });
  assert.equal(requested.statusCode, 200);
  assert.equal(requested.json().code, "no-recovery");
  assert.equal(requested.json().guidance, NO_RECOVERY_GUIDANCE);
  assert.match(NO_RECOVERY_GUIDANCE, /reinstall/i);
  assert.match(NO_RECOVERY_GUIDANCE, /backup/i);
});

test("expired, replayed, and cross-device grants cannot unlock", async () => {
  const nowMs = { value: Date.parse("2026-10-14T00:00:00.000Z") };
  const { app, auth, sent, identity, token } = build(nowMs);
  await auth.insertSession({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    userId: "user-3",
    createdAt: "2026-10-14T00:00:00.000Z",
  });
  await enroll(app, token, identity.deviceIdHash, "me@b.co");
  await app.inject({
    method: "POST",
    url: "/lock-recovery/request",
    payload: { email: "me@b.co" },
  });
  const grant = grantFrom(sent[sent.length - 1].body);

  // Cross-device: another device does not hold the recovery secret.
  const cross = await app.inject({
    method: "POST",
    url: "/lock-recovery/redeem",
    payload: { grant, deviceSecret: "a".repeat(64) },
  });
  assert.equal(cross.statusCode, 403);
  assert.equal(cross.json().code, "cross-device");

  // Expiry moves the clock, not the grant.
  nowMs.value += 31 * 60 * 1000;
  const expired = await app.inject({
    method: "POST",
    url: "/lock-recovery/redeem",
    payload: { grant, deviceSecret: identity.deviceSecret },
  });
  assert.equal(expired.statusCode, 410);

  // Replay: a fresh grant, redeemed once, cannot be redeemed twice.
  nowMs.value = Date.parse("2026-10-14T02:00:00.000Z");
  await app.inject({
    method: "POST",
    url: "/lock-recovery/request",
    payload: { email: "me@b.co" },
  });
  const grant2 = grantFrom(sent[sent.length - 1].body);
  const first = await app.inject({
    method: "POST",
    url: "/lock-recovery/redeem",
    payload: { grant: grant2, deviceSecret: identity.deviceSecret },
  });
  assert.equal(first.statusCode, 200);
  const replay = await app.inject({
    method: "POST",
    url: "/lock-recovery/redeem",
    payload: { grant: grant2, deviceSecret: identity.deviceSecret },
  });
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.json().code, "grant-used");
});

test("forged grants fail closed", async () => {
  const nowMs = { value: Date.parse("2026-10-14T00:00:00.000Z") };
  const { app, token } = build(nowMs);
  const forged = await app.inject({
    method: "POST",
    url: "/lock-recovery/redeem",
    payload: { grant: "anything.random", deviceSecret: "00".repeat(32) },
  });
  assert.ok(forged.statusCode === 400 || forged.statusCode === 401);
  assert.ok(![200, 204].includes(forged.statusCode));
});
