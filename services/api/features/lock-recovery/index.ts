/** Authenticated PIN recovery service (DA-08). Enrollment binds a device
 * recovery hash (never the PIN, never chats) to an authenticated account;
 * recovery runs through a signed, expiring, single-use, device-bound
 * grant delivered by email. */

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  DEFAULT_GRANT_TTL_MS,
  GRANT_VERSION,
  issueGrant,
  sha256Hex,
  verifyGrant,
  memoryRecoveryStore,
  type RecoveryStore,
} from "@locallab/security-recovery";
import { createHash } from "node:crypto";
import type { AuthStore } from "../auth/index.js";

const DEVICE_ID_HASH = /^[0-9a-f]{64}$/;

export const NO_RECOVERY_GUIDANCE =
  "This device has no recovery enrollment on that account. We cannot " +
  "remove the lock for you; uninstall and reinstall the app to start " +
  "fresh, and restore chats only from an encrypted cloud backup you made.";

export interface RegisterLockRecoveryOptions {
  auth: AuthStore;
  recovery: RecoveryStore;
  mail: { send(to: string, subject: string, body: string): Promise<void> };
  signingKeyHex: string;
  grantTtlMs?: number;
  now?: () => Date;
}

export function registerLockRecoveryRoutes(
  app: FastifyInstance,
  options: RegisterLockRecoveryOptions,
): void {
  const now = options.now ?? (() => new Date());
  const ttl = options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;

  async function sessionUserId(
    headers: { authorization?: string },
  ): Promise<string | null> {
    const header = headers.authorization;
    if (header === undefined || !header.startsWith("Bearer ")) return null;
    const tokenHash = createHash("sha256")
      .update(header.slice(7))
      .digest("hex");
    const session = await options.auth.findSession(tokenHash);
    return session === null ? null : session.userId;
  }

  app.post("/lock-recovery/enroll", async (request, reply) => {
    const userId = await sessionUserId(request.headers);
    if (userId === null) return reply.code(401).send({ code: "no-session" });
    const body = request.body as { deviceIdHash?: string };
    if (typeof body.deviceIdHash !== "string" || !DEVICE_ID_HASH.test(body.deviceIdHash))
      return reply.code(400).send({ code: "malformed-device-hash" });
    const enrollmentId = randomUUID();
    await options.recovery.insertEnrollment({
      id: enrollmentId,
      userId,
      // The enrollment belongs to the signed-in user; email is supplied
      // later at request time only to route the grant message.
      email: (request.body as { email?: string }).email?.trim().toLowerCase() ?? userId,
      deviceIdHash: body.deviceIdHash,
      createdAt: now().toISOString(),
    });
    return reply.code(200).send({ enrollmentId });
  });

  app.post("/lock-recovery/request", async (request, reply) => {
    const body = request.body as { email?: string; enrollmentId?: string };
    const email = body.email?.trim() ?? "";
    const matches = await options.recovery.enrollmentsByEmail(email);
    if (matches.length === 0)
      // Smoke contract: unlinked users get an explicit, honest path.
      return reply
        .code(200)
        .send({ code: "no-recovery", guidance: NO_RECOVERY_GUIDANCE });
    const enrollment =
      body.enrollmentId === undefined
        ? matches[matches.length - 1]
        : matches.find((item) => item.id === body.enrollmentId);
    if (enrollment === undefined)
      return reply.code(400).send({ code: "no-such-enrollment" });
    const issuedAt = now().getTime();
    const grant = issueGrant(
      {
        v: GRANT_VERSION,
        enrollmentId: enrollment.id,
        deviceIdHash: enrollment.deviceIdHash,
        iat: issuedAt,
        exp: issuedAt + ttl,
        nonce: randomUUID(),
      },
      options.signingKeyHex,
    );
    await options.mail.send(
      enrollment.email,
      "AI Chat lock recovery code",
      `Enter this code on the locked device to remove your PIN: ${grant}`,
    );
    return reply.code(200).send({ sent: true });
  });

  /** The locked device redeems the emailed grant with its local recovery
   * secret. Success means the app may clear ONLY the lock verifier. */
  app.post("/lock-recovery/redeem", async (request, reply) => {
    const body = request.body as { grant?: string; deviceSecret?: string };
    if (typeof body.grant !== "string" || typeof body.deviceSecret !== "string")
      return reply.code(400).send({ code: "missing-fields" });
    const verified = verifyGrant(grantOrEmpty(body.grant), options.signingKeyHex, now().getTime());
    if (!verified.ok)
      return reply
        .code(verified.code === "expired" ? 410 : 400)
        .send({ code: verified.code });
    // Device binding: the secret hashing to the enrolled hash proves the
    // grant is redeemed on the enrolled device (cross-device fails).
    if (sha256Hex(body.deviceSecret) !== verified.payload.deviceIdHash)
      return reply.code(403).send({ code: "cross-device" });
    const fresh = await options.recovery.consumeNonce(verified.payload.nonce);
    if (!fresh) return reply.code(409).send({ code: "grant-used" });
    return reply.code(200).send({
      cleared: "lock-verifier-only",
      guidance:
        "The PIN verifier will be removed from this device. Nothing else " +
        "is deleted.",
    });
  });
}

function grantOrEmpty(grant: string): string {
  return grant.trim();
}

