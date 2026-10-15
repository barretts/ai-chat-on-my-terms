import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_ICON_NAMES,
  createAppIconController,
  type AppIconBridge,
} from "../src/index.ts";

function fakeBridge(options: {
  eligible?: boolean;
  current?: string | null;
  failSet?: boolean;
} = {}) {
  const calls: (string | null)[] = [];
  let current = options.current ?? null;
  const bridge: AppIconBridge = {
    canSetAlternateIcons: () => options.eligible ?? true,
    currentIconName: async () => current,
    async setAlternateIconName(name) {
      calls.push(name);
      if (options.failSet) throw new Error("system settings dialog refused");
      current = name;
    },
  };
  return { bridge, calls, getCurrent: () => current };
}

test("the shipped icon set is default, dark, and glass", () => {
  assert.deepEqual([...APP_ICON_NAMES], ["default", "dark", "glass"]);
});

test("selecting the default icon clears the alternate name", async () => {
  const { bridge, calls } = fakeBridge({ current: "dark" });
  const controller = createAppIconController(bridge);
  assert.equal(await controller.current(), "dark");
  const result = await controller.select("default");
  assert.deepEqual(result, { ok: true, icon: "default" });
  assert.deepEqual(calls, [null]);
});

test("selecting dark and glass sends the matching alternate icon names", async () => {
  const { bridge, calls, getCurrent } = fakeBridge();
  const controller = createAppIconController(bridge);
  assert.equal((await controller.select("dark")).ok, true);
  assert.equal((await controller.select("glass")).ok, true);
  assert.deepEqual(calls, ["dark", "glass"]);
  assert.equal(getCurrent(), "glass");
  assert.equal(await controller.current(), "glass");
});

test("ineligible devices are refused without calling the bridge setter", async () => {
  const { bridge, calls } = fakeBridge({ eligible: false });
  const controller = createAppIconController(bridge);
  const result = await controller.select("dark");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /cannot switch app icons/);
  assert.deepEqual(calls, []);
});

test("unknown icon names never reach the bridge and native refusals surface", async () => {
  const { bridge, calls } = fakeBridge({ failSet: true });
  const controller = createAppIconController(bridge);
  const bogus = await controller.select("halloween" as never);
  assert.equal(bogus.ok, false);
  if (!bogus.ok) assert.match(bogus.reason, /not a bundled icon/);
  assert.deepEqual(calls, []);
  const refused = await controller.select("dark");
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /refused/);
});

test("an unknown current name reported by the bridge reads as default", async () => {
  const { bridge } = fakeBridge({ current: "third-party" });
  const controller = createAppIconController(bridge);
  assert.equal(await controller.current(), "default");
});
