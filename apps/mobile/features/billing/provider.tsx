import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
  const client = useMemo(
    () =>
      options.client ??
      (options.baseUrl === undefined
        ? null
        : createBillingClient({
            baseUrl: options.baseUrl,
            tokens: secureStoreTokenPort(),
          })),
    [options.client, options.baseUrl],
  );
  // Rebuilt in the render body, this factory produced a fresh client (and a
  // fresh token adapter) on every render: each refresh state update changed
  // the client identity, reran the refresh effect, and looped requests until
  // restart. The client is now owned here and rebuilt only for a real
  // configuration change (injected client or baseUrl).
  const activeClient = useRef(client);
  const [products, setProducts] = useState<ProductInfo[]>([]);
  const [entitlement, setEntitlement] = useState<EntitlementInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // A closure captured before a client switch must not fetch through the
    // abandoned client nor overwrite state from its responses.
    if (client === null || client !== activeClient.current) return;
    try {
      const [catalog, state] = await Promise.all([
        client.products(),
        client.entitlement().catch(() => null),
      ]);
      if (client !== activeClient.current) return;
      setProducts(catalog);
      if (state !== null) setEntitlement(state);
      setError(null);
    } catch {
      setError("billing service unreachable");
    }
  }, [client]);

  useEffect(() => {
    // Commit the new client as active before refreshing it; refreshes still
    // in flight on the previous client are dropped by the identity check.
    activeClient.current = client;
    void refresh();
  }, [client, refresh]);

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
        const granted = await client.purchase(receipt);
        if (client === activeClient.current) setEntitlement(granted);
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
    try {
      const state = await client.restore();
      if (client === activeClient.current) setEntitlement(state);
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
              if (state !== null && client === activeClient.current)
                setEntitlement(state);
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
