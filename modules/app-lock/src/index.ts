/** App Lock core: salted PIN verifier, grace/cold-start gate, biometric and
 * recovery ports. The verifier lives device-local only (the host stores it
 * in a device-secured store that no sync or backup path reads). */

export const LOCK_RECORD_VERSION = 1;

export interface LockRecord {
  version: 1;
  kind: "pin";
  algorithm: string;
  salt: string;
  hash: string;
  digits: 4 | 6;
}

export type PinResult =
  | { ok: true; digits: 4 | 6 }
  | { ok: false; reason: string };

/** PINs are exactly 4 or 6 decimal digits (DA-05). */
export function validatePin(pin: string): PinResult {
  if (/^\d{4}$/.test(pin)) return { ok: true, digits: 4 };
  if (/^\d{6}$/.test(pin)) return { ok: true, digits: 6 };
  return { ok: false, reason: "the PIN must be exactly 4 or 6 digits" };
}

/** Hash port: the mobile adapter is a salted digest of the PIN; tests use
 * node:crypto. `algorithm` labels the scheme stored alongside the record. */
export interface HashPort {
  readonly algorithm: string;
  hash(salt: string, pin: string): Promise<string>;
  randomSalt(): string;
}

export async function createLockRecord(
  pin: string,
  hash: HashPort,
): Promise<{ ok: true; record: LockRecord } | { ok: false; reason: string }> {
  const validated = validatePin(pin);
  if (!validated.ok) return { ok: false, reason: validated.reason };
  const salt = hash.randomSalt();
  const digest = await hash.hash(salt, pin);
  return {
    ok: true,
    record: {
      version: LOCK_RECORD_VERSION,
      kind: "pin",
      algorithm: hash.algorithm,
      salt,
      hash: digest,
      digits: validated.digits,
    },
  };
}

/** Constant-time-ish compare over equal-length digests; a wrong-length
 * digest (corrupt record) verifies false without throwing. */
export async function verifyPin(
  pin: string,
  record: LockRecord,
  hash: HashPort,
): Promise<boolean> {
  if (record.algorithm !== hash.algorithm) return false;
  if (validatePin(pin).ok === false) return false;
  const digest = await hash.hash(record.salt, pin);
  if (digest.length !== record.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < digest.length; i += 1)
    diff |= digest.charCodeAt(i) ^ record.hash.charCodeAt(i);
  return diff === 0;
}

export type GracePeriod = "immediate" | "fifteenSeconds" | "oneMinute" | "fiveMinutes" | "fifteenMinutes" | "oneHour";

/** DA-06 option set, in UI order. */
export const GRACE_PERIODS: readonly GracePeriod[] = [
  "immediate",
  "fifteenSeconds",
  "oneMinute",
  "fiveMinutes",
  "fifteenMinutes",
  "oneHour",
];

export const GRACE_MILLISECONDS: Record<GracePeriod, number> = {
  immediate: 0,
  fifteenSeconds: 15_000,
  oneMinute: 60_000,
  fiveMinutes: 300_000,
  fifteenMinutes: 900_000,
  oneHour: 3_600_000,
};

/** A cold start always challenges (DA-09); returning to the foreground
 * challenges only once the configured grace has elapsed (DA-06). */
export function shouldChallengeOnForeground(
  grace: GracePeriod,
  backgroundAt: number,
  foregroundAt: number,
): boolean {
  return foregroundAt - backgroundAt > GRACE_MILLISECONDS[grace];
}

export interface LockPolicy {
  grace: GracePeriod;
}

export interface LockPreferences {
  version: 1;
  enabled: boolean;
  grace: GracePeriod;
}

export const DEFAULT_LOCK_PREFERENCES: LockPreferences = {
  version: 1,
  enabled: false,
  grace: "oneMinute",
};

export type BiometricOutcome = "success" | "cancelled" | "error";

export interface BiometricPort {
  isAvailable(): Promise<boolean>;
  authenticate(): Promise<BiometricOutcome>;
}

/** Account-assisted PIN recovery (DA-08/UP-06). The host supplies an
 * already-authenticated token; the core never sees credentials. */
export interface RecoveryPort {
  verifyToken(token: string): Promise<boolean>;
}

export interface EntitlementPort {
  isPro(): Promise<boolean>;
}

/** Device-only storage; the host maps this to a store (SecureStore) that
 * sync and backup paths never read. */
export interface LockRecordStore {
  load(): Promise<LockRecord | null>;
  save(record: LockRecord): Promise<void>;
  clear(): Promise<void>;
}

export interface LockHost {
  hash: HashPort;
  records: LockRecordStore;
  entitlements?: EntitlementPort;
  recovery?: RecoveryPort | null;
}

export interface LockSession {
  status(): { locked: boolean; reason: string | null };
  coldStart(): Promise<void>;
  backgrounded(now: number): void;
  foregrounded(now: number): void;
  unlockWithPin(pin: string): Promise<{ ok: boolean; reason?: string }>;
  unlockWithBiometric(): Promise<{ ok: boolean; reason?: string }>;
  biometricPort(port: BiometricPort | null): void;
  setPin(pin: string): Promise<{ ok: boolean; reason?: string }>;
  changePin(current: string, next: string): Promise<{ ok: boolean; reason?: string }>;
  disableWithPin(current: string): Promise<{ ok: boolean; reason?: string }>;
  disableWithRecoveryToken(token: string): Promise<{ ok: boolean; reason?: string }>;
  setGrace(grace: GracePeriod): void;
  hasLock(): Promise<boolean>;
}

/** Full session state machine: the gate is active whenever a record exists,
 * regardless of entitlement state; only NEW enables consult entitlements. */
export function createLockSession(host: LockHost): LockSession {
  let locked = false;
  let reason: string | null = null;
  let backgroundAt: number | null = null;
  let grace: GracePeriod = DEFAULT_LOCK_PREFERENCES.grace;
  let biometric: BiometricPort | null = null;
  const isPro = async () =>
    host.entitlements ? await host.entitlements.isPro() : true;
  return {
    status() {
      return { locked, reason };
    },
    async coldStart() {
      if ((await host.records.load()) === null) return;
      locked = true;
      reason = "cold-start";
    },
    backgrounded(now) {
      backgroundAt = now;
    },
    foregrounded(now) {
      if (backgroundAt === null) return;
      if (shouldChallengeOnForeground(grace, backgroundAt, now)) {
        locked = true;
        reason = "grace-expiry";
      }
      backgroundAt = null;
    },
    async unlockWithPin(pin) {
      const record = await host.records.load();
      if (record === null) return { ok: true };
      if (!(await verifyPin(pin, record, host.hash)))
        return { ok: false, reason: "incorrect PIN" };
      locked = false;
      reason = null;
      return { ok: true };
    },
    async unlockWithBiometric() {
      const record = await host.records.load();
      if (record === null) return { ok: true };
      if (biometric === null)
        return { ok: false, reason: "biometric unlock is not available" };
      if (!(await biometric.isAvailable()))
        return { ok: false, reason: "biometrics are not enrolled on this device" };
      const outcome = await biometric.authenticate();
      if (outcome === "success") {
        locked = false;
        reason = null;
        return { ok: true };
      }
      locked = true;
      reason = outcome === "cancelled" ? "biometric-cancelled" : "biometric-error";
      return {
        ok: false,
        reason:
          outcome === "cancelled"
            ? "biometric prompt was cancelled"
            : "biometric authentication failed",
      };
    },
    biometricPort(port) {
      biometric = port;
    },
    async setPin(pin) {
      const existing = await host.records.load();
      if (existing === null && !(await isPro()))
        return {
          ok: false,
          reason: "App Lock is a Pro feature; enable Pro to turn it on",
        };
      const made = await createLockRecord(pin, host.hash);
      if (!made.ok) return made;
      await host.records.save(made.record);
      locked = false;
      reason = null;
      return { ok: true };
    },
    async changePin(current, next) {
      const record = await host.records.load();
      if (record === null) return { ok: false, reason: "no PIN is set" };
      if (!(await verifyPin(current, record, host.hash)))
        return { ok: false, reason: "current PIN proof required" };
      const made = await createLockRecord(next, host.hash);
      if (!made.ok) return made;
      await host.records.save(made.record);
      return { ok: true };
    },
    async disableWithPin(current) {
      const record = await host.records.load();
      if (record === null) return { ok: true };
      if (!(await verifyPin(current, record, host.hash)))
        return { ok: false, reason: "current PIN proof required to disable App Lock" };
      await host.records.clear();
      locked = false;
      reason = null;
      return { ok: true };
    },
    async disableWithRecoveryToken(token) {
      if (host.recovery === null || host.recovery === undefined)
        return { ok: false, reason: "no recovery method is configured" };
      if (!(await host.recovery.verifyToken(token)))
        return { ok: false, reason: "recovery token is not valid" };
      await host.records.clear();
      locked = false;
      reason = null;
      return { ok: true };
    },
    setGrace(next) {
      if (!GRACE_PERIODS.includes(next)) return;
      grace = next;
    },
    async hasLock() {
      return (await host.records.load()) !== null;
    },
  };
}
