import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import {
  GRACE_MILLISECONDS,
  GRACE_PERIODS,
  createLockSession,
  shouldChallengeOnForeground,
  validatePin,
  type HashPort,
  type LockRecord,
  type LockRecordStore,
} from "../src/index.ts";

const shaHashPort: HashPort = {
  algorithm: "sha256-salt-v1",
  async hash(salt, pin) {
    return createHash("sha256").update(`${salt}:${pin}`).digest("hex");
  },
  randomSalt() {
    return randomBytes(16).toString("hex");
  },
};

function memoryRecords(initial: LockRecord | null = null): LockRecordStore {
  let record = initial;
  return {
    async load() {
      return record;
    },
    async save(next) {
      record = next;
    },
    async clear() {
      record = null;
    },
  };
}

function session(options: { pro?: boolean; recovery?: boolean } = {}) {
  const records = memoryRecords();
  const s = createLockSession({
    hash: shaHashPort,
    records,
    entitlements: { async isPro() { return options.pro ?? true; } },
    recovery: options.recovery
      ? { async verifyToken(token) { return token === "signed-token"; } }
      : null,
  });
  return { s, records };
}

test("only exact 4 or 6 digit PINs validate", () => {
  assert.equal(validatePin("1234").ok, true);
  assert.equal(validatePin("123456").ok, true);
  assert.equal(validatePin("12345").ok, false);
  assert.equal(validatePin("123").ok, false);
  assert.equal(validatePin("1234567").ok, false);
  assert.equal(validatePin("12a4").ok, false);
  assert.equal(validatePin("").ok, false);
});

test("grace option set matches the product matrix", () => {
  assert.deepEqual([...GRACE_PERIODS], [
    "immediate",
    "fifteenSeconds",
    "oneMinute",
    "fiveMinutes",
    "fifteenMinutes",
    "oneHour",
  ]);
  assert.equal(GRACE_MILLISECONDS.oneHour, 3_600_000);
});

test("cold start always challenges when a PIN exists; grace covers only foregrounding", async () => {
  const { s } = session();
  await s.setPin("4321");
  await s.coldStart();
  assert.deepEqual(s.status(), { locked: true, reason: "cold-start" });
  await s.unlockWithPin("4321");
  s.backgrounded(1000);
  s.foregrounded(1001);
  assert.equal(s.status().locked, false);
  assert.equal(shouldChallengeOnForeground("oneMinute", 0, 59_999), false);
  assert.equal(shouldChallengeOnForeground("oneMinute", 0, 60_001), true);
  s.setGrace("immediate");
  s.backgrounded(0);
  s.foregrounded(1);
  assert.equal(s.status().locked, true);
});

test("correct PIN unlocks and a wrong PIN keeps the gate closed", async () => {
  const { s } = session();
  await s.setPin("123456");
  await s.coldStart();
  const wrong = await s.unlockWithPin("654321");
  assert.equal(wrong.ok, false);
  assert.equal(s.status().locked, true);
  const right = await s.unlockWithPin("123456");
  assert.equal(right.ok, true);
  assert.equal(s.status().locked, false);
});

test("successful biometric stays unlocked; cancel keeps it locked", async () => {
  const { s } = session();
  await s.setPin("1234");
  await s.coldStart();
  s.biometricPort({
    async isAvailable() { return true; },
    async authenticate() { return "success"; },
  });
  assert.equal((await s.unlockWithBiometric()).ok, true);
  assert.equal(s.status().locked, false);
  s.backgrounded(0);
  s.setGrace("immediate");
  s.foregrounded(1);
  assert.equal(s.status().locked, true);
  s.biometricPort({
    async isAvailable() { return true; },
    async authenticate() { return "cancelled"; },
  });
  const cancelled = await s.unlockWithBiometric();
  assert.equal(cancelled.ok, false);
  assert.equal(s.status().locked, true);
  assert.equal(s.status().reason, "biometric-cancelled");
});

test("disabling App Lock requires current PIN proof", async () => {
  const { s } = session();
  await s.setPin("1234");
  const denied = await s.disableWithPin("9999");
  assert.equal(denied.ok, false);
  assert.match(denied.reason!, /current PIN proof required/);
  assert.equal(await s.hasLock(), true);
  assert.equal((await s.disableWithPin("1234")).ok, true);
  assert.equal(await s.hasLock(), false);
});

test("the gate survives an entitlement lapse and new enables need Pro", async () => {
  const records = memoryRecords();
  let pro = true;
  const s = createLockSession({
    hash: shaHashPort,
    records,
    entitlements: { async isPro() { return pro; } },
  });
  assert.equal((await s.setPin("1234")).ok, true);
  pro = false;
  await s.coldStart();
  assert.equal(s.status().locked, true);
  assert.equal((await s.unlockWithPin("1234")).ok, true);
  const fresh = session({ pro: false });
  const denied = await fresh.s.setPin("1234");
  assert.equal(denied.ok, false);
  assert.equal(await fresh.records.load(), null);
});

test("recovery needs an authenticated token; no port means no bypass", async () => {
  const { s } = session({ recovery: false });
  await s.setPin("1234");
  assert.equal((await s.disableWithRecoveryToken("guessed")).ok, false);
  assert.equal(await s.hasLock(), true);
  const withRecovery = session({ recovery: true });
  await withRecovery.s.setPin("1234");
  assert.equal((await withRecovery.s.disableWithRecoveryToken("guessed")).ok, false);
  assert.equal((await withRecovery.s.disableWithRecoveryToken("signed-token")).ok, true);
  assert.equal(await withRecovery.records.load(), null);
});

test("salted digests make the same PIN hash differently per record", async () => {
  const a = memoryRecords();
  const b = memoryRecords();
  await createLockSession({ hash: shaHashPort, records: a }).setPin("1234");
  await createLockSession({ hash: shaHashPort, records: b }).setPin("1234");
  const first = await a.load();
  const second = await b.load();
  assert.notEqual(first!.salt, second!.salt);
  assert.notEqual(first!.hash, second!.hash);
  const unlockA = createLockSession({ hash: shaHashPort, records: a });
  assert.equal((await unlockA.unlockWithPin("1234")).ok, true);
});

test("changing the PIN requires proof of the current one", async () => {
  const { s } = session();
  await s.setPin("1234");
  assert.equal((await s.changePin("0000", "5678")).ok, false);
  assert.equal((await s.changePin("1234", "567890")).ok, true);
  assert.equal((await s.unlockWithPin("567890")).ok, true);
  assert.equal((await s.unlockWithPin("1234")).ok, false);
});
