import assert from "node:assert/strict";
import test from "node:test";
import {
  CapabilityBannerState,
  canSendTools,
  parseCapabilityOverrides,
  resolveCapabilities,
} from "../src/index.js";

test("unknown tools stay disabled and unsupported controls are hidden", () => {
  const caps = resolveCapabilities({
    provider: { tools: "unknown", vision: "no" },
  });
  assert.equal(canSendTools(caps), false);
  assert.equal(caps.tools?.enabled, false);
  assert.equal(caps.vision?.visible, false);
});

test("user overrides are schema validated", () => {
  assert.deepEqual(parseCapabilityOverrides({ tools: "yes" }), {
    tools: "yes",
  });
  assert.throws(() => parseCapabilityOverrides({ tools: "maybe" }));
});

test("provider, catalog, and validated override precedence is explicit", () => {
  const caps = resolveCapabilities({
    provider: { tools: "unknown", vision: "yes" },
    catalog: { tools: "yes", vision: "no" },
    overrides: { tools: "yes" },
  });
  assert.equal(caps.tools?.source, "override");
  assert.equal(canSendTools(caps), true);
  assert.equal(caps.vision?.value, "yes");
});

test("entitlement stays separate from hardware capability", () => {
  const caps = resolveCapabilities({
    provider: { tools: "yes" },
    entitlements: { tools: "requires-pro" },
  });
  assert.equal(caps.tools?.value, "yes");
  assert.equal(caps.tools?.entitled, false);
  assert.equal(canSendTools(caps), false);
  assert.match(caps.tools?.explanation ?? "", /Pro/);
});

test("connection changes discard stale capability banners", () => {
  const state = new CapabilityBannerState<string>();
  state.set("connection-a", "known tools");
  assert.equal(state.get("connection-b"), undefined);
  state.invalidate("connection-b");
  assert.equal(state.get("connection-b"), undefined);
});
