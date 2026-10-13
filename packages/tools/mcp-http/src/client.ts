import {
  McpAuthError,
  McpOfflineError,
  McpProtocolError,
  McpTimeoutError,
  McpUnsupportedTransportError,
} from "./errors";
import { isRecord } from "./type-guards";

/** Registry name rule copied from the tool engine: remote MCP tools whose
 * original name violates it are rejected per tool, never silently renamed. */
const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MCP_PROTOCOL_VERSION = "2025-03-26";
const MAX_REDIRECT_HOPS = 5;
const TRANSPORT_SUMMARY =
  "supported transports are Streamable HTTP (POST answering application/json " +
  "or text/event-stream) and legacy SSE (GET answering an endpoint event)";

/** Configuration for one remote MCP server. {@link McpServerConfig.headers}
 * carries resolved secret VALUES supplied by the caller; this package never
 * sees secret refs. */
export interface McpServerConfig {
  id: string;
  label: string;
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** Result of the MCP initialize handshake. */
export interface McpServerInfo {
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  capabilities: Record<string, unknown>;
}

/** One tool advertised by a remote MCP server, with the ORIGINAL remote name. */
export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** One validated discovery outcome: accepted tools plus per-tool rejections. */
export interface McpDiscovery {
  tools: McpToolInfo[];
  errors: McpToolRejection[];
}

/** Why a discovered tool was excluded (invalid name or input schema). */
export interface McpToolRejection {
  name: string;
  reason: string;
}

/** Raw result of one tools/call roundtrip. */
export interface McpCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

interface JsonRpcEnvelope {
  result?: unknown;
}

interface RpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id?: number;
}

type StreamChunk = { done: true } | { done: false; value: Uint8Array };

interface SignalPair {
  signal: AbortSignal;
  cleanup(): void;
}

/**
 * HTTP MCP client speaking Streamable HTTP first with a legacy SSE fallback.
 *
 * Security policy (non-negotiable): every request is issued with
 * `redirect: "manual"`. Configured headers are attached only while the
 * effective request URL keeps the origin of {@link McpServerConfig.url};
 * same-origin redirects are followed up to 5 hops, cross-origin redirects are
 * refused with a protocol error and the foreign origin is never contacted.
 */
export class McpHttpClient {
  readonly config: McpServerConfig;
  private readonly fetchImpl: typeof globalThis.fetch;
  private sessionId?: string;
  private messageEndpoint?: string;
  private initializedFlag = false;
  private disposed = false;
  private nextId = 1;

  constructor(
    config: McpServerConfig,
    opts: { fetch?: typeof globalThis.fetch } = {},
  ) {
    this.config = config;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  /** True once the initialize handshake (either transport) has completed. */
  get isInitialized(): boolean {
    return this.initializedFlag;
  }

  /** Performs the initialize handshake plus the initialized notification.
   * Streamable HTTP is tried first; a transport-shape failure (unsupported
   * content type or 4xx on the handshake itself) falls back to legacy SSE
   * negotiation. Auth failures, offline, and cancellation never fall back. */
  async initialize(signal: AbortSignal): Promise<McpServerInfo> {
    if (this.disposed)
      throw new McpProtocolError(
        `The MCP server "${this.config.label}" client has been disposed.`,
      );
    let envelope: JsonRpcEnvelope | null = null;
    let streamableFailure: unknown;
    try {
      envelope = await this.postRpc(
        new URL(this.config.url),
        {
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "LocalLab", version: "0.1.0" },
          },
        },
        signal,
      );
    } catch (cause) {
      if (
        !(cause instanceof McpUnsupportedTransportError) &&
        !(cause instanceof McpProtocolError)
      )
        throw cause;
      streamableFailure = cause;
    }
    if (!envelope || envelope.result === undefined) {
      let legacy: { serverInfo: McpServerInfo; messageEndpoint: string };
      try {
        legacy = await this.discoverLegacySse(signal);
      } catch (cause) {
        if (
          streamableFailure instanceof McpUnsupportedTransportError &&
          cause instanceof McpUnsupportedTransportError
        )
          throw new McpUnsupportedTransportError(
            `${streamableFailure.explanation}; and ${cause.explanation}`,
          );
        throw cause;
      }
      this.messageEndpoint = legacy.messageEndpoint;
      this.finalizeInitialization(signal);
      return legacy.serverInfo;
    }
    this.finalizeInitialization(signal);
    return this.serverInfoFrom(envelope.result, `MCP server "${this.config.label}"`);
  }

  /** Lists and validates every advertised tool. Tools whose remote name
   * violates the engine registry rule, or whose inputSchema is not a JSON
   * object of type "object" (or empty), are EXCLUDED from `tools` and
   * reported in `errors`; accepted entries keep their original names. */
  async discoverTools(signal: AbortSignal): Promise<McpDiscovery> {
    this.requireInitialized();
    const target = this.messageEndpoint
      ? new URL(this.messageEndpoint)
      : new URL(this.config.url);
    const envelope = await this.postRpc(
      target,
      { jsonrpc: "2.0", id: this.nextId++, method: "tools/list" },
      signal,
    );
    const result = envelope.result;
    if (!isRecord(result) || !Array.isArray(result.tools))
      throw new McpProtocolError(
        `MCP server "${this.config.label}" returned no tools array for tools/list.`,
      );
    const tools: McpToolInfo[] = [];
    const errors: McpToolRejection[] = [];
    for (const entry of result.tools) {
      if (!isRecord(entry) || typeof entry.name !== "string") {
        errors.push({
          name: "<unnamed>",
          reason: "the tool entry is missing a string name",
        });
        continue;
      }
      const name = entry.name;
      if (!TOOL_NAME_PATTERN.test(name)) {
        errors.push({
          name,
          reason:
            "the remote tool name is not a valid tool engine registry name",
        });
        continue;
      }
      let inputSchema: Record<string, unknown> = {};
      if (entry.inputSchema !== undefined) {
        if (!isRecord(entry.inputSchema)) {
          errors.push({ name, reason: "inputSchema must be a JSON object" });
          continue;
        }
        if (
          Object.keys(entry.inputSchema).length > 0 &&
          entry.inputSchema.type !== "object"
        ) {
          errors.push({
            name,
            reason: 'inputSchema must describe an object (type "object")',
          });
          continue;
        }
        inputSchema = entry.inputSchema;
      }
      const tool: McpToolInfo = { name, inputSchema };
      if (typeof entry.title === "string") tool.title = entry.title;
      if (typeof entry.description === "string")
        tool.description = entry.description;
      tools.push(tool);
    }
    return { tools, errors };
  }

  /** Runs one tools/call roundtrip and returns the raw result content. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    progressToken?: string | number,
  ): Promise<McpCallResult> {
    this.requireInitialized();
    const target = this.messageEndpoint
      ? new URL(this.messageEndpoint)
      : new URL(this.config.url);
    const params: Record<string, unknown> = { name, arguments: args };
    if (progressToken !== undefined) params._meta = { progressToken };
    const envelope = await this.postRpc(
      target,
      { jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params },
      signal,
    );
    const result = isRecord(envelope.result) ? envelope.result : {};
    const content: McpCallResult["content"] = [];
    if (Array.isArray(result.content)) {
      for (const part of result.content) {
        if (!isRecord(part) || typeof part.type !== "string") continue;
        const item: { type: string; text?: string } = { type: part.type };
        if (typeof part.text === "string") item.text = part.text;
        content.push(item);
      }
    }
    const call: McpCallResult = { content };
    if (result.isError === true) call.isError = true;
    if (result.structuredContent !== undefined)
      call.structuredContent = result.structuredContent;
    return call;
  }

  /** Ends the server-side session (DELETE when a Streamable HTTP session id
   * was issued); teardown errors are swallowed. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.initializedFlag = false;
    if (!this.sessionId) return;
    try {
      const response = await this.fetchImpl(this.config.url, {
        method: "DELETE",
        headers: this.baseHeaders(true),
      });
      await response.body?.cancel();
    } catch {
      // Session teardown is best effort; nothing to report upward.
    }
  }

  private requireInitialized(): void {
    if (!this.initializedFlag)
      throw new McpProtocolError(
        `initialize() must complete before using the MCP server "${this.config.label}".`,
      );
  }

  private serverInfoFrom(result: unknown, who: string): McpServerInfo {
    if (!isRecord(result))
      throw new McpProtocolError(`${who} returned no result object for initialize.`);
    if (typeof result.protocolVersion !== "string")
      throw new McpProtocolError(
        `${who} omitted protocolVersion in its initialize result.`,
      );
    const serverInfo = isRecord(result.serverInfo) ? result.serverInfo : {};
    return {
      protocolVersion: result.protocolVersion,
      serverName:
        typeof serverInfo.name === "string" ? serverInfo.name : "unknown",
      serverVersion:
        typeof serverInfo.version === "string"
          ? serverInfo.version
          : "unknown",
      capabilities: isRecord(result.capabilities) ? result.capabilities : {},
    };
  }

  /** Sends the initialized notification without failing the handshake; a
   * dropped notification surfaces honestly as the next request's failure. */
  private finalizeInitialization(signal: AbortSignal): void {
    this.initializedFlag = true;
    const target = this.messageEndpoint
      ? new URL(this.messageEndpoint)
      : new URL(this.config.url);
    const pair = this.normalizeSignal(signal);
    void this.postRpc(
      target,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      pair.signal,
    )
      .then(() => undefined)
      .catch(() => undefined)
      .finally(pair.cleanup);
  }

  /** Timeout + cancellation normalization; always disposes an owned session
   * when the effective signal aborts. */
  private normalizeSignal(signal: AbortSignal): SignalPair {
    let effective = signal;
    if (this.config.timeoutMs !== undefined) {
      const controller = new AbortController();
      const timer = AbortSignal.timeout(this.config.timeoutMs);
      signal.addEventListener(
        "abort",
        () => controller.abort(signal.reason),
        { once: true },
      );
      timer.addEventListener(
        "abort",
        () => controller.abort(timer.reason),
        { once: true },
      );
      effective = controller.signal;
    }
    const onAbort = () =>
      queueMicrotask(() => void this.dispose().catch(() => undefined));
    effective.addEventListener("abort", onAbort, { once: true });
    return {
      signal: effective,
      cleanup: () => effective.removeEventListener("abort", onAbort),
    };
  }

  /** Headers for one request: configured headers ONLY while the effective
   * URL keeps the configured origin (origin-locked secret policy), plus the
   * session id once one has been issued. */
  private baseHeaders(effectiveSameOrigin: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (effectiveSameOrigin && this.config.headers) {
      for (const [name, value] of Object.entries(this.config.headers))
        headers[name] = value;
    }
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }

  /** One JSON-RPC POST with manual redirects, content negotiation, and the
   * origin-locked header policy. Cross-origin redirects are refused without
   * ever contacting the foreign origin. */
  private async postRpc(
    initialTarget: URL,
    request: RpcRequest,
    callerSignal: AbortSignal,
  ): Promise<JsonRpcEnvelope> {
    const baseOrigin = new URL(this.config.url).origin;
    const pair = this.normalizeSignal(callerSignal);
    let target = initialTarget;
    try {
      for (let hop = 0; ; hop += 1) {
        const headers = this.baseHeaders(target.origin === baseOrigin);
        headers["Accept"] = "application/json, text/event-stream";
        headers["Content-Type"] = "application/json";
        let response: Response;
        try {
          response = await this.fetchImpl(target.href, {
            method: "POST",
            headers,
            redirect: "manual",
            signal: pair.signal,
            body: JSON.stringify(request),
          });
        } catch (cause) {
          throw this.classifyFailure(cause, pair.signal);
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          const location = response.headers.get("location");
          if (!location)
            throw new McpProtocolError(
              `MCP server "${this.config.label}" answered ${response.status} without a Location header.`,
            );
          const next = new URL(location, target);
          if (next.origin !== baseOrigin)
            throw new McpProtocolError(
              `Refused a cross-origin redirect from MCP server "${this.config.label}" ` +
                `(${target.origin} -> ${next.origin}); configured credentials were not sent.`,
            );
          if (hop >= MAX_REDIRECT_HOPS)
            throw new McpProtocolError(
              `MCP server "${this.config.label}" exceeded ${MAX_REDIRECT_HOPS} same-origin redirect hops.`,
            );
          target = next;
          continue;
        }
        if (response.status === 401 || response.status === 403)
          throw new McpAuthError(
            `MCP server "${this.config.label}" rejected the request with HTTP ${response.status}.`,
          );
        const issued = response.headers.get("mcp-session-id");
        if (issued) this.sessionId = issued;
        if (request.id === undefined) {
          await response.text();
          if (response.status >= 400)
            throw new McpProtocolError(
              `MCP server "${this.config.label}" answered HTTP ${response.status} to the initialized notification.`,
            );
          return {};
        }
        return await this.readEnvelope(response, request.id, pair.signal);
      }
    } finally {
      pair.cleanup();
    }
  }

  private async readEnvelope(
    response: Response,
    expectedId: number,
    signal: AbortSignal,
  ): Promise<JsonRpcEnvelope> {
    const contentType = (
      (response.headers.get("content-type") ?? "").split(";", 1)[0] ?? ""
    )
      .trim()
      .toLowerCase();
    let envelope: unknown;
    if (contentType === "application/json") {
      const text = await response.text();
      try {
        envelope = JSON.parse(text);
      } catch {
        throw new McpProtocolError(
          `MCP server "${this.config.label}" answered with invalid JSON.`,
        );
      }
    } else if (contentType === "text/event-stream") {
      for await (const frame of this.readEventStreamFrames(response, signal)) {
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5))
          .join("\n");
        if (!data) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (isRecord(parsed) && parsed.jsonrpc === "2.0") {
          envelope = parsed;
          break;
        }
      }
    } else {
      throw new McpUnsupportedTransportError(
        `POST answered content type "${contentType || "none"}"; ${TRANSPORT_SUMMARY}`,
      );
    }
    if (!isRecord(envelope) || envelope.jsonrpc !== "2.0")
      throw new McpProtocolError(
        `MCP server "${this.config.label}" closed the response without a JSON-RPC answer to request ${expectedId}.`,
      );
    if (envelope.id !== expectedId)
      throw new McpProtocolError(
        `MCP server "${this.config.label}" answered request ${expectedId} with a mismatched response id.`,
      );
    if (isRecord(envelope.error)) {
      const error = envelope.error;
      throw new McpProtocolError(
        `MCP server "${this.config.label}" reported a JSON-RPC error: ${
          typeof error.message === "string"
            ? error.message
            : "no message given"
        }.`,
      );
    }
    const result: JsonRpcEnvelope = {};
    if ("result" in envelope) result.result = envelope.result;
    return result;
  }

  /** Splits an event-stream body into frames, abort-cancelling the reader. */
  private async *readEventStreamFrames(
    response: Response,
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    const body = response.body;
    if (!body) return;
    const onAbort = () => void body.cancel().catch(() => undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const chunk = await this.readStreamChunk(reader, signal);
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary === -1) break;
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          yield frame.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
  }

  private async readStreamChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
  ): Promise<StreamChunk> {
    try {
      const read = await reader.read();
      if (read.done) return { done: true };
      return { done: false, value: read.value };
    } catch (cause) {
      if (signal.aborted) {
        const error = new Error("The MCP request was canceled.");
        error.name = "AbortError";
        throw error;
      }
      throw cause;
    }
  }

  /** Legacy SSE discovery: GET with Accept: text/event-stream, read the
   * first `event: endpoint` frame, resolve its data line against the server
   * URL. The stream is then closed; later requests POST to the endpoint
   * without opening any extra SSE stream. */
  private async discoverLegacySse(signal: AbortSignal): Promise<{
    serverInfo: McpServerInfo;
    messageEndpoint: string;
  }> {
    const baseOrigin = new URL(this.config.url).origin;
    const pair = this.normalizeSignal(signal);
    try {
      let endpoint: string | undefined;
      let target = new URL(this.config.url);
      let frames: AsyncGenerator<string> | undefined;
      try {
        for (let hop = 0; ; hop += 1) {
          const response = await this.fetchImpl(target.href, {
            method: "GET",
            headers: { ...this.baseHeaders(true), Accept: "text/event-stream" },
            redirect: "manual",
            signal: pair.signal,
          });
          if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            const location = response.headers.get("location");
            if (!location)
              throw new McpProtocolError(
                `MCP server "${this.config.label}" answered the SSE probe with ${response.status} and no Location header.`,
              );
            const next = new URL(location, target);
            if (next.origin !== baseOrigin)
              throw new McpProtocolError(
                `Refused a cross-origin redirect from MCP server "${this.config.label}" ` +
                  `(${target.origin} -> ${next.origin}); configured credentials were not sent.`,
              );
            if (hop >= MAX_REDIRECT_HOPS)
              throw new McpProtocolError(
                `MCP server "${this.config.label}" exceeded ${MAX_REDIRECT_HOPS} same-origin redirect hops.`,
              );
            target = next;
            continue;
          }
          if (response.status === 401 || response.status === 403)
            throw new McpAuthError(
              `MCP server "${this.config.label}" rejected the SSE probe with HTTP ${response.status}.`,
            );
          if (response.status >= 400)
            throw new McpUnsupportedTransportError(
              `GET answered HTTP ${response.status}; ${TRANSPORT_SUMMARY}`,
            );
          if (!response.body)
            throw new McpUnsupportedTransportError(
              `GET answered an empty SSE body; ${TRANSPORT_SUMMARY}`,
            );
          frames = this.readEventStreamFrames(response, pair.signal);
          break;
        }
        for await (const frame of frames) {
          const lines = frame.split("\n");
          const event =
            lines
              .filter((line) => line.startsWith("event:"))
              .map((line) => line.slice(6).trim())[0] ?? "";
          if (event !== "endpoint") continue;
          endpoint =
            lines
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())[0] ?? "";
          break;
        }
      } catch (cause) {
        throw this.classifyFailure(cause, pair.signal);
      }
      if (endpoint === undefined)
        throw new McpUnsupportedTransportError(
          `GET event stream offered no "endpoint" event; ${TRANSPORT_SUMMARY}`,
        );
      const messageEndpoint = new URL(endpoint, this.config.url);
      if (messageEndpoint.origin !== baseOrigin)
        throw new McpProtocolError(
          `Legacy SSE endpoint "${messageEndpoint.origin}" of MCP server "${this.config.label}" is on a foreign origin.`,
        );
      const envelope = await this.postRpc(
        messageEndpoint,
        {
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "LocalLab", version: "0.1.0" },
          },
        },
        pair.signal,
      );
      const serverInfo = this.serverInfoFrom(
        envelope.result,
        `Legacy SSE MCP server "${this.config.label}"`,
      );
      return { serverInfo, messageEndpoint: messageEndpoint.href };
    } finally {
      pair.cleanup();
    }
  }

  /** Normalizes low-level fetch/stream failures: cancellations surface as
   * AbortError (McpTimeoutError when the configured timeout won),
   * unreachable servers as McpOfflineError, and typed MCP errors pass
   * through untouched. */
  private classifyFailure(cause: unknown, signal: AbortSignal): Error {
    if (
      cause instanceof McpProtocolError ||
      cause instanceof McpAuthError ||
      cause instanceof McpUnsupportedTransportError ||
      cause instanceof McpTimeoutError
    )
      return cause;
    if (signal.aborted) {
      const reason: unknown = signal.reason;
      if (reason instanceof Error && reason.name === "TimeoutError")
        return new McpTimeoutError(
          `The request to MCP server "${this.config.label}" exceeded ${this.config.timeoutMs} ms.`,
        );
      const error = new Error("The MCP request was canceled.");
      error.name = "AbortError";
      return error;
    }
    if (
      (cause instanceof Error || cause instanceof DOMException) &&
      cause.name === "AbortError"
    ) {
      const error = new Error("The MCP request was canceled.");
      error.name = "AbortError";
      return error;
    }
    return new McpOfflineError(
      `Could not reach MCP server "${this.config.label}": ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}
