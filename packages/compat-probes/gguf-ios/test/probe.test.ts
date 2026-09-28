import assert from "node:assert/strict";
import test from "node:test";
import { hasSupportedDeviceEvidence, runGgufProbe } from "../src/index.ts";

test("rejects missing or malformed model hash before native initialization", async () => {
  await assert.rejects(
    () =>
      runGgufProbe({
        modelUri: "file:///tmp/tiny.gguf",
        modelSha256: "abc",
        buildId: "test",
        device: { isPhysicalDevice: false, model: "simulator", osVersion: "" },
      }),
    /modelSha256/,
  );
});

test("does not accept remote model paths", async () => {
  await assert.rejects(
    () =>
      runGgufProbe({
        modelUri: "https://example.invalid/tiny.gguf",
        modelSha256: "a".repeat(64),
        buildId: "test",
        device: { isPhysicalDevice: false, model: "simulator", osVersion: "" },
      }),
    /local file/,
  );
});

test("only treats a physical iPhone with model and OS identity as supported evidence", () => {
  const iphone = {
    isPhysicalDevice: true,
    model: "iPhone 16 Pro",
    osVersion: "iOS 19.1",
  };
  assert.equal(hasSupportedDeviceEvidence("ios", iphone), true);
  assert.equal(
    hasSupportedDeviceEvidence("ios", { ...iphone, isPhysicalDevice: false }),
    false,
  );
  assert.equal(
    hasSupportedDeviceEvidence("ios", { ...iphone, model: "" }),
    false,
  );
  assert.equal(hasSupportedDeviceEvidence("android", iphone), false);
});
