import {
  isLmStudioIntegrationName,
  normalizeLmStudioIntegrationName,
  type LmStudioIntegration,
} from "@locallab/tools-mcp-lmstudio";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

const LMSTUDIO_INTEGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS lmstudio_integrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1))
);
`;

const LABEL_PATTERN = /^[\p{L}\p{N} ._'\-()]{1,80}$/u;

/**
 * Configured LM Studio integrated-MCP names. Rows hold the canonical host
 * reference (`mcp/<name>`), a friendly display label, and a toggle. Renaming
 * only ever changes the label: the reference sent to LM Studio stays the
 * stored `name`, and disabled rows are never sent at all.
 */
export class SQLiteLmStudioIntegrationStore {
  private ready: Promise<void> | undefined;
  constructor(private readonly db: SQLiteDatabasePort) {}
  private ensureSchema(): Promise<void> {
    this.ready ??= this.db.execAsync(LMSTUDIO_INTEGRATIONS_SQL);
    return this.ready;
  }
  async load(): Promise<LmStudioIntegration[]> {
    await this.ensureSchema();
    const rows = await this.db.getAllAsync<{
      id: string;
      name: string;
      label: string;
      enabled: number;
    }>(
      "SELECT id, name, label, enabled FROM lmstudio_integrations ORDER BY rowid",
    );
    return rows.map((row) => {
      if (!isLmStudioIntegrationName(row.name))
        throw new Error(
          "A saved LM Studio integration name is unreadable. Remove and re-add it.",
        );
      if (!LABEL_PATTERN.test(row.label))
        throw new Error(
          "A saved LM Studio integration label is unreadable. Remove and re-add it.",
        );
      return {
        id: row.id,
        name: row.name,
        label: row.label,
        enabled: row.enabled === 1,
      };
    });
  }
  async save(row: LmStudioIntegration): Promise<void> {
    await this.ensureSchema();
    if (!/^[0-9a-f-]{36}$/i.test(row.id))
      throw new Error(
        "The LM Studio integration id is invalid. Remove and re-add it.",
      );
    if (!isLmStudioIntegrationName(row.name))
      throw new Error(
        "LM Studio integration names come from the host's mcp.json, like mcp/playwright.",
      );
    if (!LABEL_PATTERN.test(row.label))
      throw new Error("Use a plain display name up to 80 characters.");
    await this.db.runAsync(
      "INSERT INTO lmstudio_integrations (id, name, label, enabled) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, label = excluded.label, enabled = excluded.enabled",
      row.id,
      row.name,
      row.label,
      row.enabled ? 1 : 0,
    );
  }
  /** Added integrations start disabled: configuration is never activation. */
  async add(rawName: string, rawLabel = ""): Promise<LmStudioIntegration> {
    const name = normalizeLmStudioIntegrationName(rawName);
    if (!name)
      throw new Error(
        "Enter the MCP server name as configured on the host, like playwright or mcp/playwright.",
      );
    const label =
      rawLabel.trim() === "" ? name.slice("mcp/".length) : rawLabel.trim();
    const row: LmStudioIntegration = {
      id: globalThis.crypto.randomUUID(),
      name,
      label,
      enabled: false,
    };
    await this.save(row);
    return row;
  }
  async remove(id: string): Promise<void> {
    await this.ensureSchema();
    await this.db.runAsync("DELETE FROM lmstudio_integrations WHERE id = ?", id);
  }
}
