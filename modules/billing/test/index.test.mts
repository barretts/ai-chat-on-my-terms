import assert from "node:assert/strict";
import test from "node:test";
import {
  BillingError,
  createBillingEngine,
  memoryPurchaseStore,
  receiptPortFor,
  type PurchaseReceipt,
  type StoreVerifier,
  type VerifiedPurchase,
} from "../src/index.ts";
import { createEntitlements, memoryEntitlementStore } from "@locallab/entitlements";

const DAY = 86_400_000;
const START = "2026-01-01T00:00:00.000Z";

function fixtureVerifier(purchases: PurchaseReceipt[]): StoreVerifier {
  const verified = (r: PurchaseReceipt): VerifiedPurchase => ({
    ...r,
    verifiedAt: START,
  });
  return {
    async verify(receipt) {
      if (!purchases.some((item) => item.transactionId === receipt.transactionId))
        throw new BillingError("receipt not recognized by the store");
      return verified(receipt);
    },
    async restorePurchases() {
      return purchases.map(verified);
    },
  };
}

const products = [
  {
    id: "pro-monthly",
    kind: "monthly" as const,
    title: "Pro Monthly",
    priceLabel: "$1.99/mo",
    storeSku: "ll_pro_monthly",
  },
  {
    id: "pro-yearly",
    kind: "yearly" as const,
    title: "Pro Yearly",
    priceLabel: "$9.99/yr",
    storeSku: "ll_pro_yearly",
  },
  {
    id: "pro-lifetime",
    kind: "lifetime" as const,
    title: "Pro Lifetime",
    priceLabel: "$29.99",
    storeSku: "ll_pro_lifetime",
  },
];

function monthly(tx: string, expires: string): PurchaseReceipt {
  return {
    store: "apple",
    transactionId: tx,
    productId: "pro-monthly",
    purchaseAt: START,
    expiresAt: expires,
    isFamilyShared: false,
  };
}

function build(clockMs: { value: number }, receipts: PurchaseReceipt[], family?: string[]) {
  const engine = createBillingEngine({
    clock: () => new Date(clockMs.value),
    purchases: memoryPurchaseStore(),
    verifier: fixtureVerifier(receipts),
    ...(family === undefined
      ? {}
      : { family: { async membersOf() { return family; } } }),
    products,
  });
  return { engine, clockMs };
}

test("catalog products come from configuration, not from the package", async () => {
  const { engine } = build({ value: Date.parse(START) }, []);
  assert.deepEqual(engine.products(), products);
  assert.equal(engine.products()[0]?.priceLabel, "$1.99/mo");
});

test("monthly purchase is Pro until expiry; a renewal webhook extends it", async () => {
  const expires = new Date(Date.parse(START) + 30 * DAY).toISOString();
  const renewed = new Date(Date.parse(START) + 60 * DAY).toISOString();
  const { engine, clockMs } = build(
    { value: Date.parse(START) },
    [monthly("tx-1", expires), monthly("tx-1", renewed)],
  );
  const state = await engine.recordPurchase("u1", monthly("tx-1", expires));
  assert.equal(state.pro, true);
  assert.equal(state.source, "subscription");

  clockMs.value = Date.parse(START) + 31 * DAY;
  assert.equal((await engine.entitlement("u1")).pro, false);

  // Store renews; the webhook re-activates with the extended expiry.
  clockMs.value = Date.parse(START) + 31 * DAY;
  const after = await engine.applyWebhook({
    type: "renewal",
    userId: "u1",
    purchase: monthly("tx-1", renewed),
  });
  assert.equal(after?.pro, true);
  clockMs.value = Date.parse(START) + 59 * DAY;
  assert.equal((await engine.entitlement("u1")).pro, true);
});

test("lifetime purchases never expire; refunds revoke immediately", async () => {
  const life: PurchaseReceipt = {
    store: "apple",
    transactionId: "tx-life",
    productId: "pro-lifetime",
    purchaseAt: START,
    expiresAt: null,
    isFamilyShared: false,
  };
  const { engine, clockMs } = build({ value: Date.parse(START) }, [life]);
  const state = await engine.recordPurchase("u2", life);
  assert.equal(state.source, "lifetime");
  clockMs.value = Date.parse("2099-01-01T00:00:00.000Z");
  assert.equal((await engine.entitlement("u2")).pro, true);
  const after = await engine.applyWebhook({ type: "refund", userId: "u2", purchase: life });
  assert.equal(after?.pro, false);
  assert.equal((await engine.entitlement("u2")).pro, false);
});

test("restore on another device reactivates without repurchasing", async () => {
  const expires = new Date(Date.parse(START) + 365 * DAY).toISOString();
  const yearly: PurchaseReceipt = {
    store: "apple",
    transactionId: "tx-new-device",
    productId: "pro-yearly",
    purchaseAt: START,
    expiresAt: expires,
    isFamilyShared: false,
  };
  const { engine } = build({ value: Date.parse(START) }, [yearly]);
  // Device A purchases under the account... then is lost.
  await engine.recordPurchase("u3", yearly);
  // A fresh install restores from the store: same transaction.
  const state = await engine.restore("u3");
  assert.equal(state.pro, true);
  assert.equal(state.source, "subscription");
});

test("apple family sharing extends Pro to family members only", async () => {
  const shared: PurchaseReceipt = {
    store: "apple",
    transactionId: "tx-family",
    productId: "pro-lifetime",
    purchaseAt: START,
    expiresAt: null,
    isFamilyShared: true,
  };
  const { engine } = build({ value: Date.parse(START) }, [shared], ["u4", "kid-1"]);
  await engine.recordPurchase("parent-1", shared);
  const member = await engine.entitlementForAnyone("kid-1");
  assert.equal(member.pro, true);
  assert.equal(member.source, "family");
  const stranger = await engine.entitlementForAnyone("nobody");
  assert.equal(stranger.pro, false);
});

test("google family-shared purchases are refused until T125", async () => {
  const { engine } = build({ value: Date.parse(START) }, []);
  await assert.rejects(
    engine.recordPurchase("u5", {
      store: "google",
      transactionId: "tx-g",
      productId: "pro-yearly",
      purchaseAt: START,
      expiresAt: "2027-01-01T00:00:00.000Z",
      isFamilyShared: true,
    }),
    BillingError,
  );
  await assert.rejects(
    engine.recordPurchase("u5", {
      store: "apple",
      transactionId: "tx-x",
      productId: "not-in-catalog",
      purchaseAt: START,
      expiresAt: null,
      isFamilyShared: false,
    }),
    /unknown product/,
  );
});

test("the billing engine plugs into the entitlements ReceiptPort", async () => {
  const life: PurchaseReceipt = {
    store: "apple",
    transactionId: "tx-port",
    productId: "pro-lifetime",
    purchaseAt: START,
    expiresAt: null,
    isFamilyShared: false,
  };
  const { engine } = build({ value: Date.parse(START) }, [life]);
  await engine.recordPurchase("u6", life);
  const ent = createEntitlements({
    mode: "release",
    store: memoryEntitlementStore(),
    clock: () => new Date(Date.parse(START)),
    receipts: receiptPortFor(engine, () => "u6"),
  });
  await ent.record();
  await ent.verifyPro();
  assert.equal(await ent.isPro(), true);
});
