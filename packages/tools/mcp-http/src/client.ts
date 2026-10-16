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
/** Ceiling for one SSE frame, with or without its terminating blank line. */
const MAX_SSE_FRAME_CHARS = 4 * 1024 * 1024;
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
  error?: unknown;
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
  private legacyStream: AbortController | undefined;
  private readonly legacyPending = new Map<
    number,
    { resolve(envelope: JsonRpcEnvelope): void; reject(reason: Error): void }
  >();

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
    if (this.legacyStream) {
      const stream = this.legacyStream;
      this.legacyStream = undefined;
      const closed = new McpProtocolError(
        `The MCP server "${this.config.label}" client has been disposed.`,
      );
      for (const pending of this.legacyPending.values())
        pending.reject(closed);
      this.legacyPending.clear();
      stream.abort();
    }
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
    if (this.legacyStream)
      return this.legacyRpc(initialTarget, request, callerSignal);
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
    const reader = body.getReader();
    const onAbort = () => void reader.cancel().catch(() => undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const decoder = new TextDecoder();
    let buffer = "";
    let pendingCarriageReturn = false;
    let streamCompleted = false;
    try {
      for (;;) {
        const chunk = await this.readStreamChunk(reader, signal);
        if (chunk.done) {
          streamCompleted = true;
          break;
        }
        let text = decoder.decode(chunk.value, { stream: true });
        if (text) {
          // CR itself ends a line; suppress its optional LF on the next
          // decoded chunk without postponing a completed event.
          if (pendingCarriageReturn) {
            if (text.startsWith("\n")) text = text.slice(1);
          }
          pendingCarriageReturn = text.endsWith("\r");
          buffer += text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
        }
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if ((boundary === -1 ? buffer.length : boundary) > MAX_SSE_FRAME_CHARS)
            throw new McpProtocolError(
              `MCP server "${this.config.label}" sent an SSE frame exceeding ` +
                `${MAX_SSE_FRAME_CHARS} characters before its blank-line terminator.`,
            );
          if (boundary === -1) break;
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          yield frame;
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (!streamCompleted) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private async readStreamChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
  ): Promise<StreamChunk> {
    try {
      if (signal.aborted) throw new Error("The MCP request was canceled.");
      const read = await reader.read();
      if (signal.aborted) throw new Error("The MCP request was canceled.");
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
   * URL. Keep this stream open to dispatch replies to later POSTs. */
  private async discoverLegacySse(signal: AbortSignal): Promise<{
    serverInfo: McpServerInfo;
    messageEndpoint: string;
  }> {
    const baseOrigin = new URL(this.config.url).origin;
    const pair = this.normalizeSignal(signal);
    const streamController = new AbortController();
    const abortDiscovery = () => streamController.abort();
    pair.signal.addEventListener("abort", abortDiscovery, { once: true });
    if (pair.signal.aborted) abortDiscovery();
    let connected = false;
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
          frames = this.readEventStreamFrames(
            response,
            streamController.signal,
          );
          break;
        }
        for (;;) {
          const next = await frames.next();
          if (next.done) break;
          const lines = next.value.split("\n");
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
      if (endpoint === undefined) {
        streamController.abort();
        throw new McpUnsupportedTransportError(
          `GET event stream offered no "endpoint" event; ${TRANSPORT_SUMMARY}`,
        );
      }
      const messageEndpoint = new URL(endpoint, this.config.url);
      if (messageEndpoint.origin !== baseOrigin) {
        streamController.abort();
        throw new McpProtocolError(
          `Legacy SSE endpoint "${messageEndpoint.origin}" of MCP server "${this.config.label}" is on a foreign origin.`,
        );
      }
      // A spec-compliant legacy server answers every POST with an empty
      // acceptance (typically 202) and sends JSON-RPC replies as `message`
      // events on this still-open GET stream. Keep consuming it for the
      // whole session and dispatch replies by JSON-RPC id; POST responses
      // are treated purely as message acceptance from here on.
      this.legacyStream = streamController;
      this.consumeLegacyFrames(frames);
      const envelope = await this.legacyRpc(
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
      connected = true;
      return { serverInfo, messageEndpoint: messageEndpoint.href };
    } finally {
      pair.signal.removeEventListener("abort", abortDiscovery);
      if (!connected) streamController.abort();
      pair.cleanup();
    }
  }

  /** Runs one request over the legacy transport: POST is acceptance-only,
   * the JSON-RPC reply arrives on the kept-open GET stream and is awaited
   * through the pending map. Cancellation, timeout and stream closure all
   * settle the pending entry; a dropped stream never hangs a caller. */
  private async legacyRpc(
    endpoint: URL,
    request: RpcRequest,
    callerSignal: AbortSignal,
  ): Promise<JsonRpcEnvelope> {
    const pair = this.normalizeSignal(callerSignal);
    let wait: Promise<JsonRpcEnvelope> | undefined;
    if (request.id !== undefined) {
      const id = request.id;
      wait = new Promise<JsonRpcEnvelope>((resolve, reject) => {
        this.legacyPending.set(id, { resolve, reject });
        pair.signal.addEventListener(
          "abort",
          () => {
            if (!this.legacyPending.delete(id)) return;
            reject(this.classifyFailure(new Error("canceled"), pair.signal));
          },
          { once: true },
        );
      });
      wait.catch(() => undefined);
    }
    try {
      await this.postLegacyMessage(endpoint, request, pair.signal);
      if (wait === undefined) return {};
      const envelope = await wait;
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
      return envelope;
    } catch (cause) {
      if (request.id !== undefined) {
        const pending = this.legacyPending.get(request.id);
        if (pending) {
          this.legacyPending.delete(request.id);
          pending.reject(
            cause instanceof Error ? cause : new Error(String(cause)),
          );
        }
      }
      throw cause;
    } finally {
      pair.cleanup();
    }
  }

  /** POSTs one message to the legacy endpoint and treats the HTTP answer
   * strictly as a delivery receipt: any non-error status is acceptance and
   * its body is discarded. Redirect and origin policy match postRpc. */
  private async postLegacyMessage(
    initialTarget: URL,
    request: RpcRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const baseOrigin = new URL(this.config.url).origin;
    let target = initialTarget;
    for (let hop = 0; ; hop += 1) {
      const headers = this.baseHeaders(target.origin === baseOrigin);
      headers["Accept"] = "application/json";
      headers["Content-Type"] = "application/json";
      let response: Response;
      try {
        response = await this.fetchImpl(target.href, {
          method: "POST",
          headers,
          redirect: "manual",
          signal,
          body: JSON.stringify(request),
        });
      } catch (cause) {
        throw this.classifyFailure(cause, signal);
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
      if (response.status >= 400)
        throw new McpProtocolError(
          `MCP server "${this.config.label}" answered HTTP ${response.status} to the legacy SSE message POST.`,
        );
      await response.body?.cancel();
      return;
    }
  }

  /** Consumes the kept-open legacy GET stream for the whole session,
   * resolving pending JSON-RPC replies by id. When the stream closes or
   * dies, every pending request settles with an honest error instead of
   * hanging. */
  private consumeLegacyFrames(
    frames: AsyncGenerator<string>,
  ): void {
    void (async () => {
      try {
        for (;;) {
          const next = await frames.next();
          if (next.done) break;
          const lines = next.value.split("\n");
          const event =
            lines
              .filter((line) => line.startsWith("event:"))
              .map((line) => line.slice(6).trim())[0] ?? "message";
          if (event !== "message") continue;
          const data = lines
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
          if (
            !isRecord(parsed) ||
            parsed.jsonrpc !== "2.0" ||
            typeof parsed.id !== "number"
          )
            continue;
          const pending = this.legacyPending.get(parsed.id);
          if (!pending) continue;
          this.legacyPending.delete(parsed.id);
          pending.resolve(parsed as JsonRpcEnvelope);
        }
      } catch {
        // The stream died; the same settlement below applies.
      }
      const failure = new McpProtocolError(
        `The legacy SSE reply stream of MCP server "${this.config.label}" ` +
          "closed before answering the pending request(s).",
      );
      for (const pending of this.legacyPending.values()) pending.reject(failure);
      this.legacyPending.clear();
    })();
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
