import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type {
  ChatAppearance,
  ChatSettingsStore,
  SettingsIdentity,
  SettingsPresets,
  SettingsScope,
} from "../../features/chat-settings";
import type { ContextPolicy } from "@locallab/context";

type PresetRow = { values_json: string };
type AppearanceRow = { appearance_json: string };

/** SQLite-backed settings store scoped to one open conversation. */
export class SQLiteChatSettingsStore implements ChatSettingsStore {
  constructor(
    private readonly db: SQLiteDatabasePort,
    private readonly conversationId: string,
  ) {
    if (!conversationId.trim())
      throw new TypeError("Conversation ID is required");
  }

  static async initialize(db: SQLiteDatabasePort): Promise<void> {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS chat_parameter_presets (
        scope TEXT NOT NULL CHECK(scope IN ('global','model','persona','chat')),
        model_id TEXT NOT NULL DEFAULT '',
        persona_id TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL DEFAULT '',
        values_json TEXT NOT NULL CHECK(json_valid(values_json)),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY(scope,model_id,persona_id,conversation_id)
      );
      CREATE TABLE IF NOT EXISTS chat_appearance (
        conversation_id TEXT PRIMARY KEY NOT NULL,
        appearance_json TEXT NOT NULL CHECK(json_valid(appearance_json)),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS chat_context_policies (
        conversation_id TEXT PRIMARY KEY NOT NULL,
        policy TEXT NOT NULL CHECK(policy IN ('stop','roll','cut-middle','summarize'))
      );
    `);
  }

  async loadPresets(
    identity: SettingsIdentity,
  ): Promise<Partial<SettingsPresets>> {
    const [global, model, persona, chat] = await Promise.all([
      this.read("global", "", "", ""),
      identity.modelId
        ? this.read("model", identity.modelId, "", "")
        : Promise.resolve(undefined),
      identity.personaId
        ? this.read("persona", "", identity.personaId, "")
        : Promise.resolve(undefined),
      this.read("chat", "", "", this.conversationId),
    ]);
    return {
      ...(global ? { global: { explicitlySet: global } } : {}),
      ...(model ? { model: { explicitlySet: model } } : {}),
      ...(persona ? { persona: { explicitlySet: persona } } : {}),
      ...(chat ? { chat: { explicitlySet: chat } } : {}),
    };
  }

  async loadContextPolicy(): Promise<ContextPolicy> {
    const row = await this.db.getFirstAsync<{ policy: ContextPolicy }>(
      "SELECT policy FROM chat_context_policies WHERE conversation_id=?",
      this.conversationId,
    );
    return row?.policy ?? "roll";
  }

  async saveContextPolicy(policy: ContextPolicy): Promise<void> {
    if (!["stop", "roll", "cut-middle", "summarize"].includes(policy))
      throw new TypeError("Unknown context policy");
    await this.db.runAsync(
      "INSERT INTO chat_context_policies(conversation_id,policy) VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET policy=excluded.policy",
      this.conversationId,
      policy,
    );
  }

  async savePreset(
    scope: SettingsScope,
    values: Readonly<Record<string, unknown>>,
    identity: SettingsIdentity,
  ): Promise<void> {
    const key = keyFor(scope, identity, this.conversationId);
    await this.db.runAsync(
      `INSERT INTO chat_parameter_presets(scope,model_id,persona_id,conversation_id,values_json,updated_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(scope,model_id,persona_id,conversation_id) DO UPDATE SET
       values_json=excluded.values_json,updated_at=excluded.updated_at`,
      scope,
      key.modelId,
      key.personaId,
      key.conversationId,
      JSON.stringify(values),
      new Date().toISOString(),
    );
  }

  async loadAppearance(conversationId: string): Promise<ChatAppearance> {
    const row = await this.db.getFirstAsync<AppearanceRow>(
      "SELECT appearance_json FROM chat_appearance WHERE conversation_id=?",
      conversationId,
    );
    return row ? (JSON.parse(row.appearance_json) as ChatAppearance) : {};
  }

  async saveAppearance(
    conversationId: string,
    appearance: ChatAppearance,
  ): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO chat_appearance(conversation_id,appearance_json,updated_at)
       VALUES(?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET
       appearance_json=excluded.appearance_json,updated_at=excluded.updated_at`,
      conversationId,
      JSON.stringify(appearance),
      new Date().toISOString(),
    );
  }

  private async read(
    scope: SettingsScope,
    modelId: string,
    personaId: string,
    conversationId: string,
  ): Promise<Readonly<Record<string, unknown>> | undefined> {
    const row = await this.db.getFirstAsync<PresetRow>(
      `SELECT values_json FROM chat_parameter_presets
       WHERE scope=? AND model_id=? AND persona_id=? AND conversation_id=?`,
      scope,
      modelId,
      personaId,
      conversationId,
    );
    return row
      ? (JSON.parse(row.values_json) as Record<string, unknown>)
      : undefined;
  }
}

function keyFor(
  scope: SettingsScope,
  identity: SettingsIdentity,
  currentConversationId: string,
): { modelId: string; personaId: string; conversationId: string } {
  switch (scope) {
    case "global":
      return { modelId: "", personaId: "", conversationId: "" };
    case "model":
      if (!identity.modelId)
        throw new TypeError("Model scope requires a model ID");
      return { modelId: identity.modelId, personaId: "", conversationId: "" };
    case "persona":
      if (!identity.personaId)
        throw new TypeError("Persona scope requires a persona ID");
      return { modelId: "", personaId: identity.personaId, conversationId: "" };
    case "chat":
      return {
        modelId: "",
        personaId: "",
        conversationId: currentConversationId,
      };
  }
}
