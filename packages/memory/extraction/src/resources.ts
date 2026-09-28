/** Admission failure does not release the outstanding provider resources. */
export class MemoryResourcesBusyError extends Error {
  readonly code = "quota";
  readonly recoverable = true;
  constructor() {
    super(
      "Memory extraction is still releasing the selected model. Wait and try again.",
    );
    this.name = "MemoryResourcesBusyError";
  }
}

export function waitWithAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Canceled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export async function waitForResources(
  work: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000)
    throw new Error("Invalid memory resource admission timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.catch(() => {
        throw new MemoryResourcesBusyError();
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new MemoryResourcesBusyError()),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
