/** Shared Fetch policy for Expo fetch and desktop Fetch implementations. */

export type HttpErrorCode =
  | "unauthorized"
  | "forbidden"
  | "http"
  | "offline"
  | "timeout"
  | "canceled"
  | "host_not_authorized"
  | "cleartext_not_authorized"
  | "redirect_rejected"
  | "redirect_limit"
  | "malformed_stream"
  | "stream_too_large";

export class HttpTransportError extends Error {
  readonly name = "HttpTransportError";
  readonly cause?: unknown;
  readonly response?: HttpErrorResponse;

  constructor(
    readonly code: HttpErrorCode,
    message: string,
    readonly recoverable: boolean,
    readonly status?: number,
    details?: { cause?: unknown; response?: HttpErrorResponse },
  ) {
    super(message);
    if (details?.cause !== undefined)
      Object.defineProperty(this, "cause", {
        value: details.cause,
        enumerable: false,
      });
    if (details?.response !== undefined)
      Object.defineProperty(this, "response", {
        value: details.response,
        enumerable: false,
      });
  }
}

export interface HttpErrorResponse {
  readonly status: number;
  readonly statusText: string;
  readonly contentType?: string;
  readonly body: string;
  readonly complete: boolean;
}

/** Complete failure details for display at a boundary that redacts credentials. */
export function errorDetails(cause: unknown): string {
  const visited = new Set<unknown>();
  const messages: string[] = [];
  let current = cause;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    let message: string;
    if (current instanceof Error) {
      message = current.message || `${current.name}: empty error message`;
    } else if (typeof current === "string") {
      message = current || "The operation returned an empty error message.";
    } else if (current === undefined || current === null) {
      message = "The operation returned no error details.";
    } else {
      const seen = new Set<object>();
      try {
        const readableMessage =
          typeof current === "object" &&
          "message" in current &&
          typeof current.message === "string"
            ? current.message
            : undefined;
        const payload =
          readableMessage === undefined
            ? current
            : Object.fromEntries(
                Object.entries(current).filter(
                  ([key]) => key !== "message" && key !== "cause",
                ),
              );
        const serialized =
          JSON.stringify(
            payload,
            (key, value: unknown) => {
              if (typeof value === "bigint") return value.toString();
              if (value instanceof Error)
                return { name: value.name, message: value.message };
              if (value && typeof value === "object") {
                if (seen.has(value)) return "[Circular or repeated reference]";
                seen.add(value);
              }
              return value;
            },
            2,
          ) ?? String(current);
        message =
          readableMessage === undefined
            ? serialized
            : `${readableMessage}${serialized === "{}" ? "" : `\nError details:\n${serialized}`}`;
      } catch {
        message = String(current);
      }
    }
    if (!messages.some((detail) => detail.includes(message)))
      messages.push(message);
    current =
      current && typeof current === "object" && "cause" in current
        ? current.cause
        : undefined;
  }
  return (
    messages.join("\nCaused by: ") || "The operation returned no error details."
  );
}

/** Preserve the entire response, including error JSON without a message field. */
export async function httpResponseError(
  response: Response,
  options: {
    summary?: string;
    code?: HttpErrorCode;
    recoverable?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<HttpTransportError> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  validateTimeout(timeoutMs);
  const controller = new AbortController();
  const signal = mergeAbortSignals(options.signal, controller);
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          controller.abort(new Error("Reading the error response timed out"));
        }, timeoutMs)
      : undefined;
  let body = "";
  let complete = true;
  let readFailure: unknown;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const decoder = new TextDecoder();
  try {
    if (response.body && typeof response.body.getReader === "function") {
      reader = response.body.getReader();
      while (true) {
        const chunk = await readWithAbort(reader, signal);
        if (chunk.done) break;
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    } else body = await waitWithAbort(response.text(), signal);
  } catch (cause) {
    complete = false;
    body += decoder.decode();
    readFailure = signal.reason ?? cause;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (reader) {
      if (!complete) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const contentType = response.headers.get("content-type") ?? undefined;
  const statusLine = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  const details: HttpErrorResponse = {
    status: response.status,
    statusText: response.statusText,
    ...(contentType ? { contentType } : {}),
    body,
    complete,
  };
  return new HttpTransportError(
    options.code ??
      (response.status === 401
        ? "unauthorized"
        : response.status === 403
          ? "forbidden"
          : "http"),
    [
      options.summary,
      statusLine,
      contentType ? `Content-Type: ${contentType}` : undefined,
      `Response body${complete ? "" : " (incomplete)"}:\n${body || "[empty]"}`,
      complete
        ? undefined
        : `Could not read the complete response: ${errorDetails(readFailure)}`,
    ]
      .filter((line) => line !== undefined)
      .join("\n"),
    options.recoverable ?? response.status >= 500,
    response.status,
    {
      response: details,
      ...(readFailure !== undefined ? { cause: readFailure } : {}),
    },
  );
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpAuthorizationPolicy {
  /** Exact origins approved by the user/app. Wildcards and URL paths are rejected. */
  readonly authorizedOrigins: readonly string[];
  /** Exact HTTP origins explicitly authorized for a local network. HTTPS is always preferred. */
  readonly cleartextLanOrigins?: readonly string[];
}

export interface HttpTransportOptions {
  readonly fetch: FetchLike;
  readonly policy: HttpAuthorizationPolicy;
  readonly defaultTimeoutMs?: number;
  readonly maxRedirects?: number;
  readonly maxSseEventBytes?: number;
}

export interface HttpRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Let a provider classify the error response; default retains its full body. */
  readonly returnHttpErrors?: boolean;
}

export interface SseMessage {
  readonly data: string;
  readonly event?: string;
  readonly id?: string;
  readonly retry?: number;
}

export interface HttpTransport {
  request(
    url: string | URL,
    init?: RequestInit,
    options?: HttpRequestOptions,
  ): Promise<Response>;
  streamSse(
    url: string | URL,
    init?: RequestInit,
    options?: HttpRequestOptions,
  ): AsyncIterable<SseMessage>;
}

/**
 * Construct a transport with explicit origin authorization. Redirects are
 * resolved manually so a credential-bearing request can never be forwarded to
 * a different origin. SSE reads retain timeout/cancellation until completion.
 */
export function createHttpTransport(
  options: HttpTransportOptions,
): HttpTransport {
  const approved = normalizeOrigins(
    options.policy.authorizedOrigins,
    "authorizedOrigins",
  );
  const cleartext = normalizeOrigins(
    options.policy.cleartextLanOrigins ?? [],
    "cleartextLanOrigins",
  );
  for (const origin of cleartext) {
    if (!approved.has(origin) || !origin.startsWith("http://")) {
      throw new TypeError(
        "Cleartext LAN origins must be HTTP origins also present in authorizedOrigins",
      );
    }
  }
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  const maxRedirects = options.maxRedirects ?? 5;
  const maxSseEventBytes = options.maxSseEventBytes ?? 1_048_576;

  const request = async (
    input: string | URL,
    init: RequestInit = {},
    requestOptions: HttpRequestOptions = {},
  ): Promise<Response> => {
    const timeoutMs = requestOptions.timeoutMs ?? defaultTimeoutMs;
    validateTimeout(timeoutMs);
    const controller = new AbortController();
    const signal = mergeAbortSignals(
      requestOptions.signal ?? init.signal ?? undefined,
      controller,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("HTTP request timed out"));
      }, timeoutMs);
    }

    try {
      let currentUrl = authorizeUrl(input, approved, cleartext);
      let method = init.method ?? "GET";
      let body = init.body;
      const headers = new Headers(init.headers);
      for (let redirects = 0; ; redirects++) {
        if (signal.aborted)
          throw abortError(
            requestOptions.signal ?? init.signal ?? undefined,
            timedOut,
          );
        const response = await options.fetch(currentUrl, {
          ...init,
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal,
          redirect: "manual",
        });
        if (!isRedirect(response.status)) {
          if (requestOptions.returnHttpErrors) return response;
          if (!response.ok)
            throw await httpResponseError(response, { signal, timeoutMs: 0 });
          return response;
        }

        const location = response.headers.get("location");
        if (!location)
          throw await httpResponseError(response, {
            summary: "Redirect did not include a location",
            code: "redirect_rejected",
            recoverable: false,
            signal,
            timeoutMs: 0,
          });
        if (redirects >= maxRedirects)
          throw await httpResponseError(response, {
            summary: "HTTP redirect limit exceeded",
            code: "redirect_limit",
            recoverable: false,
            signal,
            timeoutMs: 0,
          });
        const nextUrl = authorizeUrl(
          new URL(location, currentUrl),
          approved,
          cleartext,
        );
        if (nextUrl.origin !== currentUrl.origin) {
          throw await httpResponseError(response, {
            summary: "Cross-origin redirects are not followed",
            code: "redirect_rejected",
            recoverable: false,
            signal,
            timeoutMs: 0,
          });
        }
        // Match Fetch redirect method handling for common API redirects. A body
        // is only replayed for 307/308, where the method is preserved.
        if (
          (response.status === 301 ||
            response.status === 302 ||
            response.status === 303) &&
          method.toUpperCase() !== "GET" &&
          method.toUpperCase() !== "HEAD"
        ) {
          method = "GET";
          body = undefined;
          headers.delete("content-type");
          headers.delete("content-length");
        } else if (
          (response.status === 307 || response.status === 308) &&
          body != null &&
          !isReplayableBody(body)
        ) {
          throw await httpResponseError(response, {
            summary:
              "Redirect requires replaying a non-replayable request body",
            code: "redirect_rejected",
            recoverable: false,
            signal,
            timeoutMs: 0,
          });
        }
        currentUrl = nextUrl;
      }
    } catch (error) {
      if (error instanceof HttpTransportError) {
        if (timedOut && error.code === "canceled") {
          throw new HttpTransportError(
            "timeout",
            "HTTP request timed out",
            true,
          );
        }
        throw error;
      }
      if (timedOut)
        throw new HttpTransportError(
          "timeout",
          `HTTP request timed out after ${timeoutMs} ms.\n${errorDetails(error)}`,
          true,
          undefined,
          { cause: error },
        );
      if (requestOptions.signal?.aborted || init.signal?.aborted)
        throw new HttpTransportError(
          "canceled",
          `HTTP request canceled.\n${errorDetails(error)}`,
          true,
          undefined,
          { cause: error },
        );
      if (controller.signal.aborted)
        throw new HttpTransportError(
          "canceled",
          `HTTP request canceled.\n${errorDetails(error)}`,
          true,
          undefined,
          { cause: error },
        );
      throw new HttpTransportError(
        "offline",
        `HTTP connection failed.\n${errorDetails(error)}`,
        true,
        undefined,
        { cause: error },
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  async function* streamSse(
    url: string | URL,
    init: RequestInit = {},
    requestOptions: HttpRequestOptions = {},
  ): AsyncIterable<SseMessage> {
    const timeoutMs = requestOptions.timeoutMs ?? defaultTimeoutMs;
    validateTimeout(timeoutMs);
    const controller = new AbortController();
    const sourceSignal = requestOptions.signal ?? init.signal ?? undefined;
    const signal = mergeAbortSignals(sourceSignal, controller);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resetTimer = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error("SSE stream timed out"));
        }, timeoutMs);
      }
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      resetTimer();
      const response = await request(
        url,
        { ...init, signal },
        { signal, timeoutMs: 0 },
      );
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== "text/event-stream")
        throw await httpResponseError(response, {
          summary: "Response is not an event stream",
          code: "malformed_stream",
          recoverable: false,
          signal,
          timeoutMs: 0,
        });
      if (!response.body)
        throw new HttpTransportError(
          "malformed_stream",
          "Event stream has no response body",
          false,
        );
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "";
      let eventBytes = 0;
      let data: string[] = [];
      let event: string | undefined;
      let id: string | undefined;
      let retry: number | undefined;
      const dispatch = (): SseMessage | undefined => {
        const message = data.length
          ? {
              data: data.join("\n"),
              ...(event === undefined ? {} : { event }),
              ...(id === undefined ? {} : { id }),
              ...(retry === undefined ? {} : { retry }),
            }
          : undefined;
        data = [];
        event = undefined;
        retry = undefined;
        eventBytes = 0;
        return message;
      };
      const consumeLine = (line: string): SseMessage | undefined => {
        if (line === "") return dispatch();
        if (line.startsWith(":")) return undefined; // heartbeat/comment
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value =
          colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        eventBytes += new TextEncoder().encode(line).byteLength + 1;
        if (eventBytes > maxSseEventBytes)
          throw new HttpTransportError(
            "stream_too_large",
            "SSE event exceeded the configured size limit",
            false,
          );
        if (field === "data") data.push(value);
        else if (field === "event") event = value;
        else if (field === "id" && !value.includes("\0")) id = value;
        else if (field === "retry" && /^\d+$/.test(value))
          retry = Number(value);
        return undefined;
      };

      while (true) {
        if (signal.aborted) throw abortStreamError(sourceSignal, timedOut);
        resetTimer();
        const result = await readWithAbort(reader, signal);
        resetTimer();
        if (result.done) {
          buffer += decoder.decode();
          if (buffer.length) {
            const last = consumeLine(stripCR(buffer));
            if (last) yield last;
          }
          const finalMessage = dispatch();
          if (finalMessage) yield finalMessage;
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = stripCR(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          const message = consumeLine(line);
          if (message) yield message;
          newline = buffer.indexOf("\n");
        }
        if (
          new TextEncoder().encode(buffer).byteLength + eventBytes >
          maxSseEventBytes
        ) {
          throw new HttpTransportError(
            "stream_too_large",
            "SSE event exceeded the configured size limit",
            false,
          );
        }
      }
    } catch (error) {
      if (error instanceof HttpTransportError) {
        if (timedOut && error.code === "canceled") {
          throw new HttpTransportError("timeout", "SSE stream timed out", true);
        }
        throw error;
      }
      if (timedOut)
        throw new HttpTransportError(
          "timeout",
          `SSE stream timed out after ${timeoutMs} ms.\n${errorDetails(error)}`,
          true,
          undefined,
          { cause: error },
        );
      if (sourceSignal?.aborted)
        throw new HttpTransportError(
          "canceled",
          `SSE stream canceled.\n${errorDetails(error)}`,
          true,
          undefined,
          { cause: error },
        );
      if (error instanceof TypeError)
        throw new HttpTransportError(
          "malformed_stream",
          `SSE stream contained invalid UTF-8.\n${errorDetails(error)}`,
          false,
          undefined,
          { cause: error },
        );
      throw new HttpTransportError(
        "offline",
        `SSE connection failed.\n${errorDetails(error)}`,
        true,
        undefined,
        { cause: error },
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          /* stream already closed */
        }
        reader.releaseLock();
      }
    }
  }

  return { request, streamSse };
}

function normalizeOrigins(
  values: readonly string[],
  field: string,
): Set<string> {
  const origins = new Set<string>();
  for (const value of values) {
    if (value.includes("*") || value.includes("/", value.indexOf("://") + 3))
      throw new TypeError(`${field} entries must be exact origins`);
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new TypeError(
        `${field} entries must be credential-free HTTP(S) origins`,
      );
    }
    origins.add(url.origin);
  }
  return origins;
}

function authorizeUrl(
  input: string | URL,
  approved: Set<string>,
  cleartext: Set<string>,
): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new HttpTransportError(
      "host_not_authorized",
      "HTTP target URL is invalid",
      false,
    );
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new HttpTransportError(
      "host_not_authorized",
      "HTTP target must use an authorized HTTP(S) origin without embedded credentials",
      false,
    );
  }
  if (!approved.has(url.origin))
    throw new HttpTransportError(
      "host_not_authorized",
      "HTTP target origin is not authorized",
      false,
    );
  if (url.protocol === "http:" && !cleartext.has(url.origin))
    throw new HttpTransportError(
      "cleartext_not_authorized",
      "Cleartext HTTP is not authorized for this LAN origin",
      false,
    );
  url.hash = "";
  return url;
}

function mergeAbortSignals(
  source: AbortSignal | undefined,
  controller: AbortController,
): AbortSignal {
  if (!source) return controller.signal;
  if (typeof AbortSignal.any === "function")
    return AbortSignal.any([source, controller.signal]);
  if (source.aborted) controller.abort(source.reason);
  else
    source.addEventListener("abort", () => controller.abort(source.reason), {
      once: true,
    });
  return controller.signal;
}

function abortError(
  signal: AbortSignal | undefined,
  timedOut: boolean,
): HttpTransportError {
  return timedOut
    ? new HttpTransportError("timeout", "HTTP request timed out", true)
    : new HttpTransportError("canceled", "HTTP request canceled", true);
}

function abortStreamError(
  signal: AbortSignal | undefined,
  timedOut: boolean,
): HttpTransportError {
  return timedOut
    ? new HttpTransportError("timeout", "SSE stream timed out", true)
    : new HttpTransportError("canceled", "SSE stream canceled", true);
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new RangeError("timeoutMs must be a non-negative finite number");
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}
function isReplayableBody(body: BodyInit): boolean {
  return (
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
}
function stripCR(value: string): string {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(new Error("Stream read aborted"));
  return waitWithAbort(reader.read(), signal);
}

function waitWithAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined);
    return Promise.reject(signal.reason ?? new Error("Response read aborted"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(new Error("Stream read aborted"));
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
