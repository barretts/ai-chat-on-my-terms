/** Store purchases, restoration and family entitlement (AC-03/AC-04).
 * The engine is store-agnostic: native purchase verification arrives
 * through the `StoreVerifier` port (RevenueCat/Apple/Google adapters are
 * external release plumbing; fixtures back every check here). Prices and
 * SKUs are supplied by configuration — observed LM Mini prices are never
 * hardcoded as our own store products. */

export type ProductKind = "monthly" | "yearly" | "lifetime";
export type StoreKind = "apple" | "google";

/** Configuration-owned catalog entry; `priceLabel`/`storeSku` come from
 * release config, not from anything observed in other apps. */
export interface ProductConfig {
  id: string;
  kind: ProductKind;
  title: string;
  priceLabel: string;
  storeSku: string;
}

export interface PurchaseReceipt {
  store: StoreKind;
  transactionId: string;
  productId: string;
  purchaseAt: string;
  /** null for lifetime. */
  expiresAt: string | null;
  isFamilyShared: boolean;
}

export interface VerifiedPurchase extends PurchaseReceipt {
  verifiedAt: string;
}

export interface WebhookEvent {
  type: "initial-purchase" | "renewal" | "expiration" | "refund" | "restore";
  userId: string;
  purchase: PurchaseReceipt;
}

/** Adapter seam: RevenueCat (or a fixture in tests) verifies the store
 * receipt and enumerates restorable purchases. */
export interface StoreVerifier {
  verify(receipt: PurchaseReceipt): Promise<VerifiedPurchase>;
  restorePurchases(userId: string): Promise<VerifiedPurchase[]>;
}

/** Apple Family Sharing lookup (fixture-backed; live Family Sharing is
 * T159E, Google is T125). */
export interface FamilyPort {
  membersOf(userId: string): Promise<string[]>;
}

export interface PurchaseStore {
  save(userId: string, purchases: readonly VerifiedPurchase[]): Promise<void>;
  load(userId: string): Promise<VerifiedPurchase[]>;
  /** All user ids that hold purchase records (webhook lookups). */
  holderIds(): Promise<string[]>;
}

export function memoryPurchaseStore(): PurchaseStore {
  const byUser = new Map<string, VerifiedPurchase[]>();
  return {
    async save(userId, purchases) {
      byUser.set(userId, purchases.map((item) => ({ ...item })));
    },
    async load(userId) {
      const found = byUser.get(userId) ?? [];
      return found.map((item) => ({ ...item }));
    },
    async holderIds() {
      return [...byUser.keys()];
    },
  };
}

export interface EntitlementState {
  pro: boolean;
  source: "lifetime" | "subscription" | "family" | "none";
  expiresAt: string | null;
}

export interface BillingOptions {
  clock: () => Date;
  purchases: PurchaseStore;
  verifier: StoreVerifier;
  family?: FamilyPort;
  products: readonly ProductConfig[];
}

export interface BillingEngine {
  products(): readonly ProductConfig[];
  recordPurchase(userId: string, receipt: PurchaseReceipt): Promise<EntitlementState>;
  restore(userId: string): Promise<EntitlementState>;
  applyWebhook(event: WebhookEvent): Promise<EntitlementState | null>;
  entitlement(userId: string): Promise<EntitlementState>;
  /** Family members served by this holder's Apple family-shared purchase. */
  entitlementForAnyone(userId: string): Promise<EntitlementState>;
}

const NO_ENTITLEMENT: EntitlementState = {
  pro: false,
  source: "none",
  expiresAt: null,
};

function isActive(purchase: VerifiedPurchase, nowMs: number): boolean {
  if (purchase.expiresAt === null) return true;
  return Date.parse(purchase.expiresAt) > nowMs;
}

export function createBillingEngine(options: BillingOptions): BillingEngine {
  const now = () => options.clock().getTime();
  const catalogIds = new Set(options.products.map((item) => item.id));

  async function reconcile(
    userId: string,
    incoming: readonly VerifiedPurchase[],
    mergeExisting: boolean,
  ): Promise<EntitlementState> {
    const existing = mergeExisting ? await options.purchases.load(userId) : [];
    const byTransaction = new Map<string, VerifiedPurchase>();
    for (const purchase of [...existing, ...incoming]) {
      const previous = byTransaction.get(purchase.transactionId);
      // Webhooks replace; the newest record for a transaction wins.
      if (previous !== undefined && Date.parse(previous.verifiedAt) > Date.parse(purchase.verifiedAt))
        continue;
      byTransaction.set(purchase.transactionId, purchase);
    }
    const live = [...byTransaction.values()].filter((purchase) =>
      isActive(purchase, now()),
    );
    await options.purchases.save(userId, live);
    return summarize(live, options, userId, now());
  }

  return {
    products: () => options.products,

    async recordPurchase(userId, receipt) {
      if (!catalogIds.has(receipt.productId))
        throw new BillingError(`unknown product: ${receipt.productId}`);
      if (receipt.store !== "apple" && receipt.store !== "google")
        throw new BillingError("unknown store");
      if (receipt.isFamilyShared && receipt.store !== "apple") {
        // Family Sharing is Apple-only until T125 (Google family).
        throw new BillingError("family-shared purchases are apple-only");
      }
      const verified = await options.verifier.verify(receipt);
      return reconcile(userId, [verified], true);
    },

    /** Cross-device restoration: the same store transactions re-verified
     * on another device reactivate the entitlement without a repurchase. */
    async restore(userId) {
      const found = await options.verifier.restorePurchases(userId);
      return reconcile(userId, found, false);
    },

    async applyWebhook(event) {
      if (event.type === "refund" || event.type === "expiration") {
        const existing = await options.purchases.load(event.userId);
        const kept = existing.filter(
          (item) => item.transactionId !== event.purchase.transactionId,
        );
        await options.purchases.save(event.userId, kept);
        return summarize(kept, options, event.userId, now());
      }
      const verified = await options.verifier.verify(event.purchase);
      return reconcile(event.userId, [verified], true);
    },

    async entitlement(userId) {
      const held = await options.purchases.load(userId);
      return summarize(held.filter((item) => isActive(item, now())), options, userId, now());
    },

    async entitlementForAnyone(userId) {
      const own = await this.entitlement(userId);
      if (own.pro) return own;
      if (options.family === undefined) return { ...NO_ENTITLEMENT };
      for (const holderId of await options.purchases.holderIds()) {
        const held = await options.purchases.load(holderId);
        const shared = held.filter(
          (item) =>
            item.isFamilyShared &&
            item.store === "apple" &&
            isActive(item, now()),
        );
        if (shared.length === 0) continue;
        const members = await options.family.membersOf(holderId);
        if (members.includes(userId)) {
          const expires = shared.map((item) => item.expiresAt);
          return {
            pro: true,
            source: "family",
            expiresAt: latestExpiry(expires),
          };
        }
      }
      return { ...NO_ENTITLEMENT };
    },
  };
}

function latestExpiry(values: (string | null)[]): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (value === null) return null;
    if (best === null || Date.parse(value) > Date.parse(best)) best = value;
  }
  return best;
}

function summarize(
  live: readonly VerifiedPurchase[],
  options: BillingOptions,
  _userId: string,
  _nowMs: number,
): EntitlementState {
  const active = live.filter((item) => isActive(item, nowOf(options)));
  if (active.length === 0) return { ...NO_ENTITLEMENT };
  if (active.some((item) => item.expiresAt === null))
    return { pro: true, source: "lifetime", expiresAt: null };
  const subs = active.filter((item) => item.expiresAt !== null);
  return {
    pro: true,
    source: "subscription",
    expiresAt: latestExpiry(subs.map((item) => item.expiresAt)),
  };
}

function nowOf(options: BillingOptions): number {
  return options.clock().getTime();
}

export class BillingError extends Error {
  name = "BillingError";
}

/** ReceiptPort adapter for the entitlements core (T107): Pro state comes
 * from reconciled store purchases, so `verifyPro()` is store truth. */
export function receiptPortFor(
  engine: BillingEngine,
  userId: () => string | null,
): {
  verify(): Promise<{ pro: boolean; plan: string | null; expiresAt: string | null }>;
} {
  return {
    async verify() {
      const id = userId();
      if (id === null) return { pro: false, plan: null, expiresAt: null };
      const state = await engine.entitlementForAnyone(id);
      return {
        pro: state.pro,
        plan: state.source === "none" ? null : state.source,
        expiresAt: state.expiresAt,
      };
    },
  };
}
