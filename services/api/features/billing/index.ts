/** Billing API surface (AC-03/AC-04): configured product catalog,
 * receipt submission, cross-device restore, and webhook-driven
 * entitlement reconciliation. Store credentials/signing secrets are
 * explicit external release requirements — injected here, never baked
 * into code. */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  BillingError,
  type BillingEngine,
  type WebhookEvent,
} from "@locallab/billing";
import type { AuthStore } from "../auth/index.js";

export interface RegisterBillingOptions {
  engine: BillingEngine;
  auth: AuthStore;
  webhookSecret: string;
}

export function registerBillingRoutes(
  app: FastifyInstance,
  options: RegisterBillingOptions,
): void {
  // Raw-body capture is required to verify webhook signatures over the
  // exact bytes the store signed.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body, done) => {
      (request as { rawBody?: string }).rawBody = body as string;
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(new Error("invalid json"), undefined);
      }
    },
  );

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

  app.get("/billing/products", async () => {
    return { products: options.engine.products() };
  });

  app.post("/billing/purchase", async (request, reply) => {
    const userId = await sessionUserId(request.headers);
    if (userId === null) return reply.code(401).send({ code: "no-session" });
    const body = request.body as { receipt?: unknown };
    try {
      const state = await options.engine.recordPurchase(
        userId,
        body.receipt as never,
      );
      return reply.code(200).send(state);
    } catch (error) {
      if (error instanceof BillingError)
        return reply.code(400).send({ code: "invalid-receipt" });
      return reply.code(400).send({ code: "verification-failed" });
    }
  });

  /** Cross-device account activation: restoring re-verifies the store's
   * transactions for this account; no repurchase. */
  app.post("/billing/restore", async (request, reply) => {
    const userId = await sessionUserId(request.headers);
    if (userId === null) return reply.code(401).send({ code: "no-session" });
    const state = await options.engine.restore(userId);
    return reply.code(200).send(state);
  });

  app.get("/billing/entitlement", async (request, reply) => {
    const userId = await sessionUserId(request.headers);
    if (userId === null) return reply.code(401).send({ code: "no-session" });
    return reply.code(200).send(await options.engine.entitlementForAnyone(userId));
  });

  app.post("/billing/webhooks", async (request, reply) => {
    const raw = (request as unknown as { rawBody?: string }).rawBody ?? "";
    const signature = request.headers["x-billing-signature"];
    if (typeof signature !== "string")
      return reply.code(401).send({ code: "missing-signature" });
    const expected = createHmac("sha256", options.webhookSecret)
      .update(raw)
      .digest();
    const provided = Buffer.from(signature, "hex");
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    )
      return reply.code(401).send({ code: "bad-signature" });
    const event = request.body as WebhookEvent;
    if (
      typeof event.type !== "string" ||
      typeof event.userId !== "string" ||
      typeof event.purchase !== "object" ||
      event.purchase === null
    )
      return reply.code(400).send({ code: "malformed-event" });
    const state = await options.engine.applyWebhook(event);
    return reply.code(200).send(state ?? { ignored: true });
  });
}
