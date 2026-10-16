import http from "node:http";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  McpAuthError,
  McpHttpClient,
  McpOfflineError,
  McpProtocolError,
  McpUnsupportedTransportError,
  createMcpTools,
  mcpErrorResult,
} from "../src/index";

type FixtureHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void;

interface Fixture {
  origin: string;
  path: string;
  requests: Array<{
    method: string | undefined;
    path: string | undefined;
    authorization: string | null;
    session: string | null;
  }>;
  configUrl(): string;
}

const openResponses = new Set<ServerResponse>();
const servers: http.Server[] = [];

function trackSse(res: ServerResponse): void {
  openResponses.add(res);
  res.once("close", () => openResponses.delete(res));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function startFixture(
  path: string,
  handler: FixtureHandler,
): Promise<Fixture> {
  const fixture: Fixture = {
    origin: "",
    path,
    requests: [],
    configUrl: () => `${fixture.origin}${fixture.path}`,
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const session = req.headers["mcp-session-id"];
    fixture.requests.push({
      method: req.method,
      path: url.pathname,
      authorization: req.headers.authorization ?? null,
      session: typeof session === "string" ? session : null,
    });
    if (req.method === "POST" || req.method === "PUT") {
      void readBody(req).then((body) => handler(req, res, body));
    } else {
      handler(req, res, "");
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture server did not bind an ephemeral port");
  fixture.origin = `http://127.0.0.1:${address.port}`;
  return fixture;
}

/** Port of a server that was open and then fully closed, so connecting to it
 * is refused (used for the offline test). */
async function closedFixturePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture server did not bind an ephemeral port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface McpFixtureOptions {
  respond?: "json" | "sse";
  tools?: unknown[];
  callResult?: Record<string, unknown>;
  callKeepsOpen?: boolean;
  toolsListKeepsOpen?: boolean;
}

interface McpFixture extends Fixture {
  deletes: number;
  initializedNotifications: number;
  deleted: Promise<void>;
  sawCall: Promise<void>;
  sawToolsList: Promise<void>;
}

/** Minimal in-test MCP server: initialize / initialized / tools/list /
 * tools/call, echoing Mcp-Session-Id. */
async function startMcpFixture(
  options: McpFixtureOptions = {},
): Promise<McpFixture> {
  let resolveDeleted: () => void = () => undefined;
  let resolveSawCall: () => void = () => undefined;
  let resolveSawToolsList: () => void = () => undefined;
  const fixture = (await startFixture(
    "/mcp",
    (req, res, body) => {
      if (req.url && !req.url.startsWith("/mcp")) {
        res.writeHead(307, { location: "/mcp" }).end();
        return;
      }
      if (req.method === "GET") {
        res.writeHead(405).end();
        return;
      }
      if (req.method === "DELETE") {
        fixture.deletes += 1;
        res.writeHead(204).end();
        resolveDeleted();
        return;
      }
      let message: {
        id?: number;
        method?: string;
        params?: { name?: string };
      };
      try {
        message = JSON.parse(body) as typeof message;
      } catch {
        res.writeHead(400).end();
        return;
      }
      const headers: Record<string, string> = { "mcp-session-id": "sess-1" };
      const answer = (result: unknown): void => {
        const payload = JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result,
        });
        if (options.respond === "sse") {
          headers["content-type"] = "text/event-stream";
          res.writeHead(200, headers);
          res.write(": keepalive comment\n\n");
          res.write(`event: message\ndata: ${payload}\n\n`);
          res.end();
        } else {
          headers["content-type"] = "application/json";
          res.writeHead(200, headers).end(payload);
        }
      };
      switch (message.method) {
        case "initialize":
          answer({
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture-mcp", version: "1.2.3" },
          });
          break;
        case "notifications/initialized":
          fixture.initializedNotifications += 1;
          res.writeHead(202).end();
          break;
        case "tools/list":
          if (options.toolsListKeepsOpen) {
            resolveSawToolsList();
            trackSse(res);
            return;
          }
          answer({ tools: options.tools ?? [] });
          break;
        case "tools/call": {
          if (options.callKeepsOpen) {
            resolveSawCall();
            trackSse(res);
            return;
          }
          answer(options.callResult ?? { content: [{ type: "text", text: "pong" }] });
          break;
        }
        default:
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32601, message: "method not found" },
              }),
            );
      }
    },
  )) as McpFixture;
  fixture.deletes = 0;
  fixture.initializedNotifications = 0;
  fixture.deleted = new Promise<void>((resolve) => {
    resolveDeleted = resolve;
  });
  fixture.sawCall = new Promise<void>((resolve) => {
    resolveSawCall = resolve;
  });
  fixture.sawToolsList = new Promise<void>((resolve) => {
    resolveSawToolsList = resolve;
  });
  return fixture;
}

afterEach(() => {
  for (const res of openResponses) res.destroy();
  openResponses.clear();
});

afterAll(async () => {
  for (const server of servers) server.close();
  await new Promise<void>((resolve) => {
    let remaining = servers.length;
    if (remaining === 0) resolve();
    for (const server of servers)
      server.close(() => {
        remaining -= 1;
        if (remaining <= 0) resolve();
      });
  });
  servers.length = 0;
});

function config(
  fixture: Fixture | McpFixture,
  headers?: Record<string, string>,
): { id: string; label: string; url: string; headers?: Record<string, string> } {
  const base = {
    id: "0193f2a0-1234-7abc-8def-000000000009",
    label: "fixture server",
    url: fixture.configUrl(),
  };
  return headers ? { ...base, headers } : base;
}

describe("streamable HTTP transport", () => {
  it("discovers and calls tools, echoing the issued session id", async () => {
    const fixture = await startMcpFixture({
      tools: [
        {
          name: "echo",
          description: "Echoes text back",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      ],
      callResult: {
        content: [{ type: "text", text: "echo: hello" }],
        structuredContent: { echoed: "hello" },
      },
    });
    const client = new McpHttpClient(
      config(fixture, { authorization: "Bearer test-secret" }),
    );
    const info = await client.initialize(new AbortController().signal);
    expect(info).toEqual({
      protocolVersion: "2025-03-26",
      serverName: "fixture-mcp",
      serverVersion: "1.2.3",
      capabilities: { tools: {} },
    });
    const discovery = await client.discoverTools(new AbortController().signal);
    expect(discovery.errors).toEqual([]);
    expect(discovery.tools[0]?.name).toBe("echo");
    const call = await client.callTool(
      "echo",
      { message: "hello" },
      new AbortController().signal,
    );
    expect(call.content[0]?.text).toBe("echo: hello");
    expect(call.structuredContent).toEqual({ echoed: "hello" });
    const posts = fixture.requests.filter((entry) => entry.method === "POST");
    expect(posts[0]?.authorization).toBe("Bearer test-secret");
    expect(posts[0]?.session).toBeNull();
    for (const entry of posts.slice(1)) {
      expect(entry.authorization).toBe("Bearer test-secret");
      expect(entry.session).toBe("sess-1");
    }
    expect(fixture.initializedNotifications).toBe(1);
    await client.dispose();
    expect(fixture.deletes).toBe(1);
  });

  it("parses JSON-RPC answers framed in an event stream", async () => {
    const fixture = await startMcpFixture({
      respond: "sse",
      tools: [{ name: "ping", inputSchema: {} }],
      callResult: { content: [{ type: "text", text: "pong" }] },
    });
    const client = new McpHttpClient(config(fixture));
    const info = await client.initialize(new AbortController().signal);
    expect(info.serverName).toBe("fixture-mcp");
    const call = await client.callTool(
      "ping",
      {},
      new AbortController().signal,
    );
    expect(call.content[0]?.text).toBe("pong");
  });
});

describe("legacy SSE fallback", () => {
  /** Spec-compliant legacy server: every POST is answered with an empty
   * 202 acceptance and JSON-RPC replies are written as `message` events on
   * the still-open GET stream, keyed by request id. */
  async function startLegacyServer(
    newline = "\n",
  ): Promise<Fixture & { closeStream(): void }> {
    let stream: ServerResponse | undefined;
    let heldSlow: (() => void) | undefined;
    let heldFast: (() => void) | undefined;
    const fixture = await startFixture("/legacy", (req, res, body) => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `event: endpoint${newline}data: /legacy/messages?sid=77${newline}${newline}`,
        );
        trackSse(res);
        stream = res;
        return;
      }
      if (!req.url?.startsWith("/legacy/messages")) {
        res.writeHead(405).end();
        return;
      }
      res.writeHead(202).end();
      const message = JSON.parse(body) as {
        id?: number;
        method?: string;
        params?: { arguments?: { tag?: string } };
      };
      const reply = (result: unknown): void => {
        stream?.write(
          `event: message${newline}data: ${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result,
          })}${newline}${newline}`,
        );
      };
      switch (message.method) {
        case "initialize":
          reply({
            protocolVersion: "2024-11-05",
            capabilities: {},
            serverInfo: { name: "legacy-fixture", version: "0.4" },
          });
          break;
        case "tools/list":
          reply({ tools: [{ name: "legacy_tool", inputSchema: {} }] });
          break;
        case "tools/call": {
          const tag = message.params?.arguments?.tag ?? "?";
          const frame = { content: [{ type: "text", text: `pong:${tag}` }] };
          if (tag !== "slow" && tag !== "fast") {
            reply(frame);
            break;
          }
          // Deterministic out-of-order delivery: buffer the two tagged
          // calls and emit the fast-id reply before the slow-id reply
          // regardless of the order their POSTs arrive in.
          const thunk = (): void => reply(frame);
          if (tag === "slow") heldSlow = thunk;
          else heldFast = thunk;
          if (heldSlow && heldFast) {
            const fast = heldFast;
            const slow = heldSlow;
            heldSlow = undefined;
            heldFast = undefined;
            fast();
            slow();
          }
          break;
        }
        default:
          break;
      }
    });
    return { ...fixture, closeStream: () => stream?.end() };
  }

  it("answers the initialize handshake on the kept-open GET stream", async () => {
    const fixture = await startLegacyServer();
    const client = new McpHttpClient(
      config({ ...fixture, configUrl: () => `${fixture.origin}/legacy` }),
    );
    const info = await client.initialize(new AbortController().signal);
    expect(info.serverName).toBe("legacy-fixture");
    const discovery = await client.discoverTools(new AbortController().signal);
    expect(discovery.tools[0]?.name).toBe("legacy_tool");
    const call = await client.callTool(
      "legacy_tool",
      { tag: "ping" },
      new AbortController().signal,
    );
    expect(call.content[0]?.text).toBe("pong:ping");
    const gets = fixture.requests.filter(
      (entry) => entry.method === "GET" && entry.path === "/legacy",
    );
    expect(gets.length).toBe(1);
    const posts = fixture.requests.filter(
      (entry) => entry.method === "POST" && entry.path === "/legacy/messages",
    );
    expect(posts.length).toBe(4);
  });

  it("matches concurrent requests by id when replies arrive out of order", async () => {
    const fixture = await startLegacyServer();
    const client = new McpHttpClient(
      config({ ...fixture, configUrl: () => `${fixture.origin}/legacy` }),
    );
    await client.initialize(new AbortController().signal);
    const slow = client.callTool(
      "slow_tool",
      { tag: "slow" },
      new AbortController().signal,
    );
    const fast = client.callTool(
      "legacy_tool",
      { tag: "fast" },
      new AbortController().signal,
    );
    const [slowCall, fastCall] = await Promise.all([slow, fast]);
    expect(slowCall.content[0]?.text).toBe("pong:slow");
    expect(fastCall.content[0]?.text).toBe("pong:fast");
  });

  it("settles pending requests when the reply stream dies instead of hanging", async () => {
    const fixture = await startLegacyServer();
    const client = new McpHttpClient(
      config({ ...fixture, configUrl: () => `${fixture.origin}/legacy` }),
    );
    await client.initialize(new AbortController().signal);
    const call = await client.callTool(
      "legacy_tool",
      { tag: "first" },
      new AbortController().signal,
    );
    expect(call.content[0]?.text).toBe("pong:first");
    fixture.closeStream();
    await expect(
      client.callTool("legacy_tool", { tag: "second" }, new AbortController().signal),
    ).rejects.toThrow(/closed before answering|answered HTTP/);
  });

  it("frames CRLF-delimited endpoint events and replies identically", async () => {
    const fixture = await startLegacyServer("\r\n");
    const client = new McpHttpClient(
      config({ ...fixture, configUrl: () => `${fixture.origin}/legacy` }),
    );
    const info = await client.initialize(new AbortController().signal);
    expect(info.serverName).toBe("legacy-fixture");
    const discovery = await client.discoverTools(new AbortController().signal);
    expect(discovery.tools[0]?.name).toBe("legacy_tool");
    const call = await client.callTool(
      "legacy_tool",
      { tag: "crlf" },
      new AbortController().signal,
    );
    expect(call.content[0]?.text).toBe("pong:crlf");
  });
});

describe("honest transport failures", () => {
  it("refuses servers answering with an unsupported content type", async () => {
    const fixture = await startFixture("/html", (req, res) => {
      if (req.method === "GET") {
        res.writeHead(405, { "content-type": "text/html" }).end("<b>no</b>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end("<b>not mcp</b>");
    });
    const client = new McpHttpClient(config(fixture));
    try {
      await client.initialize(new AbortController().signal);
      expect.unreachable("the server speaks HTML, not MCP");
    } catch (cause) {
      if (!(cause instanceof McpUnsupportedTransportError)) throw cause;
      expect(cause.explanation).toContain("text/html");
      expect(cause.explanation).toContain("GET answered HTTP 405");
      expect(cause.explanation).toContain("supported transports");
    }
  });

  it("classifies 401/403 as authentication failures", async () => {
    const fixture = await startFixture("/deny", (_req, res) => {
      res.writeHead(401, { "content-type": "text/plain" }).end("no token");
    });
    const client = new McpHttpClient(config(fixture));
    try {
      await client.initialize(new AbortController().signal);
      expect.unreachable("the fixture always answers 401");
    } catch (cause) {
      if (!(cause instanceof McpAuthError)) throw cause;
      expect(mcpErrorResult(cause).error.code).toBe("auth");
    }
  });

  it("classifies an unreachable server as offline", async () => {
    const port = await closedFixturePort();
    const client = new McpHttpClient({
      id: "0193f2a0-1234-7abc-8def-000000000010",
      label: "closed server",
      url: `http://127.0.0.1:${port}/mcp`,
    });
    try {
      await client.initialize(new AbortController().signal);
      expect.unreachable("nothing listens on the closed port");
    } catch (cause) {
      if (!(cause instanceof McpOfflineError)) throw cause;
      const mapped = mcpErrorResult(cause);
      expect(mapped.error.code).toBe("offline");
      expect(mapped.error.recoverable).toBe(true);
    }
  });
});

describe("cancellation", () => {
  it("surfaces AbortError and always disposes the owned session", async () => {
    const fixture = await startMcpFixture({ callKeepsOpen: true });
    const client = new McpHttpClient(config(fixture));
    await client.initialize(new AbortController().signal);
    const controller = new AbortController();
    const pending = client.callTool(
      "slow",
      {},
      controller.signal,
      "progress-1",
    );
    await fixture.sawCall;
    controller.abort();
    try {
      await pending;
      expect.unreachable("the call was aborted");
    } catch (cause) {
      if (!(cause instanceof Error) || cause.name !== "AbortError")
        throw cause;
      expect(mcpErrorResult(cause).error.code).toBe("canceled");
    }
    await fixture.deleted;
    await client.dispose();
    expect(fixture.deletes).toBe(1);
  });
});

describe("createMcpTools registry mapping", () => {
  const toolFixture = async (): Promise<McpFixture> =>
    startMcpFixture({
      tools: [
        {
          name: "echo",
          description: "Echoes text back",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
        { name: "broken tool!", inputSchema: { type: "object" } },
        { name: "wrong-schema", inputSchema: { type: "string" } },
      ],
      callResult: {
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
        structuredContent: { ok: true },
      },
    });

  it("excludes invalid tools and reports each rejection honestly", async () => {
    const fixture = await toolFixture();
    const client = new McpHttpClient(config(fixture));
    await client.initialize(new AbortController().signal);
    const discovery = await client.discoverTools(new AbortController().signal);
    expect(discovery.tools.map((entry) => entry.name)).toEqual(["echo"]);
    expect(discovery.errors).toEqual([
      {
        name: "broken tool!",
        reason:
          "the remote tool name is not a valid tool engine registry name",
      },
      {
        name: "wrong-schema",
        reason: 'inputSchema must describe an object (type "object")',
      },
    ]);
  });

  it("keeps the remote name and never renames through labels", async () => {
    const fixture = await toolFixture();
    const client = new McpHttpClient(config(fixture));
    const tools = await createMcpTools(client, {
      labels: { echo: "Mirror" },
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("echo");
    expect(tools[0]?.serverId).toBe("0193f2a0-1234-7abc-8def-000000000009");
    expect(tools[0]?.description).toBe("Echoes text back");
  });

  it("validates arguments one level deep and allows extra properties", async () => {
    const fixture = await toolFixture();
    const client = new McpHttpClient(config(fixture));
    const [tool] = await createMcpTools(client);
    if (!tool) throw new Error("expected the echo tool");
    expect(() => tool.parseInput({})).toThrow(/missing the required property/);
    expect(() => tool.parseInput({ message: 42 })).toThrow(
      /must be of JSON type string/,
    );
    expect(tool.parseInput({ message: "hi", extra: true })).toEqual({
      message: "hi",
      extra: true,
    });
  });

  it("maps results, structuredContent, and isError onto PortResult", async () => {
    const fixture = await toolFixture();
    const client = new McpHttpClient(config(fixture));
    const [tool] = await createMcpTools(client, { serverId: "override-id" });
    if (!tool) throw new Error("expected the echo tool");
    const ok = await tool.execute({ message: "hi" }, {
      invocationId: "0193f2a0-1234-7abc-8def-000000000001",
      conversationId: "0193f2a0-1234-7abc-8def-000000000002",
      runId: "0193f2a0-1234-7abc-8def-000000000003",
      signal: new AbortController().signal,
    });
    if (!ok.ok) throw new Error(`expected success, got ${ok.error.message}`);
    expect(ok.value).toEqual({
      text: "first\nsecond",
      structuredContent: { ok: true },
    });
    expect(tool.serverId).toBe("override-id");
    const failureFixture = await startMcpFixture({
      tools: [{ name: "echo" }],
      callResult: {
        isError: true,
        content: [{ type: "text", text: "upstream refused" }],
      },
    });
    const failingClient = new McpHttpClient(config(failureFixture));
    const [failing] = await createMcpTools(failingClient);
    if (!failing) throw new Error("expected the echo tool");
    const failed = await failing.execute({}, {
      invocationId: "0193f2a0-1234-7abc-8def-000000000004",
      conversationId: "0193f2a0-1234-7abc-8def-000000000005",
      runId: "0193f2a0-1234-7abc-8def-000000000006",
      signal: new AbortController().signal,
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("unreachable");
    expect(failed.error.code).toBe("malformed");
    expect(failed.error.message).toBe("upstream refused");
  });

  it("propagates the caller signal: a stalled tools/list is interruptible", async () => {
    // Reproduces the chat-lockup trigger: the server initializes happily and
    // then leaves tools/list open without replying.
    const fixture = await startMcpFixture({ toolsListKeepsOpen: true });
    const client = new McpHttpClient(config(fixture));
    const controller = new AbortController();
    const discovery = createMcpTools(client, { signal: controller.signal });
    await fixture.sawToolsList; // initialize done; tools/list now hanging
    controller.abort();
    await expect(discovery).rejects.toThrow();
    await client.dispose().catch(() => undefined);
  });
});

describe("redirect header policy", () => {
  it("follows same-origin redirects and keeps the session header", async () => {
    const fixture = await startMcpFixture({
      tools: [{ name: "echo", inputSchema: {} }],
    });
    const client = new McpHttpClient(
      config(
        { ...fixture, configUrl: () => `${fixture.origin}/entry` },
        { authorization: "Bearer same-origin-secret" },
      ),
    );
    await client.initialize(new AbortController().signal);
    const discovery = await client.discoverTools(new AbortController().signal);
    expect(discovery.tools[0]?.name).toBe("echo");
    const redirected = fixture.requests.filter(
      (entry) => entry.method === "POST" && entry.path === "/mcp",
    );
    expect(redirected.length).toBeGreaterThan(0);
    expect(redirected[0]?.authorization).toBe("Bearer same-origin-secret");
  });

  it("refuses a cross-origin redirect without contacting the target", async () => {
    const target = await startMcpFixture();
    const source = await startFixture("/leaky", (_req, res) => {
      res
        .writeHead(307, { location: `${target.origin}${target.path}` })
        .end();
    });
    const client = new McpHttpClient(
      config(source, { authorization: "Bearer do-not-leak" }),
    );
    try {
      await client.initialize(new AbortController().signal);
      expect.unreachable("the redirect points at another origin");
    } catch (cause) {
      if (!(cause instanceof McpProtocolError)) throw cause;
      expect(cause.message).toContain("Refused a cross-origin redirect");
    }
    expect(target.requests).toHaveLength(0);
  });
});

describe("SSE framing", () => {
  /** A fetch stub answering every request with one SSE body built from
   * exactly these chunks, exercising parser chunk boundaries directly. */
  function streamFetch(chunks: string[]): typeof globalThis.fetch {
    const encoder = new TextEncoder();
    return (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks)
            controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof globalThis.fetch;
  }

  const framingConfig = {
    id: "0193f2a0-1234-7abc-8def-000000000011",
    label: "framing fixture",
    url: "http://127.0.0.1:1/mcp",
  };
  const initResult = {
    protocolVersion: "2025-03-26",
    capabilities: {},
    serverInfo: { name: "framing-fixture", version: "1.0" },
  };
  const initEnvelope = (id: number): string =>
    JSON.stringify({ jsonrpc: "2.0", id, result: initResult });

  it("frames CRLF boundaries even when split across chunks", async () => {
    const client = new McpHttpClient(framingConfig, {
      fetch: streamFetch([
        `event: message\r`,
        `\ndata: ${initEnvelope(1)}\r`,
        `\n\r\n`,
      ]),
    });
    const info = await client.initialize(new AbortController().signal);
    expect(info.serverName).toBe("framing-fixture");
  });

  it("yields identical envelopes for LF and CRLF framing", async () => {
    const lf = new McpHttpClient(framingConfig, {
      fetch: streamFetch([`event: message\ndata: ${initEnvelope(1)}\n\n`]),
    });
    const crlf = new McpHttpClient(framingConfig, {
      fetch: streamFetch([
        `event: message\r\ndata: ${initEnvelope(1)}\r\n\r\n`,
      ]),
    });
    const lfInfo = await lf.initialize(new AbortController().signal);
    const crlfInfo = await crlf.initialize(new AbortController().signal);
    expect(crlfInfo).toEqual(lfInfo);
    expect(crlfInfo.serverName).toBe("framing-fixture");
  });

  it("refuses an unterminated oversized frame instead of growing forever", async () => {
    const client = new McpHttpClient(framingConfig, {
      fetch: streamFetch([
        "data: " + "x".repeat(4 * 1024 * 1024 + 1024) + "\n",
      ]),
    });
    await expect(
      client.initialize(new AbortController().signal),
    ).rejects.toThrow(/exceeding .* blank-line terminator/);
  });
});
