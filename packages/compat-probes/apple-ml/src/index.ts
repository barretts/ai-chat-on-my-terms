export type Capability = "yes" | "no" | "unknown";
export type AppleMLEngine = "mlx-swift-lm" | "core-ml-stable-diffusion";

export interface DeviceFacts {
  platform: "ios" | "other";
  osMajor: number;
  architecture: "arm64" | "other" | "unknown";
  hasNeuralEngine: boolean | null;
  canLoadCoreML: boolean | null;
  mlxMetalAvailable: boolean | null;
  freeMemoryBytes: number | null;
}

export interface CapabilityDecision {
  mlx: Capability;
  coreMLImage: Capability;
  fallback: "gguf" | "remote-image" | "manual-review";
  limitations: string[];
}

export interface ProbeReceipt {
  engine: AppleMLEngine;
  deviceModel: string;
  osVersion: string;
  appBuildHash: string;
  modelHash: string;
  outputHash: string;
  elapsedMs: number;
}

const sha256 = /^[a-f0-9]{64}$/i;

export function assessAppleML(facts: DeviceFacts): CapabilityDecision {
  const limitations: string[] = [];
  if (facts.platform !== "ios" || facts.osMajor < 17) {
    limitations.push("requires-ios-17-or-newer");
    return { mlx: "no", coreMLImage: "no", fallback: "gguf", limitations };
  }
  if (facts.architecture === "other") {
    limitations.push("requires-arm64");
    return { mlx: "no", coreMLImage: "no", fallback: "gguf", limitations };
  }

  const mlx: Capability =
    facts.architecture === "unknown" || facts.mlxMetalAvailable === null
      ? "unknown"
      : facts.mlxMetalAvailable && facts.architecture === "arm64"
        ? "yes"
        : "no";
  const coreMLImage: Capability =
    facts.canLoadCoreML === null || facts.hasNeuralEngine === null
      ? "unknown"
      : facts.canLoadCoreML && facts.hasNeuralEngine
        ? "yes"
        : "no";

  if (facts.freeMemoryBytes !== null && facts.freeMemoryBytes < 1_500_000_000) {
    limitations.push("low-free-memory-small-model-only");
  }
  if (mlx !== "yes")
    limitations.push(
      mlx === "no" ? "mlx-metal-unavailable" : "mlx-capability-unverified",
    );
  if (coreMLImage !== "yes")
    limitations.push(
      coreMLImage === "no"
        ? "coreml-image-unavailable"
        : "coreml-capability-unverified",
    );
  return {
    mlx,
    coreMLImage,
    fallback: mlx === "yes" ? "manual-review" : "gguf",
    limitations,
  };
}

export function validateProbeReceipt(receipt: ProbeReceipt): ProbeReceipt {
  for (const field of ["appBuildHash", "modelHash", "outputHash"] as const) {
    if (!sha256.test(receipt[field])) throw new Error(`invalid-${field}`);
  }
  if (!receipt.deviceModel.trim() || !receipt.osVersion.trim())
    throw new Error("missing-device-evidence");
  if (!Number.isFinite(receipt.elapsedMs) || receipt.elapsedMs < 0)
    throw new Error("invalid-elapsed-ms");
  return receipt;
}

export interface NativeAppleMLProbe {
  getDeviceFacts(): Promise<NativeProbeResult<DeviceFacts>>;
  runSmallMlxModel(
    modelPath: string,
    prompt: string,
  ): Promise<NativeProbeResult<ProbeReceipt>>;
  runCoreMLImageModel(
    modelPath: string,
    prompt: string,
    seed: number,
  ): Promise<NativeProbeResult<ProbeReceipt>>;
}

export type NativeProbeErrorCode =
  | "NATIVE_BUILD_REQUIRED"
  | "UNSUPPORTED_HARDWARE"
  | "ENGINE_NOT_LINKED"
  | "MODEL_NOT_FOUND"
  | "INFERENCE_FAILED";

export type NativeProbeResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code: NativeProbeErrorCode;
        message: string;
        recoverable: boolean;
      };
    };

export class AppleMLProbeError extends Error {
  constructor(
    readonly code: NativeProbeErrorCode,
    message: string,
    readonly recoverable: boolean,
    readonly fallback: CapabilityDecision["fallback"],
  ) {
    super(message);
    this.name = "AppleMLProbeError";
  }
}

function unwrap<T>(
  result: NativeProbeResult<T>,
  fallback: CapabilityDecision["fallback"],
): T {
  if (result.ok) return result.value;
  throw new AppleMLProbeError(
    result.error.code,
    result.error.message,
    result.error.recoverable,
    fallback,
  );
}

export function createAppleMLProbe(native: NativeAppleMLProbe) {
  return {
    async capabilities(): Promise<CapabilityDecision> {
      return assessAppleML(
        unwrap(await native.getDeviceFacts(), "manual-review"),
      );
    },
    async runMlx(modelPath: string, prompt: string): Promise<ProbeReceipt> {
      return validateProbeReceipt(
        unwrap(await native.runSmallMlxModel(modelPath, prompt), "gguf"),
      );
    },
    async runCoreMLImage(
      modelPath: string,
      prompt: string,
      seed = 7,
    ): Promise<ProbeReceipt> {
      return validateProbeReceipt(
        unwrap(
          await native.runCoreMLImageModel(modelPath, prompt, seed),
          "remote-image",
        ),
      );
    },
  };
}
