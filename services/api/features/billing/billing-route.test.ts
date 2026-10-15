import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import Fastify from "fastify";
import test from "node:test";
import { memoryAuthStore } from "../auth/index.js";
import { registerBillingRoutes } from "./index.js";
import {
  createBillingEngine,
  memoryPurchaseStore,
  type PurchaseReceipt,
  type StoreVerifier,
} from "@locallab/billing";

const START = "2026-01-01T00:00:00.000Z";
const DAY = 86_400_000;
const SECRET = "webhook-secret";

const catalog = [
  {
    id: "pro-yearly",
    kind: "yearly" as const,
    title: "Pro Yearly",
    priceLabel: "$9.99/yr",
    storeSku: "ll_pro_yearly",
  },
];

function yearly(tx: string): PurchaseReceipt {
  return {
    store: "apple",
    transactionId: tx,
    productId: "pro-yearly",
    purchaseAt: START,
    expiresAt: new Date(Date.parse(START) + 365 * DAY).toISOString(),
    isFamilyShared: false,
  };
}

function sharedFamily(tx: string): PurchaseReceipt {
  return {
    store: "apple",
    transactionId: tx,
    productId: "pro-yearly",
    purchaseAt: START,
    expiresAt: null,
    isFamilyShared: true,
  };
}

function build(receipts: PurchaseReceipt[], family: string[] = []) {
  const app = Fastify();
  const auth = memoryAuthStore();
  const clockMs = { value: Date.parse(START) };
  const engine = createBillingEngine({
    clock: () => new Date(clockMs.value),
    purchases: memoryPurchaseStore(),
    verifier: {
      async verify(receipt) {
        if (!receipts.some((item) => item.transactionId === receipt.transactionId))
          throw new Error("store rejected receipt");
        return { ...receipt, verifiedAt: START };
      },
      async restorePurchases() {
        return receipts.map((item) => ({ ...item, verifiedAt: START }));
      },
    },
    ...(family.length > 0 ? { family: { async membersOf() { return family; } } } : {}),
    products: catalog,
  });
  registerBillingRoutes(app, { engine, auth, webhookSecret: SECRET });
  const token = "billing-token";
  const session = async (userId: string, sessToken = token) => {
    await auth.insertSession({
      tokenHash: createHash("sha256").update(sessToken).digest("hex"),
      userId,
      createdAt: START,
    });
  };
  return { app, engine, auth, clockMs, token, session };
}

function sign(body: unknown): string {
  return createHmac("sha256", SECRET)
    .update(JSON.stringify(body))
    .digest("hex");
}

test("catalog is served exactly as configured", async () => {
  const { app } = build([]);
  const res = await app.inject({ method: "GET", url: "/billing/products" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().products, catalog);
  assert.equal(res.json().products[0].priceLabel, "$9.99/yr");
});

test("purchase needs a session and yields entitlement", async () => {
  const receipt = yearly("tx-1");
  const { app, token, session } = build([receipt]);
  const anon = await app.inject({
    method: "POST",
    url: "/billing/purchase",
    payload: { receipt },
  });
  assert.equal(anon.statusCode, 401);
  await session("buyer");
  const bought = await app.inject({
    method: "POST",
    url: "/billing/purchase",
    headers: { authorization: `Bearer ${token}` },
    payload: { receipt },
  });
  assert.equal(bought.statusCode, 200);
  assert.equal(bought.json().pro, true);
  const ent = await app.inject({
    method: "GET",
    url: "/billing/entitlement",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(ent.json().pro, true);
  assert.equal(ent.json().source, "subscription");
});

test("restore reactivates on a new device without a repurchase", async () => {
  const receipt = yearly("tx-restore");
  const { app, token, session } = build([receipt]);
  await session("traveler");
  const res = await app.inject({
    method: "POST",
    url: "/billing/restore",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().pro, true);
});

test("webhooks need a valid signature; refund revokes entitlement", async () => {
  const receipt = yearly("tx-web");
  const { app, token, session } = build([receipt]);
  await session("webuser");
  const bought = await app.inject({
    method: "POST",
    url: "/billing/purchase",
    headers: { authorization: `Bearer ${token}` },
    payload: { receipt },
  });
  assert.equal(bought.json().pro, true);

  const event = { type: "refund", userId: "webuser", purchase: receipt };
  const bad = await app.inject({
    method: "POST",
    url: "/billing/webhooks",
    headers: { "x-billing-signature": "ff".repeat(32) },
    payload: event,
  });
  assert.equal(bad.statusCode, 401);

  const good = await app.inject({
    method: "POST",
    url: "/billing/webhooks",
    headers: { "x-billing-signature": sign(event) },
    payload: event,
  });
  assert.equal(good.statusCode, 200);
  const ent = await app.inject({
    method: "GET",
    url: "/billing/entitlement",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(ent.json().pro, false);
});

test("unknown products are refused with 400", async () => {
  const { app, token, session } = build([]);
  await session("shoper");
  const res = await app.inject({
    method: "POST",
    url: "/billing/purchase",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      receipt: {
        store: "apple",
        transactionId: "tx-bogus",
        productId: "not-in-catalog",
        purchaseAt: START,
        expiresAt: null,
        isFamilyShared: false,
      },
    },
  });
  assert.equal(res.statusCode, 400);
});

test("family members get the entitlement through the api", async () => {
  const receipt = sharedFamily("tx-fam");
  const { app, session } = build([receipt], ["kid"]);
  await session("parent", "parent-token");
  const parentBuy = await app.inject({
    method: "POST",
    url: "/billing/purchase",
    headers: { authorization: "Bearer parent-token" },
    payload: { receipt },
  });
  assert.equal(parentBuy.json().pro, true);
  await session("kid", "kid-token");
  const kidEnt = await app.inject({
    method: "GET",
    url: "/billing/entitlement",
    headers: { authorization: "Bearer kid-token" },
  });
  assert.equal(kidEnt.json().pro, true);
  assert.equal(kidEnt.json().source, "family");
});
