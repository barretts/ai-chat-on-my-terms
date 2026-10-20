import { EntityIdSchema } from "@locallab/contracts/identity";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

/**
 * Group room configuration (GR-01..GR-04, GR-11..GR-13). A room mixes saved
 * Personas and direct model participants; one connection may host several
 * distinct roles. Bindings are validated before launch, never silently
 * replaced, and rooms reopen intact from SQLite. Room settings (Conversation
 * mode, Order, Reply display, Shared model, response limit) and per-seat
 * Drunk flags persist in side tables; seat IDs stay stable across saves so
 * rounds and message attribution survive edits (T170).
 */
export interface GroupParticipantDraft {
  /** Stable SQLite row ID; null for a seat that has never been saved. */
  id: string | null;
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
  /** Drunk mode: relaxed, funnier output (GR-13). */
  drunk: boolean;
}

export type GroupConversationMode = "discussion" | "independent";
export type GroupSpeakerOrder = "round-robin" | "dice" | "topic-interest";
export type GroupReplyDisplay = "complete" | "live";

export interface GroupRoomSettings {
  conversationMode: GroupConversationMode;
  speakerOrder: GroupSpeakerOrder;
  replyDisplay: GroupReplyDisplay;
  /** Device model ID shared by every seat (GR-13 Shared model). */
  sharedModelId: string | null;
  /** Per-speaker response length cap in tokens; plan default 256. */
  responseLimitTokens: number;
}

export interface GroupRoomDraft {
  /** Null for a room that has never been saved. */
  id: string | null;
  name: string;
  scenario: string;
  userDisplayName: string;
  conversationId: string;
  settings: GroupRoomSettings;
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

export function defaultGroupRoomSettings(): GroupRoomSettings {
  return {
    conversationMode: "discussion",
    speakerOrder: "round-robin",
    replyDisplay: "complete",
    sharedModelId: null,
    responseLimitTokens: 256,
  };
}

export function emptyGroupParticipant(): GroupParticipantDraft {
  return {
    id: null,
    personaId: null,
    providerConnectionId: null,
    modelId: null,
    displayName: "",
    accentColor: "#6750A4",
    systemPrompt: "",
    voice: null,
    toolsEnabled: false,
    drunk: false,
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
  if (
    !Number.isSafeInteger(draft.settings.responseLimitTokens) ||
    draft.settings.responseLimitTokens < 16 ||
    draft.settings.responseLimitTokens > 4096
  )
    errors.push({
      participantIndex: null,
      message:
        "Response limit must be a whole number between 16 and 4096 tokens.",
    });
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
  drunk: number | null;
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
      CREATE TABLE IF NOT EXISTS group_room_settings (
        room_id TEXT PRIMARY KEY NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
        conversation_mode TEXT NOT NULL DEFAULT 'discussion'
          CHECK (conversation_mode IN ('discussion', 'independent')),
        speaker_order TEXT NOT NULL DEFAULT 'round-robin'
          CHECK (speaker_order IN ('round-robin', 'dice', 'topic-interest')),
        reply_display TEXT NOT NULL DEFAULT 'complete'
          CHECK (reply_display IN ('complete', 'live')),
        shared_model_id TEXT,
        response_limit_tokens INTEGER NOT NULL DEFAULT 256,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS group_participant_prefs (
        participant_id TEXT PRIMARY KEY NOT NULL REFERENCES group_participants(id) ON DELETE CASCADE,
        drunk INTEGER NOT NULL DEFAULT 0 CHECK (drunk IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS group_rounds (
        id TEXT PRIMARY KEY NOT NULL,
        group_room_id TEXT NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL,
        trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('send', 'pass', 'ask')),
        frozen_order_json TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'completed', 'stopped', 'failed')),
        seat_cursor INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS group_rounds_room_idx
        ON group_rounds(group_room_id, created_at);
      CREATE TABLE IF NOT EXISTS group_runs (
        id TEXT PRIMARY KEY NOT NULL,
        group_round_id TEXT NOT NULL REFERENCES group_rounds(id) ON DELETE CASCADE,
        seat_index INTEGER NOT NULL,
        participant_id TEXT,
        model_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'running', 'completed', 'failed', 'interrupted')),
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS group_runs_round_idx
        ON group_runs(group_round_id, seat_index);
      CREATE TABLE IF NOT EXISTS group_room_conversations (
        conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        group_room_id TEXT NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
        `INSERT INTO group_room_settings(
           room_id,conversation_mode,speaker_order,reply_display,
           shared_model_id,response_limit_tokens)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(room_id) DO UPDATE SET
         conversation_mode=excluded.conversation_mode,
         speaker_order=excluded.speaker_order,
         reply_display=excluded.reply_display,
         shared_model_id=excluded.shared_model_id,
         response_limit_tokens=excluded.response_limit_tokens`,
        roomId,
        draft.settings.conversationMode,
        draft.settings.speakerOrder,
        draft.settings.replyDisplay,
        draft.settings.sharedModelId,
        draft.settings.responseLimitTokens,
      );
      const previousSeats = await transaction.getAllAsync<{ id: string }>(
        "SELECT id FROM group_participants WHERE group_room_id=?",
        roomId,
      );
      const keptSeats = new Set<string>();
      for (const [index, participant] of draft.participants.entries()) {
        const participantId =
          participant.id === null
            ? EntityIdSchema.parse(createId())
            : EntityIdSchema.parse(participant.id);
        keptSeats.add(participantId);
        await transaction.runAsync(
          `INSERT INTO group_participants(
             id,group_room_id,persona_id,provider_connection_id,model_id,
             display_name,accent_color,system_prompt,voice_json,tools_enabled,turn_order)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
           group_room_id=excluded.group_room_id,persona_id=excluded.persona_id,
           provider_connection_id=excluded.provider_connection_id,
           model_id=excluded.model_id,display_name=excluded.display_name,
           accent_color=excluded.accent_color,system_prompt=excluded.system_prompt,
           voice_json=excluded.voice_json,tools_enabled=excluded.tools_enabled,
           turn_order=excluded.turn_order`,
          participantId,
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
        if (participant.drunk)
          await transaction.runAsync(
            `INSERT INTO group_participant_prefs(participant_id,drunk)
             VALUES(?,1) ON CONFLICT(participant_id) DO UPDATE SET drunk=1`,
            participantId,
          );
        else
          await transaction.runAsync(
            "DELETE FROM group_participant_prefs WHERE participant_id=?",
            participantId,
          );
      }
      for (const seat of previousSeats) {
        if (keptSeats.has(seat.id)) continue;
        // Drivers do not always enforce foreign keys; clear prefs explicitly.
        await transaction.runAsync(
          "DELETE FROM group_participant_prefs WHERE participant_id=?",
          seat.id,
        );
        await transaction.runAsync(
          "DELETE FROM group_participants WHERE id=?",
          seat.id,
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
      `SELECT p.id,p.persona_id,p.provider_connection_id,p.model_id,
              p.display_name,p.accent_color,p.system_prompt,p.voice_json,
              p.tools_enabled,p.turn_order,prefs.drunk
       FROM group_participants p
       LEFT JOIN group_participant_prefs prefs ON prefs.participant_id=p.id
       WHERE p.group_room_id=? ORDER BY p.turn_order`,
      roomId,
    );
    const settingsRow = await this.db.getFirstAsync<SettingsRow>(
      `SELECT conversation_mode,speaker_order,reply_display,
              shared_model_id,response_limit_tokens
       FROM group_room_settings WHERE room_id=?`,
      roomId,
    );
    return {
      id: room.id,
      name: room.name,
      scenario: room.scenario,
      userDisplayName: room.user_display_name,
      conversationId: room.conversation_id,
      settings: settingsRow
        ? settingsFromRow(settingsRow)
        : defaultGroupRoomSettings(),
      participants: rows.map((row) => ({
        id: row.id,
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
        drunk: row.drunk === 1,
      })),
    };
  }

  async listRooms(): Promise<{ id: string; name: string }[]> {
    const rows = await this.db.getAllAsync<{ id: string; name: string }>(
      "SELECT id,name FROM group_rooms ORDER BY created_at",
    );
    return rows.map((row) => ({ id: row.id, name: row.name }));
  }

  /** Start one automatic round: trigger, frozen seats and settings snapshot. */
  async beginRound(
    roomId: string,
    conversationId: string,
    start: GroupRoundStart,
    createId: () => string,
  ): Promise<GroupRoundRecord> {
    EntityIdSchema.parse(roomId);
    EntityIdSchema.parse(conversationId);
    const roundId = EntityIdSchema.parse(createId());
    await this.db.runAsync(
      `INSERT INTO group_rounds(
         id,group_room_id,conversation_id,trigger_kind,frozen_order_json,settings_json)
       VALUES(?,?,?,?,?,?)`,
      roundId,
      roomId,
      conversationId,
      start.trigger,
      JSON.stringify(start.frozenOrder),
      JSON.stringify(start.settings),
    );
    return {
      id: roundId,
      roomId,
      conversationId,
      trigger: start.trigger,
      frozenOrder: [...start.frozenOrder],
      settings: { ...start.settings },
      status: "active",
      seatCursor: 0,
    };
  }

  async setRoundStatus(
    roundId: string,
    status: GroupRoundStatus,
    seatCursor: number,
  ): Promise<void> {
    await this.db.runAsync(
      "UPDATE group_rounds SET status=?,seat_cursor=? WHERE id=?",
      status,
      seatCursor,
      roundId,
    );
  }

  async beginSpeakerRun(
    roundId: string,
    seatIndex: number,
    participantId: string | null,
    modelId: string | null,
    createId: () => string,
  ): Promise<string> {
    const runId = EntityIdSchema.parse(createId());
    if (participantId !== null) EntityIdSchema.parse(participantId);
    await this.db.runAsync(
      `INSERT INTO group_runs(
         id,group_round_id,seat_index,participant_id,model_id,status,started_at)
       VALUES(?,?,?,?,?,?,?)`,
      runId,
      roundId,
      seatIndex,
      participantId,
      modelId,
      "running",
      new Date().toISOString(),
    );
    return runId;
  }

  async finishSpeakerRun(runId: string, status: GroupRunStatus): Promise<void> {
    await this.db.runAsync(
      "UPDATE group_runs SET status=?,finished_at=? WHERE id=?",
      status,
      new Date().toISOString(),
      runId,
    );
  }

  /** Most recent round for the room with its speaker runs, for resume. */
  async latestRound(roomId: string): Promise<{
    round: GroupRoundRecord;
    runs: GroupSpeakerRun[];
  } | null> {
    EntityIdSchema.parse(roomId);
    const row = await this.db.getFirstAsync<RoundRow>(
      `SELECT id,group_room_id,conversation_id,trigger_kind,frozen_order_json,
              settings_json,status,seat_cursor
       FROM group_rounds WHERE group_room_id=?
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      roomId,
    );
    if (!row) return null;
    const runs = await this.db.getAllAsync<RunRow>(
      `SELECT id,seat_index,participant_id,model_id,status
       FROM group_runs WHERE group_round_id=? ORDER BY seat_index`,
      row.id,
    );
    return {
      round: {
        id: row.id,
        roomId: row.group_room_id,
        conversationId: row.conversation_id,
        trigger: row.trigger_kind,
        frozenOrder: JSON.parse(row.frozen_order_json) as number[],
        settings: settingsFromJson(row.settings_json),
        status: row.status,
        seatCursor: row.seat_cursor,
      },
      runs: runs.map((run) => ({
        id: run.id,
        seatIndex: run.seat_index,
        participantId: run.participant_id,
        modelId: run.model_id,
        status: run.status,
      })),
    };
  }

  /** Marks a conversation as dedicated to a room (group kind marker). */
  async markGroupConversation(
    conversationId: string,
    roomId: string,
  ): Promise<void> {
    await this.db.runAsync(
      `INSERT OR IGNORE INTO group_room_conversations(conversation_id,group_room_id)
       VALUES(?,?)`,
      EntityIdSchema.parse(conversationId),
      EntityIdSchema.parse(roomId),
    );
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

export type GroupRoundTrigger = "send" | "pass" | "ask";
export type GroupRoundStatus = "active" | "completed" | "stopped" | "failed";
export type GroupRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export interface GroupRoundStart {
  trigger: GroupRoundTrigger;
  /** Frozen turn_order seats for this round (identity freeze, GR-13). */
  frozenOrder: readonly number[];
  settings: GroupRoomSettings;
}

export interface GroupRoundRecord {
  id: string;
  roomId: string;
  conversationId: string;
  trigger: GroupRoundTrigger;
  frozenOrder: readonly number[];
  settings: GroupRoomSettings;
  status: GroupRoundStatus;
  seatCursor: number;
}

export interface GroupSpeakerRun {
  id: string;
  seatIndex: number;
  participantId: string | null;
  modelId: string | null;
  status: GroupRunStatus;
}

type SettingsRow = {
  conversation_mode: string;
  speaker_order: string;
  reply_display: string;
  shared_model_id: string | null;
  response_limit_tokens: number;
};
type RoundRow = {
  id: string;
  group_room_id: string;
  conversation_id: string;
  trigger_kind: GroupRoundTrigger;
  frozen_order_json: string;
  settings_json: string;
  status: GroupRoundStatus;
  seat_cursor: number;
};
type RunRow = {
  id: string;
  seat_index: number;
  participant_id: string | null;
  model_id: string | null;
  status: GroupRunStatus;
};

const CONVERSATION_MODES: readonly GroupConversationMode[] = [
  "discussion",
  "independent",
];
const SPEAKER_ORDERS: readonly GroupSpeakerOrder[] = [
  "round-robin",
  "dice",
  "topic-interest",
];
const REPLY_DISPLAYS: readonly GroupReplyDisplay[] = ["complete", "live"];

function readMode(value: unknown): GroupConversationMode {
  return CONVERSATION_MODES.includes(value as GroupConversationMode)
    ? (value as GroupConversationMode)
    : "discussion";
}
function readOrder(value: unknown): GroupSpeakerOrder {
  return SPEAKER_ORDERS.includes(value as GroupSpeakerOrder)
    ? (value as GroupSpeakerOrder)
    : "round-robin";
}
function readDisplay(value: unknown): GroupReplyDisplay {
  return REPLY_DISPLAYS.includes(value as GroupReplyDisplay)
    ? (value as GroupReplyDisplay)
    : "complete";
}
function readLimit(value: unknown): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 16 &&
    value <= 4096
    ? value
    : 256;
}

function settingsFromRow(row: SettingsRow): GroupRoomSettings {
  return {
    conversationMode: readMode(row.conversation_mode),
    speakerOrder: readOrder(row.speaker_order),
    replyDisplay: readDisplay(row.reply_display),
    sharedModelId: row.shared_model_id,
    responseLimitTokens: readLimit(row.response_limit_tokens),
  };
}

function settingsFromJson(json: string): GroupRoomSettings {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  return {
    conversationMode: readMode(parsed.conversationMode),
    speakerOrder: readOrder(parsed.speakerOrder),
    replyDisplay: readDisplay(parsed.replyDisplay),
    sharedModelId:
      typeof parsed.sharedModelId === "string" ? parsed.sharedModelId : null,
    responseLimitTokens: readLimit(parsed.responseLimitTokens),
  };
}
