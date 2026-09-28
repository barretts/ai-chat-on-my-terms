import type { Capability, CapabilityMap } from "@locallab/contracts/ports";
import { CapabilitySchema } from "@locallab/contracts/entities";
import { z } from "zod";

export type FeatureEntitlement = "included" | "requires-pro" | "unavailable";
export type CapabilitySource = "provider" | "catalog" | "override" | "unknown";

export interface CapabilityDecision {
  value: Capability;
  source: CapabilitySource;
  entitled: boolean;
  visible: boolean;
  enabled: boolean;
  explanation?: string;
}

export type CapabilityOverrides = Readonly<Record<string, Capability>>;
export type EntitlementMap = Readonly<Record<string, FeatureEntitlement>>;

export const CapabilityOverridesSchema = z.record(z.string(), CapabilitySchema);
export function parseCapabilityOverrides(value: unknown): CapabilityOverrides {
  return CapabilityOverridesSchema.parse(value);
}

/** Resolve facts without treating missing information as support. Explicit user overrides win. */
export function resolveCapabilities(input: {
  provider?: CapabilityMap;
  catalog?: CapabilityMap;
  overrides?: CapabilityOverrides;
  entitlements?: EntitlementMap;
}): Readonly<Record<string, CapabilityDecision>> {
  const keys = new Set([
    ...Object.keys(input.provider ?? {}),
    ...Object.keys(input.catalog ?? {}),
    ...Object.keys(input.overrides ?? {}),
    ...Object.keys(input.entitlements ?? {}),
  ]);
  return Object.fromEntries(
    [...keys].sort().map((key) => {
      const override = input.overrides?.[key];
      const provider = input.provider?.[key];
      const catalog = input.catalog?.[key];
      const providerKnown = provider && provider !== "unknown";
      const value =
        override ?? (providerKnown ? provider : catalog) ?? "unknown";
      const source: CapabilitySource = override
        ? "override"
        : providerKnown
          ? "provider"
          : catalog
            ? "catalog"
            : "unknown";
      const entitlement = input.entitlements?.[key] ?? "included";
      const entitled = entitlement === "included";
      const visible = value !== "no" && entitlement !== "unavailable";
      const enabled = value === "yes" && entitled;
      const explanation = !entitled
        ? entitlement === "requires-pro"
          ? "Requires Pro"
          : "Unavailable for this account"
        : value === "no"
          ? "This model does not support this feature"
          : value === "unknown"
            ? "Support has not been confirmed for this model"
            : undefined;
      return [
        key,
        {
          value,
          source,
          entitled,
          visible,
          enabled,
          ...(explanation ? { explanation } : {}),
        },
      ];
    }),
  );
}

/** Tool dispatch requires affirmative support; unknown capability is never enabled. */
export function canSendTools(
  capabilities: Readonly<Record<string, CapabilityDecision>>,
): boolean {
  return capabilities.tools?.enabled === true;
}

/** Connection-scoped banners are discarded on identity changes. */
export class CapabilityBannerState<T> {
  private currentConnection: string | undefined;
  private value: T | undefined;

  set(connectionId: string, value: T): void {
    this.currentConnection = connectionId;
    this.value = value;
  }

  get(connectionId: string): T | undefined {
    return this.currentConnection === connectionId ? this.value : undefined;
  }

  invalidate(connectionId: string): void {
    if (this.currentConnection !== connectionId) this.value = undefined;
    this.currentConnection = connectionId;
  }
}
