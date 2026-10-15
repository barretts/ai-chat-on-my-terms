import type { RegisteredTool } from "@locallab/tools-engine";
import {
  McpHttpClient,
  createMcpTools,
  mcpErrorResult,
} from "@locallab/tools-mcp-http";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

export interface McpServerRow {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  /** SecretStore ref for the Authorization header, when the server needs one. */
  readonly authRef?: string;
  readonly enabled: boolean;
  /**
   * Discovered remote tools start disabled on purpose: discovering a server
   * never auto-enables anything, and the remote name stays the identity.
   */
  readonly toolEnabled: Record<string, boolean>;
}

export interface McpServerOutcome {
  readonly row: McpServerRow;
  readonly reachable: boolean;
  readonly discovered: readonly string[];
  readonly error?: string;
}

const MCP_SERVERS_SQL = `
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  settings TEXT NOT NULL
);
`;

const LABEL_PATTERN = /^[\p{L}\p{N} ._'\-()]{1,80}$/u;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

function parseStoredRow(raw: string): McpServerRow {
  if (raw.length > 8192)
    throw new Error("The saved MCP server entry is too large. Remove and re-add it.");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("The saved MCP server entry is unreadable. Remove and re-add it.");
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.label !== "string" ||
    !LABEL_PATTERN.test(value.label) ||
    typeof value.url !== "string" ||
    typeof value.enabled !== "boolean" ||
    !value.toolEnabled ||
    typeof value.toolEnabled !== "object" ||
    Array.isArray(value.toolEnabled) ||
    Object.values(value.toolEnabled as Record<string, unknown>).some(
      (flag) => typeof flag !== "boolean",
    ) ||
    Object.keys(value.toolEnabled as Record<string, unknown>).some(
      (name) => !NAME_PATTERN.test(name),
    )
  )
    throw new Error("The saved MCP server entry is unreadable. Remove and re-add it.");
  const label = value.label;
  const url = validateMcpUrl(value.url);
  const row: McpServerRow = {
    id: "",
    label,
    url,
    enabled: value.enabled,
    toolEnabled: value.toolEnabled as Record<string, boolean>,
  };
  if (typeof value.authRef === "string" && /^sec_[0-9a-f-]{36}$/i.test(value.authRef))
    return { ...row, authRef: value.authRef };
  return row;
}

export function validateMcpUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Enter a complete http or https MCP server address.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new Error("MCP servers must use an http or https address.");
  if (parsed.username || parsed.password)
    throw new Error(
      "Put credentials in the key field, not in the server address.",
    );
  return parsed.toString();
}

export class SQLiteMcpServerStore {
  private ready: Promise<void> | undefined;
  constructor(private readonly db: SQLiteDatabasePort) {}
  private ensureSchema(): Promise<void> {
    this.ready ??= this.db.execAsync(MCP_SERVERS_SQL);
    return this.ready;
  }
  async load(): Promise<McpServerRow[]> {
    await this.ensureSchema();
    const rows = await this.db.getAllAsync<{ id: string; settings: string }>(
      "SELECT id, settings FROM mcp_servers ORDER BY rowid",
    );
    return rows.map((row) => ({ ...parseStoredRow(row.settings), id: row.id }));
  }
  async save(row: McpServerRow): Promise<void> {
    await this.ensureSchema();
    if (!/^[0-9a-f-]{36}$/i.test(row.id))
      throw new Error("The MCP server id is invalid. Remove and re-add the server.");
    const url = validateMcpUrl(row.url);
    if (!LABEL_PATTERN.test(row.label))
      throw new Error("Use a plain server name up to 80 characters.");
    if (
      Object.keys(row.toolEnabled).some((name) => !NAME_PATTERN.test(name)) ||
      Object.values(row.toolEnabled).some((flag) => typeof flag !== "boolean")
    )
      throw new Error("A discovered tool name is invalid. Check the server again.");
    if (
      row.authRef !== undefined &&
      !/^sec_[0-9a-f-]{36}$/i.test(row.authRef)
    )
      throw new Error("The saved credential reference is invalid.");
    const stored = {
      label: row.label,
      url,
      enabled: row.enabled,
      toolEnabled: row.toolEnabled,
      ...(row.authRef === undefined ? {} : { authRef: row.authRef }),
    };
    const serialized = JSON.stringify(stored);
    if (serialized.length > 8192)
      throw new Error("This MCP server entry is too large to save.");
    await this.db.runAsync(
      "INSERT INTO mcp_servers (id, settings) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET settings = excluded.settings",
      row.id,
      serialized,
    );
  }
  async remove(id: string): Promise<void> {
    await this.ensureSchema();
    await this.db.runAsync("DELETE FROM mcp_servers WHERE id = ?", id);
  }
}

/** Resolves the stored credential only for the configured origin. */
export async function resolveMcpHeaders(
  secrets: SecretStore,
  row: McpServerRow,
): Promise<Record<string, string>> {
  if (row.authRef === undefined) return {};
  const headers = await secrets.resolveHeaders(new URL(row.url).origin, [
    row.authRef as SecretRef,
  ]);
  return { ...headers };
}

export interface McpCollectResult {
  readonly tools: RegisteredTool[];
  readonly outcomes: McpServerOutcome[];
  /** Releases every still-live server client; safe to call more than once.
   * Returned tools stop working after finalize, so call it when the turn is
   * over. */
  finalize(): Promise<void>;
}

/**
 * Builds loop tools from explicitly enabled servers and tools only. A failed
 * server degrades to "no tools from it" with an honest outcome; it is never
 * silently replaced, and its enablement is left untouched.
 */
export async function collectMcpTools(
  store: SQLiteMcpServerStore,
  secrets: SecretStore,
  signal: AbortSignal,
): Promise<McpCollectResult> {
  const tools: RegisteredTool[] = [];
  const outcomes: McpServerOutcome[] = [];
  const live: McpHttpClient[] = [];
  for (const row of await store.load()) {
    if (!row.enabled) continue;
    const headers = await resolveMcpHeaders(secrets, row);
    const client = new McpHttpClient({
      id: row.id,
      label: row.label,
      url: row.url,
      ...(Object.keys(headers).length ? { headers } : {}),
    });
    try {
      await client.initialize(signal);
      const mapped = await createMcpTools(client, {
        serverId: row.id,
        signal,
      });
      const enabledTools = mapped.filter(
        (tool) => row.toolEnabled[tool.name] === true,
      );
      tools.push(...enabledTools);
      outcomes.push({
        row,
        reachable: true,
        discovered: mapped.map((tool) => tool.name),
      });
      live.push(client);
    } catch (cause) {
      outcomes.push({
        row,
        reachable: false,
        discovered: [],
        error: mcpErrorResult(cause).error.message,
      });
      await client.dispose().catch(() => undefined);
    }
    if (signal.aborted) break;
  }
  return {
    tools,
    outcomes,
    finalize: async () => {
      for (const client of live.splice(0))
        await client.dispose().catch(() => undefined);
    },
  };
}
