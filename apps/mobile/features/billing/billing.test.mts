import { describe, expect, it } from "vitest";
import { createBillingClient, BillingApiError } from "./client";
import type { PurchaseReceipt, SecureTokenPort } from "../account/client";

const receipt: PurchaseReceipt = {
  store: "apple",
  transactionId: "tx-1",
  productId: "pro-yearly",
  purchaseAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2027-01-01T00:00:00.000Z",
  isFamilyShared: false,
};

function tokenDouble(initial: string | null): SecureTokenPort & { value: string | null } {
  return {
    value: initial,
    async get() {
      return this.value;
    },
    async set(token) {
      this.value = token;
    },
    async clear() {
      this.value = null;
    },
  };
}

function fetchDouble(
  handler: (path: string, init: RequestInit) => { status: number; body: unknown },
  log: { path: string; init: RequestInit }[],
) {
  return (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    log.push({ path, init });
    const res = handler(path, init);
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }) satisfies typeof fetch;
}

describe("billing client", () => {
  it("serves the configured catalog without any local prices", async () => {
    const log: { path: string; init: RequestInit }[] = [];
    const client = createBillingClient({
      baseUrl: "https://svc.test",
      tokens: tokenDouble(null),
      fetchImpl: fetchDouble(() => ({
        status: 200,
        body: {
          products: [
            {
              id: "pro-yearly",
              kind: "yearly",
              title: "Pro Yearly",
              priceLabel: "$9.99/yr",
              storeSku: "ll_pro_yearly",
            },
          ],
        },
      }), log),
    });
    const products = await client.products();
    expect(products[0]?.priceLabel).toBe("$9.99/yr");
    expect(log[0]?.path).toBe("/billing/products");
    expect(log[0]?.init.headers).not.toHaveProperty("authorization");
  });

  it("sends the account bearer token and surfaces entitlements", async () => {
    const log: { path: string; init: RequestInit }[] = [];
    const client = createBillingClient({
      baseUrl: "https://svc.test",
      tokens: tokenDouble("session-abc"),
      fetchImpl: fetchDouble(() => ({
        status: 200,
        body: { pro: true, source: "family", expiresAt: null },
      }), log),
    });
    const state = await client.entitlement();
    expect(state).toEqual({ pro: true, source: "family", expiresAt: null });
    const headers = log[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer session-abc");
  });

  it("submits the native receipt after a purchase", async () => {
    const log: { path: string; init: RequestInit }[] = [];
    const client = createBillingClient({
      baseUrl: "https://svc.test",
      tokens: tokenDouble("t"),
      fetchImpl: fetchDouble((path) => {
        if (path === "/billing/purchase")
          return { status: 200, body: { pro: true, source: "subscription", expiresAt: "2027-01-01T00:00:00.000Z" } };
        return { status: 404, body: { code: "nope" } };
      }, log),
    });
    const state = await client.purchase(receipt);
    expect(state.pro).toBe(true);
    const body = JSON.parse(log[0]?.init.body as string);
    expect(body.receipt.transactionId).toBe("tx-1");
  });

  it("restore reactivates an existing subscription", async () => {
    const client = createBillingClient({
      baseUrl: "https://svc.test",
      tokens: tokenDouble("t"),
      fetchImpl: fetchDouble(() => ({
        status: 200,
        body: { pro: true, source: "subscription", expiresAt: "2027-01-01T00:00:00.000Z" },
      }), []),
    });
    const state = await client.restore();
    expect(state.pro).toBe(true);
  });

  it("refusals carry the api code", async () => {
    const client = createBillingClient({
      baseUrl: "https://svc.test",
      tokens: tokenDouble(null),
      fetchImpl: fetchDouble(() => ({
        status: 401,
        body: { code: "no-session" },
      }), []),
    });
    await expect(client.entitlement()).rejects.toThrow(BillingApiError);
    await expect(client.entitlement()).rejects.toMatchObject({
      status: 401,
      code: "no-session",
    });
  });
});
