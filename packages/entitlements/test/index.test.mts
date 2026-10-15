import assert from "node:assert/strict";
import test from "node:test";
import {
  EntitlementRequiredError,
  createEntitlements,
  memoryEntitlementStore,
} from "../src/index.ts";

const ANCHOR = Date.parse("2026-01-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

async function fixture(opts: { pro?: boolean } = {}) {
  let current = ANCHOR;
  const store = memoryEntitlementStore();
  const receipts = {
    verify: async () => ({ pro: opts.pro ?? false }),
  };
  const ent = createEntitlements({
    mode: "release",
    store,
    clock: () => new Date(current),
    receipts,
  });
  await ent.record(); // anchors firstRunAt at app start, not at first query
  const advance = (days: number) => {
    current += days * DAY;
  };
  return { ent, store, advance };
}

test("the group preview allows two participants for seven days", async () => {
  const { ent, advance } = await fixture();
  const early = await ent.groupPreview();
  assert.equal(early.kind, "preview");
  assert.equal(early.cap, 2);
  assert.ok(await ent.canStartGroup(2));
  assert.ok(!(await ent.canStartGroup(3)));
  // isPro is false during the preview: the preview is not a Pro discount.
  assert.ok(!(await ent.isPro("groupChat")));
  advance(6);
  const sixDays = await ent.groupPreview();
  assert.equal(sixDays.kind, "preview");
  assert.equal(sixDays.kind === "preview" ? sixDays.daysLeft : -1, 1);
  advance(2); // day 8: preview over
  const ended = await ent.groupPreview();
  assert.equal(ended.kind, "ended");
  assert.ok(!(await ent.canStartGroup(2)));
  assert.equal(await ent.participantCap(), 0);
});

test("a verified purchase restores group use at the Pro cap of five", async () => {
  const pro = await fixture({ pro: true });
  pro.advance(9); // preview already ended
  assert.equal((await pro.ent.groupPreview()).kind, "ended");
  assert.ok(await pro.ent.verifyPro());
  const state = await pro.ent.groupPreview();
  assert.equal(state.kind, "pro");
  assert.equal(state.cap, 5);
  assert.ok(await pro.ent.canStartGroup(5));
  assert.ok(!(await pro.ent.canStartGroup(6)));
});

test("offline grace keeps a verified purchase usable, then expires", async () => {
  const { ent, advance } = await fixture({ pro: true });
  assert.ok(await ent.verifyPro());
  advance(29);
  assert.ok(await ent.isPro("appLock"));
  advance(3); // 32 days since verification
  assert.ok(!(await ent.isPro("appLock")));
  assert.ok(await ent.verifyPro()); // back online: re-verify
  assert.ok(await ent.isPro("appLock"));
});

test("existing App Lock users are grandfathered exactly once", async () => {
  const { ent, store } = await fixture();
  assert.ok(!(await ent.lockAllowed())); // Pro-only for new devices
  await ent.grandfatherLockIfPresent(false);
  assert.ok(!(await ent.lockAllowed()));
  await ent.grandfatherLockIfPresent(true);
  assert.ok(await ent.lockAllowed());
  const record = await store.load();
  assert.notEqual(record?.grandfatheredLockAt, null);
  // Re-running the policy hook never clears or moves the mark.
  await ent.grandfatherLockIfPresent(true);
  assert.deepEqual((await store.load())?.grandfatheredLockAt, record?.grandfatheredLockAt);
});

test("dev builds run all-enabled with no receipts at all", async () => {
  let current = ANCHOR + 365 * DAY; // far past every window
  const ent = createEntitlements({
    mode: "dev",
    store: memoryEntitlementStore(),
    clock: () => new Date(current),
  });
  assert.ok(await ent.isPro("arenaCustomPrompts"));
  assert.equal(await ent.participantCap(), 5);
  assert.ok(await ent.lockAllowed());
  await ent.require("cloudBackup"); // never throws in dev
});

test("pro-required endpoints reject directly, independent of UI state", async () => {
  const { ent } = await fixture();
  await assert.rejects(
    ent.require("cloudBackup"),
    (error: unknown) =>
      error instanceof EntitlementRequiredError &&
      error.feature === "cloudBackup",
  );
  const pro = await fixture({ pro: true });
  await pro.ent.verifyPro();
  await pro.ent.require("cloudBackup");
});

test("state survives restarts through the store", async () => {
  const { ent, store, advance } = await fixture({ pro: true });
  await ent.verifyPro();
  advance(5);
  const revived = createEntitlements({
    mode: "release",
    store,
    clock: () => new Date(ANCHOR + 5 * DAY),
    receipts: { verify: async () => ({ pro: true }) },
  });
  assert.ok(await revived.isPro("appLock")); // cached verification within grace
  const state = await revived.groupPreview();
  assert.equal(state.kind, "pro");
});
