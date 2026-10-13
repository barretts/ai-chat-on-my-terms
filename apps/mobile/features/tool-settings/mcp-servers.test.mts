import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import type { SecureValuePort } from "@locallab/security-secrets";
import { HostScopedSecretStore } from "@locallab/security-secrets";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import {
  SQLiteMcpServerStore,
  collectMcpTools,
  resolveMcpHeaders,
  validateMcpUrl,
} from "./mcp-servers";
import type { McpServerRow } from "./mcp-servers";

function memorySqlite(): SQLiteDatabasePort {
  const database = new DatabaseSync(":memory:");
  return {
    execAsync: async (sql) => {
      database.exec(sql);
    },
    runAsync: async (sql, ...values) => {
      database.prepare(sql).run(...values);
    },
    getFirstAsync: async <T,>(
      sql: string,
      ...values: (string | number | null | Uint8Array)[]
    ) => (database.prepare(sql).get(...values) as T) ?? null,
    getAllAsync: async <T,>(
      sql: string,
      ...values: (string | number | null | Uint8Array)[]
    ) => (database.prepare(sql).all(...values) as T[]),
    withTransactionAsync: async (work) => {
      await work();
    },
  };
}

function memorySecrets(): SecureValuePort {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
}

const sampleId = "00000000-0000-4000-8000-000000000001";

it("saves, reloads and removes MCP server rows", async () => {
  const store = new SQLiteMcpServerStore(memorySqlite());
  expect(await store.load()).toEqual([]);
  await store.save({
    id: sampleId,
    label: "Local tools",
    url: "http://127.0.0.1:39111/mcp",
    enabled: true,
    toolEnabled: { echo: true },
  });
  expect(await new SQLiteMcpServerStore(memorySqlite()).load()).toEqual([]);
  const rows = await store.load();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: sampleId,
    label: "Local tools",
    enabled: true,
    toolEnabled: { echo: true },
  });
  await store.remove(sampleId);
  expect(await store.load()).toEqual([]);
});

it("rejects malformed rows and addresses honestly", async () => {
  const store = new SQLiteMcpServerStore(memorySqlite());
  const base = {
    id: sampleId,
    label: "Server",
    enabled: false,
    toolEnabled: {},
  };
  await expect(
    store.save({ ...base, url: "not a url" }),
  ).rejects.toThrow("Enter a complete http or https MCP server address.");
  await expect(
    store.save({ ...base, url: "ftp://127.0.0.1/mcp" }),
  ).rejects.toThrow("http or https");
  await expect(
    store.save({ ...base, url: "http://user:pw@127.0.0.1/mcp" }),
  ).rejects.toThrow("key field, not in the server address");
  await expect(
    store.save({ ...base, url: "http://127.0.0.1/mcp", label: "bad\x00name" }),
  ).rejects.toThrow("plain server name");
  await expect(
    store.save({
      ...base,
      url: "http://127.0.0.1/mcp",
      toolEnabled: { "9bad name!": true },
    }),
  ).rejects.toThrow("tool name is invalid");
  expect(() => validateMcpUrl("https://host.example/mcp")).not.toThrow();
});

it("resolves the stored key only against the configured origin", async () => {
  const secrets = new HostScopedSecretStore(memorySecrets(), "mcp-test");
  const saved = await secrets.put(
    "http://127.0.0.1:39111",
    "authorization",
    "Bearer tok",
  );
  const row: McpServerRow = {
    id: sampleId,
    label: "Server",
    url: "http://127.0.0.1:39111/mcp",
    authRef: saved.ref,
    enabled: true,
    toolEnabled: {},
  };
  expect(await resolveMcpHeaders(secrets, row)).toEqual({
    authorization: "Bearer tok",
  });
  await expect(
    resolveMcpHeaders(secrets, {
      ...row,
      url: "http://127.0.0.1:39999/mcp",
    }),
  ).rejects.toThrow("different server");
  expect(
    await resolveMcpHeaders(secrets, { ...row, authRef: undefined }),
  ).toEqual({});
});

// A minimal JSON-RPC MCP fixture with an observable request log.
interface Fixture {
  origin: string;
  requests: string[];
  close(): Promise<void>;
}

async function startFixture(authHeader: string | null): Promise<Fixture> {
  const requests: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push(req.url ?? "");
      if (authHeader !== null && req.headers.authorization !== authHeader) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const body: { jsonrpc?: string; id?: number; method?: string } =
        JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const respond = (value: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 0, result: value }),
        );
      };
      if (body.method === "initialize")
        return respond({
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" },
        });
      if (body.method === "notifications/initialized") {
        res.writeHead(202);
        return res.end();
      }
      if (body.method === "tools/list")
        return respond({
          tools: [
            {
              name: "echo",
              description: "Echoes text back.",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          ],
        });
      if (body.method === "tools/call")
        return respond({
          content: [{ type: "text", text: "echoed" }],
          isError: false,
        });
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 0, error: { code: -32601, message: "unknown method" } }));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture did not bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((cause) => (cause ? reject(cause) : resolve())),
      ),
  };
}

it("makes zero calls for disabled servers and keeps discovery non-automatic", async () => {
  const fixture = await startFixture(null);
  try {
    const store = new SQLiteMcpServerStore(memorySqlite());
    await store.save({
      id: sampleId,
      label: "Fixture",
      url: `${fixture.origin}/mcp`,
      enabled: false,
      toolEnabled: {},
    });
    const secrets = new HostScopedSecretStore(memorySecrets(), "mcp-test");
    const result = await collectMcpTools(
      store,
      secrets,
      new AbortController().signal,
    );
    expect(result.tools).toHaveLength(0);
    expect(result.outcomes).toEqual([]);
    expect(fixture.requests).toEqual([]);
    await store.save({
      id: sampleId,
      label: "Fixture",
      url: `${fixture.origin}/mcp`,
      enabled: true,
      toolEnabled: {},
    });
    const discovered = await collectMcpTools(
      store,
      secrets,
      new AbortController().signal,
    );
    expect(discovered.tools).toHaveLength(0);
    expect(discovered.outcomes[0]).toMatchObject({
      reachable: true,
      discovered: ["echo"],
    });
    await discovered.finalize();
  } finally {
    await fixture.close();
  }
});

it("exposes only explicitly enabled tools and executes them", async () => {
  const fixture = await startFixture(null);
  try {
    const store = new SQLiteMcpServerStore(memorySqlite());
    await store.save({
      id: sampleId,
      label: "Fixture",
      url: `${fixture.origin}/mcp`,
      enabled: true,
      toolEnabled: { echo: true },
    });
    const secrets = new HostScopedSecretStore(memorySecrets(), "mcp-test");
    const result = await collectMcpTools(
      store,
      secrets,
      new AbortController().signal,
    );
    expect(result.tools.map((tool) => tool.name)).toEqual(["echo"]);
    const tool = result.tools[0];
    if (!tool) throw new Error("missing echo tool");
    expect(tool.serverId).toBe(sampleId);
    expect(tool.parameters).toMatchObject({ type: "object" });
    expect(() => tool.parseInput({ nope: 1 })).toThrow();
    const outcome = await tool.execute({ text: "hi" }, {
      invocationId: "i1",
      conversationId: "c1",
      runId: "r1",
      signal: new AbortController().signal,
    });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
    if (outcome.ok) {
      const value = outcome.value as { text?: string };
      expect(value.text).toBe("echoed");
    }
    await result.finalize();
  } finally {
    await fixture.close();
  }
});

it("reports unreachable servers honestly without changing enablement", async () => {
  const store = new SQLiteMcpServerStore(memorySqlite());
  await store.save({
    id: sampleId,
    label: "Gone",
    url: "http://127.0.0.1:39112/mcp",
    enabled: true,
    toolEnabled: { echo: true },
  });
  const secrets = new HostScopedSecretStore(memorySecrets(), "mcp-test");
  const result = await collectMcpTools(
    store,
    secrets,
    new AbortController().signal,
  );
  expect(result.tools).toHaveLength(0);
  expect(result.outcomes).toHaveLength(1);
  expect(result.outcomes[0]?.reachable).toBe(false);
  expect(result.outcomes[0]?.error).toBeTruthy();
  const rows = await store.load();
  expect(rows[0]?.enabled).toBe(true);
});
