import { EntityIdSchema } from "@locallab/contracts/identity";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

/**
 * Group room configuration (GR-01..GR-04, GR-11, GR-12). A room mixes saved
 * Personas and direct model participants; one connection may host several
 * distinct roles. Bindings are validated before launch, never silently
 * replaced, and rooms reopen intact from SQLite.
 */
export interface GroupParticipantDraft {
  personaId: string | null;
  /** Direct participant: pinned provider connection identity. */
  providerConnectionId: string | null;
  /** Direct participant: exact model ID on that connection. */
  modelId: string | null;
  displayName: string;
  accentColor: string;
  systemPrompt: string;
  /** Voice settings kept opaque here; the voice UI batch resolves them. */
  voice: Readonly<Record<string, unknown>> | null;
  toolsEnabled: boolean;
}

export interface GroupRoomDraft {
  /** Null for a room that has never been saved. */
  id: string | null;
  name: string;
  scenario: string;
  userDisplayName: string;
  conversationId: string;
  participants: readonly GroupParticipantDraft[];
}

export interface GroupValidationError {
  /** Null when the problem belongs to the room itself. */
  participantIndex: number | null;
  message: string;
}

export interface GroupBindingLookup {
  findConnection(
    connectionId: string,
  ): Promise<{ id: string; modelId: string } | undefined>;
  findPersona(personaId: string): Promise<{ id: string } | undefined>;
}

export function emptyGroupParticipant(): GroupParticipantDraft {
  return {
    personaId: null,
    providerConnectionId: null,
    modelId: null,
    displayName: "",
    accentColor: "#6750A4",
    systemPrompt: "",
    voice: null,
    toolsEnabled: false,
  };
}

/**
 * Validate every participant binding before the room can start (GR-12).
 * Every message names the participant and the action the user can take.
 */
export async function validateGroupRoom(
  draft: GroupRoomDraft,
  lookup: GroupBindingLookup,
): Promise<GroupValidationError[]> {
  const errors: GroupValidationError[] = [];
  if (draft.userDisplayName.trim() === "")
    errors.push({
      participantIndex: null,
      message:
        "Enter your display name so participants know who they are replying to.",
    });
  if (draft.participants.length < 2)
    errors.push({
      participantIndex: null,
      message:
        "Add at least two participants to start a group chat. Use a saved Persona or pick a model directly.",
    });
  for (const [index, participant] of draft.participants.entries()) {
    const label =
      participant.displayName.trim() === ""
        ? `Participant ${index + 1}`
        : participant.displayName.trim();
    const hasPersona = participant.personaId !== null;
    const hasDirect = participant.providerConnectionId !== null;
    if (participant.displayName.trim() === "")
      errors.push({
        participantIndex: index,
        message: `${label}: enter a name so the transcript can attribute replies.`,
      });
    if (hasPersona && hasDirect)
      errors.push({
        participantIndex: index,
        message: `${label}: choose either a Persona or a direct model, not both.`,
      });
    if (!hasPersona && !hasDirect)
      errors.push({
        participantIndex: index,
        message: `${label}: pick a saved Persona or a model before starting.`,
      });
    if (hasPersona) {
      const persona = await lookup.findPersona(participant.personaId!);
      if (!persona)
        errors.push({
          participantIndex: index,
          message: `${label}: this Persona was deleted. Pick another participant; the room keeps everyone else.`,
        });
    }
    if (hasDirect) {
      const connection = await lookup.findConnection(
        participant.providerConnectionId!,
      );
      if (!connection)
        errors.push({
          participantIndex: index,
          message: `${label}: this model's connection was removed from Connections. Rebind this participant or pick a Persona; no other model is substituted.`,
        });
      else if (!connection.modelId || connection.modelId === "model-discovery")
        errors.push({
          participantIndex: index,
          message: `${label}: choose a model in Connections for this participant before starting.`,
        });
    }
  }
  for (const [index, participant] of draft.participants.entries()) {
    if (!participant.personaId) continue;
    const duplicate = draft.participants.findIndex(
      (other, otherIndex) =>
        otherIndex !== index &&
        other.personaId !== null &&
        other.personaId === participant.personaId,
    );
    if (duplicate !== -1)
      errors.push({
        participantIndex: index,
        message: `Participant ${
          index + 1
        }: the same Persona already has a seat in this room. Write a system prompt to give one model two distinct roles instead.`,
      });
  }
  return errors;
}

type RoomRow = {
  id: string;
  name: string;
  conversation_id: string;
  scenario: string;
  user_display_name: string;
};
type ParticipantRow = {
  id: string;
  persona_id: string | null;
  provider_connection_id: string | null;
  model_id: string | null;
  display_name: string;
  accent_color: string;
  system_prompt: string;
  voice_json: string | null;
  tools_enabled: number;
  turn_order: number;
};

export class SQLiteGroupConfigStore {
  constructor(private readonly db: SQLiteDatabasePort) {}

  static async initialize(db: SQLiteDatabasePort): Promise<void> {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS group_rooms (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        scenario TEXT NOT NULL DEFAULT '',
        user_display_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS group_participants (
        id TEXT PRIMARY KEY NOT NULL,
        group_room_id TEXT NOT NULL REFERENCES group_rooms(id),
        persona_id TEXT,
        provider_connection_id TEXT,
        model_id TEXT,
        display_name TEXT NOT NULL,
        accent_color TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        voice_json TEXT,
        tools_enabled INTEGER NOT NULL DEFAULT 0,
        turn_order INTEGER NOT NULL
      );
    `);
  }

  async saveRoom(
    draft: GroupRoomDraft,
    createId: () => string,
  ): Promise<string> {
    const roomId = draft.id ?? EntityIdSchema.parse(createId());
    const conversationId = EntityIdSchema.parse(draft.conversationId);
    for (const participant of draft.participants) {
      if (participant.personaId !== null)
        EntityIdSchema.parse(participant.personaId);
      if (participant.providerConnectionId !== null)
        EntityIdSchema.parse(participant.providerConnectionId);
    }
    await dbTransaction(this.db, async (transaction) => {
      await transaction.runAsync(
        `INSERT INTO group_rooms(id,name,conversation_id,scenario,user_display_name)
         VALUES(?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
         name=excluded.name,conversation_id=excluded.conversation_id,
         scenario=excluded.scenario,user_display_name=excluded.user_display_name`,
        roomId,
        draft.name.trim() || "Group chat",
        conversationId,
        draft.scenario,
        draft.userDisplayName,
      );
      await transaction.runAsync(
        "DELETE FROM group_participants WHERE group_room_id=?",
        roomId,
      );
      for (const [index, participant] of draft.participants.entries()) {
        await transaction.runAsync(
          `INSERT INTO group_participants(
             id,group_room_id,persona_id,provider_connection_id,model_id,
             display_name,accent_color,system_prompt,voice_json,tools_enabled,turn_order)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          EntityIdSchema.parse(createId()),
          roomId,
          participant.personaId,
          participant.providerConnectionId,
          participant.modelId,
          participant.displayName.trim(),
          participant.accentColor,
          participant.systemPrompt,
          participant.voice === null ? null : JSON.stringify(participant.voice),
          participant.toolsEnabled ? 1 : 0,
          index,
        );
      }
    });
    return roomId;
  }

  async loadRoom(roomId: string): Promise<GroupRoomDraft | null> {
    EntityIdSchema.parse(roomId);
    const room = await this.db.getFirstAsync<RoomRow>(
      "SELECT id,name,conversation_id,scenario,user_display_name FROM group_rooms WHERE id=?",
      roomId,
    );
    if (!room) return null;
    const rows = await this.db.getAllAsync<ParticipantRow>(
      `SELECT id,persona_id,provider_connection_id,model_id,display_name,
              accent_color,system_prompt,voice_json,tools_enabled,turn_order
       FROM group_participants WHERE group_room_id=? ORDER BY turn_order`,
      roomId,
    );
    return {
      id: room.id,
      name: room.name,
      scenario: room.scenario,
      userDisplayName: room.user_display_name,
      conversationId: room.conversation_id,
      participants: rows.map((row) => ({
        personaId: row.persona_id,
        providerConnectionId: row.provider_connection_id,
        modelId: row.model_id,
        displayName: row.display_name,
        accentColor: row.accent_color,
        systemPrompt: row.system_prompt,
        voice: row.voice_json
          ? (JSON.parse(row.voice_json) as Record<string, unknown>)
          : null,
        toolsEnabled: row.tools_enabled === 1,
      })),
    };
  }

  async listRooms(): Promise<{ id: string; name: string }[]> {
    const rows = await this.db.getAllAsync<{ id: string; name: string }>(
      "SELECT id,name FROM group_rooms ORDER BY created_at",
    );
    return rows.map((row) => ({ id: row.id, name: row.name }));
  }
}

async function dbTransaction(
  db: SQLiteDatabasePort,
  work: (transaction: SQLiteDatabasePort) => Promise<void>,
): Promise<void> {
  if (db.withTransactionAsync) {
    await db.withTransactionAsync((transaction) => work(transaction ?? db));
    return;
  }
  await work(db);
}
