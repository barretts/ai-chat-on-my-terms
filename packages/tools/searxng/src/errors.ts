/** Honest failure codes produced by this package. */
export type SearxngErrorCode =
  | "offline"
  | "auth"
  | "timeout"
  | "canceled"
  | "ratelimited"
  | "malformed"
  | "unsupported"
  | "malformed-config";

/** A SearXNG failure carrying the {@link SearxngErrorCode} it maps to.
 * Every failure thrown by {@link SearxngClient} (and by
 * {@link normalizeSearxngBaseUrl}) is an instance of this class. */
export class SearxngError extends Error {
  override readonly name = "SearxngError";
  readonly code: SearxngErrorCode;
  constructor(code: SearxngErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Failure result shape produced by {@link searxngErrorResult}. */
export interface SearxngErrorResult {
  ok: false;
  error: {
    code: SearxngErrorCode;
    message: string;
    recoverable: boolean;
  };
}

/** Retrying these codes can plausibly succeed later; the others need
 * a configuration or server change first. */
const RECOVERABLE_BY_CODE: Record<SearxngErrorCode, boolean> = {
  offline: true,
  auth: false,
  timeout: true,
  canceled: true,
  ratelimited: true,
  malformed: false,
  unsupported: false,
  "malformed-config": false,
};

/** Maps any failure thrown by this package (including a bare AbortError or
 * TimeoutError from the fetch layer) onto an honest recoverable-failure
 * result. Unknown causes are reported as malformed rather than swallowed. */
export function searxngErrorResult(cause: unknown): SearxngErrorResult {
  if (cause instanceof SearxngError)
    return {
      ok: false,
      error: {
        code: cause.code,
        message: cause.message,
        recoverable: RECOVERABLE_BY_CODE[cause.code],
      },
    };
  if (cause instanceof Error || cause instanceof DOMException) {
    if (cause.name === "AbortError")
      return {
        ok: false,
        error: {
          code: "canceled",
          message: "The SearXNG request was canceled.",
          recoverable: true,
        },
      };
    if (cause.name === "TimeoutError")
      return {
        ok: false,
        error: {
          code: "timeout",
          message:
            cause.message || "The SearXNG request exceeded its time budget.",
          recoverable: true,
        },
      };
    if (cause.message)
      return {
        ok: false,
        error: { code: "offline", message: cause.message, recoverable: true },
      };
  }
  return {
    ok: false,
    error: {
      code: "malformed",
      message: "The SearXNG request failed for an unknown reason.",
      recoverable: false,
    },
  };
}
