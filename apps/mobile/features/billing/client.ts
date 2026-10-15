/** Device side of store purchases (AC-03/AC-04). Native purchase is a
 * port: the Apple/Google (RevenueCat) adapter is external release
 * plumbing; fixtures back the flow here. Prices always come from the
 * configured catalog the service serves — never hardcoded locally. */

import type { SecureTokenPort } from "../account/client.ts";

export interface ProductInfo {
  id: string;
  kind: "monthly" | "yearly" | "lifetime";
  title: string;
  priceLabel: string;
  storeSku: string;
}

export interface PurchaseReceipt {
  store: "apple" | "google";
  transactionId: string;
  productId: string;
  purchaseAt: string;
  expiresAt: string | null;
  isFamilyShared: boolean;
}

export interface EntitlementInfo {
  pro: boolean;
  source: "lifetime" | "subscription" | "family" | "none";
  expiresAt: string | null;
}

/** Native store adapter (RevenueCat/StoreKit/Play Billing). Returns the
 * receipt to submit, or null when the user cancels. */
export interface NativePurchasePort {
  purchase(sku: string): Promise<PurchaseReceipt | null>;
}

export class BillingApiError extends Error {
  name = "BillingApiError";
  status: number;
  code: string | null;
  constructor(status: number, code: string | null) {
    super(`billing request failed: ${status}`);
    this.status = status;
    this.code = code;
  }
}

export interface CreateBillingClientOptions {
  baseUrl: string;
  tokens: SecureTokenPort;
  fetchImpl?: typeof fetch;
}

export interface BillingClient {
  products(): Promise<ProductInfo[]>;
  entitlement(): Promise<EntitlementInfo>;
  purchase(receipt: PurchaseReceipt): Promise<EntitlementInfo>;
  restore(): Promise<EntitlementInfo>;
}

export function createBillingClient(
  options: CreateBillingClientOptions,
): BillingClient {
  const doFetch = options.fetchImpl ?? fetch;

  async function call(
    path: string,
    init: { method: "GET" | "POST" } = { method: "GET" },
    body?: unknown,
  ): Promise<unknown> {
    const token = await options.tokens.get();
    const response = await doFetch(`${options.baseUrl}${path}`, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json().catch(() => null)) as
      | { code?: string }
      | null;
    if (!response.ok)
      throw new BillingApiError(
        response.status,
        typeof json?.code === "string" ? json.code : null,
      );
    return json;
  }

  return {
    async products() {
      const res = (await call("/billing/products")) as {
        products: ProductInfo[];
      };
      return res.products;
    },
    async entitlement() {
      return (await call("/billing/entitlement")) as EntitlementInfo;
    },
    async purchase(receipt) {
      return (await call("/billing/purchase", { method: "POST" }, { receipt })) as EntitlementInfo;
    },
    async restore() {
      return (await call("/billing/restore", { method: "POST" })) as EntitlementInfo;
    },
  };
}
