import { errorDetails } from "@locallab/network-http";
import { sanitizeDiagnosticText } from "./sanitization";
import { traceLog } from "./trace-log";

export interface ErrorContext {
  operation: string;
  recovery: string;
}
export function describeError(cause: unknown, context: ErrorContext): string {
  const object =
    cause && typeof cause === "object"
      ? (cause as {
          message?: unknown;
          code?: unknown;
          status?: unknown;
          name?: unknown;
          cause?: unknown;
          response?: unknown;
          responseBody?: unknown;
        })
      : undefined;
  const messages = [errorDetails(cause)];
  const visited = new Set<unknown>();
  let nested: unknown = cause;
  while (nested && typeof nested === "object" && !visited.has(nested)) {
    visited.add(nested);
    // Some native/provider adapters expose a response separately from .message.
    // These explicit response fields must also reach the display and clipboard.
    if (nested instanceof Error) {
      const detail = nested as Error & {
        status?: unknown;
        code?: unknown;
        response?: unknown;
        responseBody?: unknown;
      };
      if (
        typeof detail.status === "number" &&
        !messages.join("\n").includes(`HTTP ${detail.status}`)
      )
        messages.push(`HTTP ${detail.status}`);
      if (
        typeof detail.code === "string" &&
        !messages.join("\n").includes(detail.code)
      )
        messages.push(`Error code: ${detail.code}`);
      if (detail.responseBody !== undefined) {
        const body =
          typeof detail.responseBody === "string"
            ? detail.responseBody
            : errorDetails(detail.responseBody);
        if (!messages.join("\n").includes(body))
          messages.push(`Response body:\n${body}`);
      }
      if (detail.response !== undefined) {
        const response = detail.response as { body?: unknown };
        if (
          !(
            typeof response?.body === "string" &&
            messages.join("\n").includes(response.body)
          )
        )
          messages.push(`Response:\n${errorDetails(detail.response)}`);
      }
    }
    nested = "cause" in nested ? nested.cause : undefined;
  }
  const details = sanitizeDiagnosticText(messages.join("\n"));
  const code = typeof object?.code === "string" ? object.code : undefined;
  const status = typeof object?.status === "number" ? object.status : undefined;
  traceLog.event(context.operation, "failed", {
    ...(code ? { code } : {}),
    ...(status ? { status } : {}),
    ...(cause instanceof Error ? { errorName: cause.name } : {}),
  });
  if (
    !object?.cause &&
    /^[^\n]{1,120} failed\.\n/.test(details) &&
    details.split("\n").length >= 3
  )
    return details;
  return `${context.operation} failed.\n${details}\n${context.recovery}`;
}
