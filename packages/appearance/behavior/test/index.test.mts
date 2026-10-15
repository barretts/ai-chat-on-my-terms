import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_APPEARANCE_BEHAVIOR,
  createDeferringSendPort,
  effectiveEffects,
  lowBatteryActive,
  parseBehaviorImport,
  plainStreamEnabled,
  type AppearanceBehaviorV1,
  type BatterySnapshot,
} from "../src/index.ts";

function behavior(overrides: Partial<AppearanceBehaviorV1> = {}): AppearanceBehaviorV1 {
  return { ...DEFAULT_APPEARANCE_BEHAVIOR, ...overrides };
}

test("full battery profile keeps glass and styled streaming", () => {
  const battery: BatterySnapshot = { level: 0.85, charging: false };
  const b = behavior();
  assert.equal(lowBatteryActive(b, battery), false);
  assert.equal(effectiveEffects(b, battery), "glass");
  assert.equal(plainStreamEnabled(b, battery), false);
});

test("auto low-battery profile engages only unplugged and at or below 20%", () => {
  const b = behavior({ lowBatteryMode: "auto" });
  assert.equal(lowBatteryActive(b, { level: 0.2, charging: false }), true);
  assert.equal(lowBatteryActive(b, { level: 0.21, charging: false }), false);
  assert.equal(lowBatteryActive(b, { level: 0.05, charging: true }), false);
  assert.equal(lowBatteryActive(b, null), false);
});

test("low-battery mode reduces effects even with glass on and switches to plain stream", () => {
  const b = behavior({ glassEnabled: true, lowBatteryMode: "on" });
  assert.equal(effectiveEffects(b, { level: 0.9, charging: true }), "reduced");
  assert.equal(plainStreamEnabled(b, { level: 0.9, charging: true }), true);
  assert.equal(
    effectiveEffects(behavior({ glassEnabled: false, lowBatteryMode: "off" }), null),
    "plain",
  );
});

test("strict import rejects unknown keys, wrong types, and out-of-range modes", () => {
  const good = {
    version: 1,
    glassEnabled: false,
    lowBatteryMode: "auto",
    fullWidthReplies: true,
  };
  assert.equal(parseBehaviorImport(good).ok, true);
  const badVersion = parseBehaviorImport({ ...good, version: 0 });
  assert.equal(badVersion.ok, false);
  if (!badVersion.ok) assert.match(badVersion.reason, /version/);
  const unknownKey = parseBehaviorImport({ ...good, radio: "bluetooth" });
  assert.equal(unknownKey.ok, false);
  if (!unknownKey.ok) assert.match(unknownKey.reason, /radio/);
  assert.equal(parseBehaviorImport({ ...good, glassEnabled: "yes" }).ok, false);
});

test("deferred sync buffers sends while deferred and flushes them in order on resume", async () => {
  const sent: string[] = [];
  const port = createDeferringSendPort({
    async send(payload, requestId) {
      sent.push(`${requestId}:${String(payload)}`);
    },
  });
  await port.send("live-1", "r1");
  port.defer();
  await port.send("queued-a", "r2");
  await port.send("queued-b", "r3");
  assert.equal(port.pendingCount(), 2);
  assert.deepEqual(sent, ["r1:live-1"]);
  await port.resume();
  assert.equal(port.pendingCount(), 0);
  assert.equal(port.deferred, false);
  assert.deepEqual(sent, ["r1:live-1", "r2:queued-a", "r3:queued-b"]);
  await port.send("after", "r4");
  assert.deepEqual(sent.at(-1), "r4:after");
});

test("resume during a flush does not double-send and deferral re-arms", async () => {
  const sent: string[] = [];
  const releases: (() => void)[] = [];
  const port = createDeferringSendPort({
    async send(payload, requestId) {
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      sent.push(requestId);
    },
  });
  port.defer();
  await port.send("x", "r1");
  const flush = port.resume();
  void port.send("y", "r2");
  port.defer();
  await port.send("z", "r3");
  while (releases.length < 2)
    await new Promise((resolve) => setTimeout(resolve, 1));
  for (const release of releases) release();
  await flush;
  assert.deepEqual(sent, ["r1", "r2"]);
  assert.equal(port.pendingCount(), 1);
});
