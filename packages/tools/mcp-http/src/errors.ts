/** Honest error codes used by this package's result mapper; note that the
 * engine's PortResult codes are narrower (see PORT_ERROR_CODES in tools.ts). */
export type McpErrorCode =
  | "offline"
  | "auth"
  | "timeout"
  | "protocol"
  | "unsupported"
  | "canceled";

/** Failure result shape produced by {@link mcpErrorResult}. */
export interface McpErrorResult {
  ok: false;
  error: {
    code: McpErrorCode;
    message: string;
    recoverable: boolean;
  };
}

/** The MCP server could not be reached at all (refused, DNS, unreachable). */
export class McpOfflineError extends Error {
  override readonly name = "McpOfflineError";
}

/** The server answered 401/403: the configured credentials are missing,
 * wrong, or no longer accepted. */
export class McpAuthError extends Error {
  override readonly name = "McpAuthError";
}

/** The request exceeded the configured timeoutMs. */
export class McpTimeoutError extends Error {
  override readonly name = "McpTimeoutError";
}

/** The server spoke invalid JSON-RPC, malformed schemas, or an otherwise
 * unintelligible protocol dialect. */
export class McpProtocolError extends Error {
  override readonly name = "McpProtocolError";
}

/** The server offered a transport this client does not implement.
 * {@link explanation} names what the server offered and what is supported. */
export class McpUnsupportedTransportError extends Error {
  override readonly name = "McpUnsupportedTransportError";
  readonly explanation: string;
  constructor(explanation: string) {
    super(`The MCP server uses an unsupported transport: ${explanation}`);
    this.explanation = explanation;
  }
}

function abortError(): Error {
  const error = new Error("The MCP request was canceled.");
  error.name = "AbortError";
  return error;
}

/** Maps any failure thrown by {@link McpHttpClient} (or an AbortError from
 * cancellation) onto an honest recoverable-failure result. Unknown causes are
 * reported as protocol failures rather than silently swallowed. */
export function mcpErrorResult(cause: unknown): McpErrorResult {
  const message =
    cause instanceof Error && cause.message
      ? cause.message
      : "The MCP request failed for an unknown reason.";
  let code: McpErrorCode = "protocol";
  let recoverable = false;
  if (cause instanceof McpOfflineError) {
    code = "offline";
    recoverable = true;
  } else if (cause instanceof McpAuthError) {
    code = "auth";
  } else if (cause instanceof McpTimeoutError) {
    code = "timeout";
    recoverable = true;
  } else if (cause instanceof McpUnsupportedTransportError) {
    code = "unsupported";
  } else if (
    (cause instanceof Error && cause.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      cause instanceof DOMException &&
      cause.name === "AbortError")
  ) {
    code = "canceled";
    recoverable = true;
  }
  return { ok: false, error: { code, message, recoverable } };
}
