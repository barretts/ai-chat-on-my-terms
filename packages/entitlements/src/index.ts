/** Entitlement policy (AR-08, GR beta rules, DA gates): distinct dev and
 * release build modes, the free/pro feature matrix, the two-participant
 * seven-day group preview with a five-participant Pro limit, lock
 * grandfathering, and offline grace. Core local chat and LAN sync are
 * NEVER gated — that boundary is an invariant, not a setting. */

export type BuildMode = "dev" | "release";

/** The Pro matrix. Feature ids mirror the source inventory rows. */
export type ProFeature =
  | "appLock" // DA-01..DA-07
  | "cloudBackup" // DA-03
  | "groupChat" // GR beta: preview then Pro
  | "arenaCustomPrompts" // AR-08
  | "arenaCloudContestants" // AR-08
  | "arenaHistory" // AR-08
  | "remotePairing"; // RE: "Remote use is Pro"

/** Never a gate target: local chat, personas, LAN sync, models. */
export type CoreFeature = "localChat" | "personas" | "lanSync" | "models";

export const GROUP_PREVIEW_DAYS = 7;
export const GROUP_PREVIEW_PARTICIPANT_CAP = 2;
export const GROUP_PRO_PARTICIPANT_CAP = 5;
/** Not specified by the source inventory; chosen and documented (pending
 * product confirmation). */
export const OFFLINE_VERIFY_GRACE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EntitlementRecord {
  /** First run anchors the group preview window. */
  firstRunAt: string;
  pro: boolean;
  /** When a receipt last verified Pro; anchors offline grace. */
  proVerifiedAt: string | null;
  /** Set once for users who had App Lock enabled before it became a Pro
   * feature; their lock stays usable on this device (grandfather rule). */
  grandfatheredLockAt: string | null;
}

export interface EntitlementStore {
  load(): Promise<EntitlementRecord | null>;
  save(record: EntitlementRecord): Promise<void>;
}

/** Store-receipt verifier (App Store / Play; the purchase flow is T112). */
export interface ReceiptPort {
  verify(): Promise<{ pro: boolean }>;
}

export type GroupPreviewStatus =
  | { kind: "pro"; cap: number; endsAt: null }
  | { kind: "preview"; cap: number; endsAt: string; daysLeft: number }
  | { kind: "ended"; cap: 0; endsAt: string };

export interface Entitlements {
  mode(): BuildMode;
  isPro(feature?: ProFeature): Promise<boolean>;
  groupPreview(): Promise<GroupPreviewStatus>;
  participantCap(): Promise<number>;
  canStartGroup(participantCount: number): Promise<boolean>;
  lockAllowed(): Promise<boolean>;
  /** One-time policy-introduction hook: records the grandfather mark for
   * devices that already have a lock. */
  grandfatherLockIfPresent(lockPresent: boolean): Promise<void>;
  /** Verifies the store receipt and refreshes the offline-grace clock. */
  verifyPro(): Promise<boolean>;
  /** Throws when the feature is Pro and not currently entitled. */
  require(feature: ProFeature): Promise<void>;
  record(): Promise<EntitlementRecord>;
}

export class EntitlementRequiredError extends Error {
  name = "EntitlementRequiredError";
  constructor(readonly feature: ProFeature) {
    super(`feature "${feature}" requires a Pro entitlement`);
  }
}

export interface CreateEntitlementsOptions {
  mode: BuildMode;
  store: EntitlementStore;
  clock: () => Date;
  receipts?: ReceiptPort;
}

export function createEntitlements(
  options: CreateEntitlementsOptions,
): Entitlements {
  const now = () => options.clock().getTime();

  async function loadOrInit(): Promise<EntitlementRecord> {
    const found = await options.store.load();
    if (found !== null) return found;
    const fresh: EntitlementRecord = {
      firstRunAt: options.clock().toISOString(),
      pro: false,
      proVerifiedAt: null,
      grandfatheredLockAt: null,
    };
    await options.store.save(fresh);
    return fresh;
  }

  async function proActive(): Promise<boolean> {
    if (options.mode === "dev") return true;
    const record = await loadOrInit();
    if (!record.pro) return false;
    if (record.proVerifiedAt === null) return false;
    const age = now() - Date.parse(record.proVerifiedAt);
    return age <= OFFLINE_VERIFY_GRACE_DAYS * DAY_MS;
  }

  async function preview(): Promise<GroupPreviewStatus> {
    if (await proActive())
      return { kind: "pro", cap: GROUP_PRO_PARTICIPANT_CAP, endsAt: null };
    const record = await loadOrInit();
    const endsAt = Date.parse(record.firstRunAt) + GROUP_PREVIEW_DAYS * DAY_MS;
    if (now() < endsAt) {
      const daysLeft = Math.ceil((endsAt - now()) / DAY_MS);
      return {
        kind: "preview",
        cap: GROUP_PREVIEW_PARTICIPANT_CAP,
        endsAt: new Date(endsAt).toISOString(),
        daysLeft,
      };
    }
    return { kind: "ended", cap: 0, endsAt: new Date(endsAt).toISOString() };
  }

  const entitlements: Entitlements = {
    mode: () => options.mode,
    async isPro(feature) {
      // Every matrix entry consults the same release state; core features
      // are not gate targets (type system keeps callers honest).
      return feature === undefined ? await proActive() : await proActive();
    },
    groupPreview: preview,
    async participantCap() {
      return (await preview()).cap;
    },
    async canStartGroup(participantCount) {
      const state = await preview();
      if (state.kind === "ended") return false;
      return participantCount >= 2 && participantCount <= state.cap;
    },
    async lockAllowed() {
      if (options.mode === "dev") return true;
      const record = await loadOrInit();
      return record.grandfatheredLockAt !== null || (await proActive());
    },
    async grandfatherLockIfPresent(lockPresent) {
      if (!lockPresent) return;
      const record = await loadOrInit();
      if (record.grandfatheredLockAt !== null) return;
      await options.store.save({
        ...record,
        grandfatheredLockAt: options.clock().toISOString(),
      });
    },
    async verifyPro() {
      if (options.receipts === undefined)
        throw new Error("no receipt port is configured for Pro verification");
      if (options.mode === "dev") return true;
      const verified = await options.receipts.verify();
      const record = await loadOrInit();
      await options.store.save({
        ...record,
        pro: verified.pro,
        proVerifiedAt: verified.pro ? options.clock().toISOString() : null,
      });
      return verified.pro;
    },
    async require(feature) {
      if (!(await proActive())) throw new EntitlementRequiredError(feature);
    },
    record: loadOrInit,
  };
  return entitlements;
}

/** Convenience for service endpoints: maps a missing entitlement to a
 * rejection without trusting client-side UI state. */
export async function requireProForEndpoint(
  entitlements: Entitlements,
  feature: ProFeature,
): Promise<void> {
  await entitlements.require(feature);
}

export function memoryEntitlementStore(): EntitlementStore {
  let current: EntitlementRecord | null = null;
  return {
    async load() {
      return current === null ? null : { ...current };
    },
    async save(record) {
      current = { ...record };
    },
  };
}
