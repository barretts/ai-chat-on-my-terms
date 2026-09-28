export type GgufProbeInput = {
  /** Absolute local file URI to a legally usable, small GGUF model. */
  modelUri: string;
  /** SHA-256 of the exact model file, calculated by the importing app. */
  modelSha256: string;
  /** Exact app build identifier, ideally the source revision plus native build number. */
  buildId: string;
  /** Supply from Expo Device (`isDevice`, `modelName`, and `osVersion`). */
  device: { isPhysicalDevice: boolean; model: string; osVersion: string };
  /** The prompt is fixed for repeatable probe runs. */
  onToken?: (token: string) => void;
  /** Probe cancellation after this many milliseconds; defaults to 2 seconds. */
  cancelAfterMs?: number;
};

export type GgufProbeResult = {
  status: "passed" | "completed_without_cancel" | "unsupported";
  platform: string;
  deviceModel?: string;
  osVersion?: string;
  buildId: string;
  modelSha256: string;
  packageVersion: "0.12.4";
  startedAt: string;
  loadMs?: number;
  firstTokenMs?: number;
  elapsedMs?: number;
  emittedTokens: number;
  cancellationRequested: boolean;
  cancellationResolved: boolean;
  backend?: string;
  note: string;
};

const sha256Pattern = /^[\da-f]{64}$/i;

export function hasSupportedDeviceEvidence(
  platform: string,
  device: GgufProbeInput["device"],
): boolean {
  return (
    platform === "ios" &&
    device.isPhysicalDevice &&
    device.model.trim().length > 0 &&
    device.osVersion.trim().length > 0
  );
}

/**
 * Runs one bounded native load/stream/cancel probe. This intentionally refuses
 * simulator and non-iOS runs: llama.rn's Metal backend requires physical iOS.
 */
export async function runGgufProbe(
  input: GgufProbeInput,
): Promise<GgufProbeResult> {
  if (!sha256Pattern.test(input.modelSha256)) {
    throw new Error(
      "modelSha256 must be the 64-character SHA-256 of the model",
    );
  }
  if (!input.buildId.trim()) throw new Error("buildId is required");
  if (!input.modelUri.startsWith("file://")) {
    throw new Error(
      "modelUri must be a local file:// URI; remote model URLs are rejected",
    );
  }

  const { Platform } = await import("react-native");
  const startedAt = new Date().toISOString();
  const base = {
    platform: Platform.OS,
    buildId: input.buildId,
    modelSha256: input.modelSha256.toLowerCase(),
    packageVersion: "0.12.4" as const,
    startedAt,
    emittedTokens: 0,
    cancellationRequested: false,
    cancellationResolved: false,
  };

  if (!hasSupportedDeviceEvidence(Platform.OS, input.device)) {
    return {
      ...base,
      status: "unsupported",
      note: "Requires a physical iPhone; simulator and other platforms are not evidence.",
    };
  }
  const { initLlama } = await import("llama.rn");
  const loadStarted = performance.now();
  const context = await initLlama({
    model: input.modelUri,
    n_ctx: 512,
    n_batch: 128,
    n_gpu_layers: 99,
    use_mlock: true,
  });
  const loadMs = Math.round(performance.now() - loadStarted);
  const generationStarted = performance.now();
  let firstTokenMs: number | undefined;
  let emittedTokens = 0;
  let requestHandle: { stop: () => Promise<unknown> } | undefined;
  let shouldArmCancellation = false;
  let firstTokenTimer: ReturnType<typeof setTimeout> | undefined;
  let cancellationRequested = false;
  let cancellationResolved = false;
  let stopPromise: Promise<void> | undefined;
  const requestStop = () => {
    if (cancellationRequested || !requestHandle) return;
    cancellationRequested = true;
    stopPromise = requestHandle.stop().then(() => {
      cancellationResolved = true;
    });
  };
  const scheduleTokenStop = () => {
    if (firstTokenTimer || cancellationRequested) return;
    firstTokenTimer = setTimeout(requestStop, input.cancelAfterMs ?? 1_500);
  };

  try {
    await context.parallel.enable({ n_parallel: 1, n_batch: 128 });
    const request = await context.parallel.completion(
      {
        messages: [
          {
            role: "user",
            content: "Reply with a short greeting and nothing else.",
          },
        ],
        n_predict: 128,
        temperature: 0,
      },
      (_requestId, tokenData) => {
        if (firstTokenMs === undefined) {
          firstTokenMs = Math.round(performance.now() - generationStarted);
          if (requestHandle) scheduleTokenStop();
          else shouldArmCancellation = true;
        }
        emittedTokens += 1;
        input.onToken?.(tokenData.token);
      },
    );
    requestHandle = request;
    const hardTimeout = setTimeout(requestStop, 30_000);
    // If output arrives, allow it to stream briefly, then exercise cancellation.
    // The hard timeout also bounds a stalled generation that emits no token.
    if (shouldArmCancellation) scheduleTokenStop();
    try {
      await request.promise;
      if (stopPromise) await stopPromise;
    } catch (error) {
      if (!cancellationRequested) throw error;
      if (stopPromise) await stopPromise;
    } finally {
      clearTimeout(hardTimeout);
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
    }
    const status =
      cancellationRequested && cancellationResolved
        ? "passed"
        : "completed_without_cancel";
    return {
      ...base,
      status,
      deviceModel: input.device.model,
      osVersion: input.device.osVersion,
      loadMs,
      ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
      elapsedMs: Math.round(performance.now() - generationStarted),
      emittedTokens,
      cancellationRequested,
      cancellationResolved,
      backend: "llama.cpp / Metal requested (n_gpu_layers=99)",
      note: "Record iPhone model, iOS version, peak memory and thermal state with this result; those require device observation.",
    };
  } finally {
    await context.release();
  }
}
