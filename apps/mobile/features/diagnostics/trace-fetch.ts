import { traceLog } from "./trace-log";

/** Records transport outcomes only. Request/response bodies and headers are never read. */
export function tracedFetch(
  fetcher: typeof fetch,
  operation: string,
): typeof fetch {
  return async (input, init) => {
    const endpoint =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method =
      init?.method ??
      (typeof Request !== "undefined" && input instanceof Request
        ? input.method
        : "GET");
    const start = Date.now();
    traceLog.event(operation, "start", { endpoint, method });
    try {
      const response = await fetcher(input, init);
      traceLog.event(operation, response.ok ? "complete" : "failed", {
        endpoint,
        method,
        status: response.status,
        durationMs: Date.now() - start,
      });
      return response;
    } catch (cause) {
      traceLog.event(
        operation,
        cause instanceof Error && cause.name === "AbortError"
          ? "cancelled"
          : "failed",
        {
          endpoint,
          method,
          durationMs: Date.now() - start,
          errorName: cause instanceof Error ? cause.name : "Error",
        },
      );
      throw cause;
    }
  };
}
