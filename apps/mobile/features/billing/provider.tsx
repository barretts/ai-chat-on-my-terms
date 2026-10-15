import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createBillingClient } from "./client";
import type {
  BillingClient,
  EntitlementInfo,
  NativePurchasePort,
  ProductInfo,
  PurchaseReceipt,
} from "./client";
import { secureStoreTokenPort } from "../account/adapters";
import type { EntitlementPort } from "@locallab/app-lock";

export interface BillingValue {
  available: boolean;
  products: ProductInfo[];
  entitlement: EntitlementInfo | null;
  busy: boolean;
  error: string | null;
  canPurchase: boolean;
  refresh(): Promise<void>;
  purchase(productId: string): Promise<void>;
  restore(): Promise<void>;
  /** Port for consumers that gate features on Pro (e.g. App Lock).
   * `null` means no billing service is configured: consumers must keep
   * their default-open/dev-free behavior rather than deny. */
  entitlementPort: EntitlementPort | null;
}

const BillingContext = createContext<BillingValue | null>(null);

export function BillingProvider(options: {
  baseUrl?: string;
  client?: BillingClient;
  nativePurchase?: NativePurchasePort;
  children: ReactNode;
}) {
  const client =
    options.client ??
    (options.baseUrl === undefined
      ? null
      : createBillingClient({
          baseUrl: options.baseUrl,
          tokens: secureStoreTokenPort(),
        }));
  const [products, setProducts] = useState<ProductInfo[]>([]);
  const [entitlement, setEntitlement] = useState<EntitlementInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (client === null) return;
    try {
      const [catalog, state] = await Promise.all([
        client.products(),
        client.entitlement().catch(() => null),
      ]);
      setProducts(catalog);
      if (state !== null) setEntitlement(state);
      setError(null);
    } catch {
      setError("billing service unreachable");
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const purchase = useCallback(
    async (productId: string) => {
      if (client === null) return;
      if (options.nativePurchase === undefined) {
        setError("store purchases need the native store adapter");
        return;
      }
      const product = products.find((item) => item.id === productId);
      if (product === undefined) {
        setError("unknown product");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const receipt = await options.nativePurchase.purchase(product.storeSku);
        if (receipt === null) return;
        setEntitlement(await client.purchase(receipt));
      } catch {
        setError("purchase failed");
      } finally {
        setBusy(false);
      }
    },
    [client, products],
  );

  const restore = useCallback(async () => {
    if (client === null) return;
    setBusy(true);
    setError(null);
    try {
      setEntitlement(await client.restore());
    } catch {
      setError("restore failed");
    } finally {
      setBusy(false);
    }
  }, [client]);

  const entitlementPort = useMemo(
    () =>
      client === null
        ? null
        : {
            async isPro() {
              const state = await client.entitlement().catch(() => null);
              if (state !== null) setEntitlement(state);
              return state !== null && state.pro;
            },
          },
    [client],
  );

  const value: BillingValue = {
    available: client !== null,
    products,
    entitlement,
    busy,
    error,
    canPurchase: options.nativePurchase !== undefined,
    refresh,
    purchase,
    restore,
    entitlementPort,
  };
  return (
    <BillingContext.Provider value={value}>
      {options.children}
    </BillingContext.Provider>
  );
}

export function useBilling(): BillingValue {
  const value = useContext(BillingContext);
  if (value === null)
    throw new Error("useBilling must be used inside BillingProvider");
  return value;
}
