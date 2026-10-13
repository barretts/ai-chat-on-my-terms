import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

/**
 * Identity rule: labels are display-only. The tool name is the stable identity
 * that invocations and history use; renaming changes nothing about what runs.
 */
export interface ToolSettingsCatalogEntry {
  label: string;
  serverId: string;
  description: string;
}

/** Server ids: web research …086, workspace files …075, built-in time …088. */
export const TOOL_SETTINGS_CATALOG: Readonly<
  Record<string, ToolSettingsCatalogEntry>
> = {
  web_search: {
    label: "Web search",
    serverId: "00000000-0000-7000-8000-000000000086",
    description: "Search the web for current information.",
  },
  web_fetch: {
    label: "Web fetch",
    serverId: "00000000-0000-7000-8000-000000000086",
    description: "Open a web page and read its text.",
  },
  workspace_list_files: {
    label: "Workspace: list files",
    serverId: "00000000-0000-7000-8000-000000000075",
    description: "List files in the chat file workspace.",
  },
  workspace_read_file: {
    label: "Workspace: read file",
    serverId: "00000000-0000-7000-8000-000000000075",
    description: "Read a file from the chat file workspace.",
  },
  workspace_write_file: {
    label: "Workspace: write file",
    serverId: "00000000-0000-7000-8000-000000000075",
    description: "Write a file into the chat file workspace.",
  },
  current_time: {
    label: "Current time",
    serverId: "00000000-0000-7000-8000-000000000088",
    description: "Report the current date and time on this device.",
  },
};

/** App-wide tool policy; every chat inherits it unless the chat overrides. */
export interface ToolGlobalSettings {
  globalEnabled: boolean;
  roundLimit: number | null;
  labels: Record<string, string>;
  tools: Record<string, boolean>;
}

export const DEFAULT_TOOL_GLOBAL_SETTINGS: ToolGlobalSettings = {
  globalEnabled: true,
  roundLimit: 6,
  labels: {},
  tools: {},
};

/** Per-chat overrides; an absent field means "inherit the app-wide value". */
export interface ToolConversationSettings {
  globalEnabled?: boolean;
  tools?: Record<string, boolean>;
}

export function isToolSettingsLabel(value: unknown): value is string {
  return (
    typeof value === "string" && /^[\p{L}\p{N} ._'\-()]{1,80}$/u.test(value)
  );
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function parseToolSwitches(
  value: unknown,
  field: string,
): Record<string, boolean> | undefined {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`tool settings ${field} must be an object`);
  }
  const switches: Record<string, boolean> = {};
  for (const [name, enabled] of Object.entries(value)) {
    if (!(name in TOOL_SETTINGS_CATALOG)) {
      throw new Error(`unknown tool name in ${field}: ${name}`);
    }
    if (typeof enabled !== "boolean") {
      throw new Error(`tool ${field}.${name} must be true or false`);
    }
    switches[name] = enabled;
  }
  return switches;
}

function parseLabels(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("tool settings labels must be an object");
  }
  const labels: Record<string, string> = {};
  for (const [name, label] of Object.entries(value)) {
    if (!(name in TOOL_SETTINGS_CATALOG)) {
      throw new Error(`unknown tool name in labels: ${name}`);
    }
    if (!isToolSettingsLabel(label)) {
      throw new Error(`tool label ${name} must be 1-80 plain-text characters`);
    }
    labels[name] = label;
  }
  return labels;
}

function parseRoundLimit(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 50) {
    return value;
  }
  throw new Error("tool round limit must be null or an integer from 1 to 50");
}

export function parseToolGlobalSettings(raw: string): ToolGlobalSettings {
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    throw new Error("tool settings must be a JSON object");
  }
  if (typeof parsed.globalEnabled !== "boolean") {
    throw new Error("tool settings globalEnabled must be a boolean");
  }
  return {
    globalEnabled: parsed.globalEnabled,
    roundLimit: parseRoundLimit(parsed.roundLimit),
    labels: parseLabels(parsed.labels),
    tools: parseToolSwitches(parsed.tools, "tools") ?? {},
  };
}

export function parseToolConversationSettings(
  raw: string,
): ToolConversationSettings {
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    throw new Error("conversation tool settings must be a JSON object");
  }
  if (
    parsed.globalEnabled !== undefined &&
    typeof parsed.globalEnabled !== "boolean"
  ) {
    throw new Error(
      "conversation tool settings globalEnabled must be a boolean",
    );
  }
  const settings: ToolConversationSettings = {};
  if (parsed.globalEnabled !== undefined) {
    settings.globalEnabled = parsed.globalEnabled as boolean;
  }
  const tools = parseToolSwitches(parsed.tools, "tools");
  if (tools && Object.keys(tools).length > 0) settings.tools = tools;
  return settings;
}

/**
 * Serializes then re-parses so the stored text is exactly what a later load
 * will accept: bounded size (8 KiB), catalog-only tool keys, plain labels.
 */
function serializeSettings(value: unknown, what: string): string {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new Error(`${what} could not be encoded as JSON`);
  }
  if (new TextEncoder().encode(text).byteLength > 8192) {
    throw new Error(`${what} exceeds 8192 bytes`);
  }
  return text;
}

/**
 * Global and per-chat tool settings survive reopening the app. No network I/O
 * happens here: everything is local SQLite only.
 */
export class SQLiteToolSettingsStore {
  private ready: Promise<void> | undefined;
  constructor(private readonly database: SQLiteDatabasePort) {}
  private ensureSchema() {
    this.ready ??= this.database
      .execAsync(
        `CREATE TABLE IF NOT EXISTS tool_settings (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      settings TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tool_settings_conversation (
      conversation_id TEXT PRIMARY KEY,
      settings TEXT NOT NULL
    )`,
      )
      .then(() => {});
    return this.ready;
  }
  async load(): Promise<ToolGlobalSettings> {
    await this.ensureSchema();
    const row = await this.database.getFirstAsync<{ settings: string }>(
      "SELECT settings FROM tool_settings WHERE singleton=1",
    );
    if (!row) return DEFAULT_TOOL_GLOBAL_SETTINGS;
    return parseToolGlobalSettings(row.settings);
  }
  async save(settings: ToolGlobalSettings): Promise<void> {
    await this.ensureSchema();
    // Round-trip through the real parser before persisting.
    const text = serializeSettings(settings, "tool settings");
    parseToolGlobalSettings(text);
    await this.database.runAsync(
      "INSERT INTO tool_settings (singleton,settings) VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET settings=excluded.settings",
      text,
    );
  }
  async loadConversation(
    conversationId: string,
  ): Promise<ToolConversationSettings> {
    await this.ensureSchema();
    const row = await this.database.getFirstAsync<{ settings: string }>(
      "SELECT settings FROM tool_settings_conversation WHERE conversation_id=?",
      conversationId,
    );
    if (!row) return {};
    return parseToolConversationSettings(row.settings);
  }
  async saveConversation(
    conversationId: string,
    settings: ToolConversationSettings,
  ): Promise<void> {
    await this.ensureSchema();
    const text = serializeSettings(
      settings,
      `conversation ${conversationId} tool settings`,
    );
    parseToolConversationSettings(text);
    await this.database.runAsync(
      "INSERT INTO tool_settings_conversation (conversation_id,settings) VALUES (?,?) ON CONFLICT(conversation_id) DO UPDATE SET settings=excluded.settings",
      conversationId,
      text,
    );
  }
  async clearConversation(conversationId: string): Promise<void> {
    await this.ensureSchema();
    await this.database.runAsync(
      "DELETE FROM tool_settings_conversation WHERE conversation_id=?",
      conversationId,
    );
  }
}

export interface ToolPolicyInput {
  global: ToolGlobalSettings;
  conversation: ToolConversationSettings | null;
  participant?: { globalEnabled?: boolean } | null;
  capabilities: Readonly<Record<string, "yes" | "no" | "unknown">>;
}

export interface ToolPolicy {
  engaged: boolean;
  tools: Record<string, boolean>;
  roundLimit: number | null;
  effectiveFrom: "participant" | "chat" | "global";
}

/**
 * Who wins for the master switch: participant, then chat, then app-wide.
 * Even an explicit "on" cannot exceed the model's tool capability: if the
 * current model cannot take tools at all the policy is simply not engaged,
 * while effectiveFrom still reports which layer set the switch.
 */
export function resolveToolPolicy(input: ToolPolicyInput): ToolPolicy {
  const participantEnabled = input.participant?.globalEnabled;
  const conversationEnabled = input.conversation?.globalEnabled;
  const master =
    participantEnabled ?? conversationEnabled ?? input.global.globalEnabled;
  const effectiveFrom: ToolPolicy["effectiveFrom"] =
    participantEnabled !== undefined
      ? "participant"
      : conversationEnabled !== undefined
        ? "chat"
        : "global";
  const tools: Record<string, boolean> = {};
  for (const name of Object.keys(TOOL_SETTINGS_CATALOG)) {
    tools[name] =
      input.conversation?.tools?.[name] ?? input.global.tools[name] ?? true;
  }
  return {
    engaged: master && input.capabilities.tools === "yes",
    tools,
    roundLimit: input.global.roundLimit,
    effectiveFrom,
  };
}

/**
 * Seam for C07–C09 (custom tool servers). `authSecretRef` is a host-scoped
 * SecretStore reference only — this type NEVER carries raw headers or keys.
 */
export interface ToolServerConfiguration {
  id: string;
  label: string;
  url: string;
  authSecretRef?: string;
  enabled: boolean;
}
