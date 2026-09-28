import assert from "node:assert/strict";
import test from "node:test";
import {
  AppleMLProbeError,
  assessAppleML,
  createAppleMLProbe,
  validateProbeReceipt,
  type DeviceFacts,
} from "../src/index.js";

const eligible: DeviceFacts = {
  platform: "ios",
  osMajor: 17,
  architecture: "arm64",
  hasNeuralEngine: true,
  canLoadCoreML: true,
  mlxMetalAvailable: true,
  freeMemoryBytes: 3_000_000_000,
};

test("eligible arm64 iOS reports native capabilities without inventing model proof", () => {
  assert.deepEqual(assessAppleML(eligible), {
    mlx: "yes",
    coreMLImage: "yes",
    fallback: "manual-review",
    limitations: [],
  });
});

test("unsupported platform and unknown facts yield explicit fallback decisions", () => {
  assert.deepEqual(assessAppleML({ ...eligible, platform: "other" }), {
    mlx: "no",
    coreMLImage: "no",
    fallback: "gguf",
    limitations: ["requires-ios-17-or-newer"],
  });
  const unknown = assessAppleML({
    ...eligible,
    mlxMetalAvailable: null,
    canLoadCoreML: null,
  });
  assert.equal(unknown.mlx, "unknown");
  assert.equal(unknown.coreMLImage, "unknown");
  assert.equal(unknown.fallback, "gguf");
});

test("receipt requires device facts and SHA-256 hashes for reproducible evidence", () => {
  const receipt = {
    engine: "mlx-swift-lm" as const,
    deviceModel: "iPhone test device",
    osVersion: "17.0",
    appBuildHash: "a".repeat(64),
    modelHash: "b".repeat(64),
    outputHash: "c".repeat(64),
    elapsedMs: 1,
  };
  assert.equal(validateProbeReceipt(receipt), receipt);
  assert.throws(
    () => validateProbeReceipt({ ...receipt, modelHash: "missing" }),
    /invalid-modelHash/,
  );
});

test("native unsupported result remains typed and selects its fallback", async () => {
  const probe = createAppleMLProbe({
    getDeviceFacts: async () => ({ ok: true, value: eligible }),
    runSmallMlxModel: async () => ({
      ok: false,
      error: {
        code: "ENGINE_NOT_LINKED",
        message: "MLX adapter is not linked",
        recoverable: true,
      },
    }),
    runCoreMLImageModel: async () => ({
      ok: false,
      error: {
        code: "ENGINE_NOT_LINKED",
        message: "Core ML image adapter is not linked",
        recoverable: true,
      },
    }),
  });
  await assert.rejects(probe.runMlx("model", "hello"), (error: unknown) => {
    assert.ok(error instanceof AppleMLProbeError);
    assert.equal(error.code, "ENGINE_NOT_LINKED");
    assert.equal(error.fallback, "gguf");
    return true;
  });
  await assert.rejects(
    probe.runCoreMLImage("model", "landscape"),
    (error: unknown) => {
      assert.ok(error instanceof AppleMLProbeError);
      assert.equal(error.fallback, "remote-image");
      return true;
    },
  );
});
