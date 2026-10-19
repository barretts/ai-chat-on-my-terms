import { PersonaSchema, TombstoneSchema } from "@locallab/contracts/entities";
import {
  EntityIdSchema,
  IsoTimestampSchema,
  RevisionSchema,
  compareRevision,
  type Revision,
} from "@locallab/contracts/identity";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { PERSONA_LIBRARY_SQL } from "./schema";

export { PERSONA_LIBRARY_SQL } from "./schema";
export type PersonaEntity = ReturnType<typeof PersonaSchema.parse>;
export type PersonaTombstone = ReturnType<typeof TombstoneSchema.parse>;

export const DEFAULT_PERSONA_ID = "0195c000-0000-7000-8000-000000000001";
export const STARTER_PERSONA_ID = "0195c000-0000-7000-8000-000000000002";
const STARTER_SEED = "seed.locallab-assistant.v1";
const STARTER_DELETED = "seed.locallab-assistant.deleted";

export interface PersonaAppearance {
  accentColor: string;
  backgroundColor: string;
  avatarShape: "circle" | "square";
}
export const DEFAULT_PERSONA_APPEARANCE: Readonly<PersonaAppearance> = {
  accentColor: "#6750A4",
  backgroundColor: "#FFFBFE",
  avatarShape: "circle",
};

export interface PersonaRecord extends PersonaEntity {
  description: string;
  prompt: string;
  appearance: PersonaAppearance;
  isDefault: boolean;
  isStarter: boolean;
}

export interface PersonaDraft {
  name: string;
  description?: string;
  prompt?: string;
  appearance?: Partial<PersonaAppearance>;
  photoAttachmentId?: string | null;
  /** Additional non-secret profile data for later Persona features. */
  profile?: Readonly<Record<string, unknown>>;
}
export interface PersonaEdit extends Partial<PersonaDraft> {
  expectedRevision?: Revision;
}
export interface PersonaRunSnapshot {
  personaId: string;
  name: string;
  prompt: string;
  description: string;
  photoAttachmentId: string | null;
  appearance: PersonaAppearance;
  profile: Readonly<Record<string, unknown>>;
  revision: Revision;
}
export interface PersonaChatIntent {
  kind: "individual-chat";
  conversationId: string;
  personaId: string;
  title: string;
  identity: PersonaRunSnapshot;
}
export interface PersonaGroupIntent {
  kind: "add-persona-to-group";
  personaId: string;
  groupRoomId?: string;
  identity: PersonaRunSnapshot;
}
export interface PersonaSwitchIntent {
  kind: "switch-persona";
  conversationId: string;
  personaId: string;
  preserveTranscript: true;
  appliesTo: "next-run";
}

/** Features consume this port; the composition root owns the shared database. */
export interface PersonaLibraryPort {
  list(): Promise<PersonaRecord[]>;
  get(id: string): Promise<PersonaRecord | null>;
  create(input: PersonaDraft & { id?: string }): Promise<PersonaRecord>;
  update(id: string, input: PersonaEdit): Promise<PersonaRecord>;
  delete(id: string): Promise<void>;
  selected(conversationId: string): Promise<PersonaRecord>;
  select(
    conversationId: string,
    personaId: string,
  ): Promise<PersonaSwitchIntent>;
  chatIntent(
    personaId: string,
    conversationId?: string,
  ): Promise<PersonaChatIntent>;
  groupIntent(
    personaId: string,
    groupRoomId?: string,
  ): Promise<PersonaGroupIntent>;
  snapshotForNextRun(conversationId: string): Promise<PersonaRunSnapshot>;
  captureRun(
    conversationId: string,
    runId: string,
    identity?: PersonaRunSnapshot,
  ): Promise<PersonaRunSnapshot>;
}

export class PersonaLibraryError extends Error {
  constructor(
    readonly code:
      | "invalid"
      | "missing"
      | "protected"
      | "conflict"
      | "schema-required",
    message: string,
  ) {
    super(message);
    this.name = "PersonaLibraryError";
  }
}

type PersonaRow = {
  id: string;
  name: string;
  description: string | null;
  prompt: string;
  is_default: number;
  created_at: string;
  updated_at: string;
  profile_json: string;
  photo_attachment_id: string | null;
  model_id: string | null;
  parameter_preset_id: string | null;
  revision_wall_ms: number;
  revision_counter: number;
  revision_device_id: string;
};
const SELECT_PERSONAS = `SELECT p.id,p.name,p.description,p.prompt,p.is_default,p.created_at,p.updated_at,
  m.profile_json,m.photo_attachment_id,m.model_id,m.parameter_preset_id,
  m.revision_wall_ms,m.revision_counter,m.revision_device_id
  FROM personas p JOIN persona_profiles m ON m.persona_id=p.id
  WHERE NOT EXISTS (SELECT 1 FROM persona_tombstones t WHERE t.entity_id=p.id)`;

const mutationQueues = new WeakMap<SQLiteDatabasePort, Promise<unknown>>();

export class SQLitePersonaLibrary implements PersonaLibraryPort {
  private deviceId: string | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly db: SQLiteDatabasePort,
    private readonly options: {
      createId: () => string;
      deviceId?: string;
      now?: () => Date;
    },
  ) {
    if (options.deviceId) EntityIdSchema.parse(options.deviceId);
    this.now = options.now ?? (() => new Date());
  }

  /** Apply after optional schema migrations; safe to repeat on every upgrade/open. */
  async initialize(): Promise<void> {
    const base = await this.db.getFirstAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='personas'",
    );
    if (!base)
      throw new PersonaLibraryError(
        "schema-required",
        "Apply the optional Persona schema before opening the library.",
      );
    await this.db.execAsync(PERSONA_LIBRARY_SQL);
    await this.mutate(async (db) => {
      const savedDevice = await this.state(db, "device-id");
      this.deviceId = EntityIdSchema.parse(
        this.options.deviceId ?? savedDevice ?? this.options.createId(),
      );
      if (!savedDevice) await this.setState(db, "device-id", this.deviceId);
      const existing = await db.getAllAsync<{
        id: string;
        name: string;
        description: string | null;
        prompt: string;
        is_default: number;
        created_at: string;
        updated_at: string;
      }>(
        "SELECT id,name,description,prompt,is_default,created_at,updated_at FROM personas",
      );
      for (const row of existing) {
        EntityIdSchema.parse(row.id);
        IsoTimestampSchema.parse(row.created_at);
        IsoTimestampSchema.parse(row.updated_at);
        const profile = normalizeProfile(
          {},
          row.description ?? "",
          row.prompt,
          DEFAULT_PERSONA_APPEARANCE,
        );
        await db.runAsync(
          `INSERT OR IGNORE INTO persona_profiles
           (persona_id,profile_json,photo_attachment_id,model_id,parameter_preset_id,revision_wall_ms,revision_counter,revision_device_id)
           VALUES (?,?,NULL,NULL,NULL,?,0,?)`,
          row.id,
          JSON.stringify(profile),
          Math.max(0, Date.parse(row.updated_at)),
          this.deviceId,
        );
      }
      const defaultRow = existing.find((row) => row.is_default === 1);
      if (!defaultRow)
        await this.insert(
          db,
          DEFAULT_PERSONA_ID,
          {
            name: "Default",
            description: "Your default chat identity",
            prompt: "",
          },
          true,
        );
      if (!(await this.state(db, STARTER_SEED))) {
        const deleted = await this.state(db, STARTER_DELETED);
        const tombstone = await db.getFirstAsync(
          "SELECT entity_id FROM persona_tombstones WHERE entity_id=?",
          STARTER_PERSONA_ID,
        );
        const starter = await db.getFirstAsync(
          "SELECT id FROM personas WHERE id=?",
          STARTER_PERSONA_ID,
        );
        if (!deleted && !tombstone && !starter)
          await this.insert(
            db,
            STARTER_PERSONA_ID,
            {
              name: "AI Chat assistant",
              description: "A friendly starting point you can edit or delete",
              prompt:
                "You are a helpful assistant for private, on-your-own-terms chat. Give clear, practical answers. Ask for missing information when needed and acknowledge uncertainty.",
            },
            false,
          );
        await this.setState(db, STARTER_SEED, "installed");
      }
    });
  }

  async list(): Promise<PersonaRecord[]> {
    return this.readPersonas(this.db);
  }

  private async readPersonas(db: SQLiteDatabasePort): Promise<PersonaRecord[]> {
    const rows = await db.getAllAsync<PersonaRow>(
      `${SELECT_PERSONAS} ORDER BY p.is_default DESC,p.created_at,p.id`,
    );
    return rows.map(decodePersona);
  }

  async get(id: string): Promise<PersonaRecord | null> {
    return this.readPersona(this.db, id);
  }

  private async readPersona(
    db: SQLiteDatabasePort,
    id: string,
  ): Promise<PersonaRecord | null> {
    EntityIdSchema.parse(id);
    const row = await db.getFirstAsync<PersonaRow>(
      `${SELECT_PERSONAS} AND p.id=?`,
      id,
    );
    return row ? decodePersona(row) : null;
  }

  async create(input: PersonaDraft & { id?: string }): Promise<PersonaRecord> {
    const id = EntityIdSchema.parse(input.id ?? this.options.createId());
    return this.mutate(async (db) => {
      const deleted = await db.getFirstAsync(
        "SELECT entity_id FROM persona_tombstones WHERE entity_id=?",
        id,
      );
      const existing = await db.getFirstAsync(
        "SELECT id FROM personas WHERE id=?",
        id,
      );
      if (deleted || existing)
        throw new PersonaLibraryError(
          "conflict",
          "This Persona identity is already used. Create a new Persona instead.",
        );
      return this.insert(db, id, input, false);
    });
  }

  async update(id: string, input: PersonaEdit): Promise<PersonaRecord> {
    return this.mutate(async (db) => {
      const current = await this.require(db, id);
      if (
        input.expectedRevision &&
        compareRevision(
          RevisionSchema.parse(input.expectedRevision),
          current.revision,
        ) !== 0
      )
        throw new PersonaLibraryError(
          "conflict",
          "This Persona was edited elsewhere. Reload its profile before saving.",
        );
      const name = normalizeName(input.name ?? current.name);
      const description = normalizeText(
        input.description ?? current.description,
        4096,
        "Description",
      );
      const prompt = normalizeText(
        input.prompt ?? current.prompt,
        65536,
        "System prompt",
      );
      const appearance = normalizeAppearance({
        ...current.appearance,
        ...input.appearance,
      });
      const profile = normalizeProfile(
        { ...current.profile, ...input.profile },
        description,
        prompt,
        appearance,
      );
      const photo =
        input.photoAttachmentId === undefined
          ? current.photoAttachmentId
          : input.photoAttachmentId;
      if (photo !== null) EntityIdSchema.parse(photo);
      const timestamp = this.timestamp();
      const revision = this.nextRevision(current.revision, timestamp);
      const entity = PersonaSchema.parse({
        id,
        name,
        profile,
        photoAttachmentId: photo,
        modelId: current.modelId,
        parameterPresetId: current.parameterPresetId,
        createdAt: current.createdAt,
        updatedAt: timestamp,
        revision,
      });
      await db.runAsync(
        "UPDATE personas SET name=?,description=?,prompt=?,updated_at=? WHERE id=?",
        name,
        description || null,
        prompt,
        timestamp,
        id,
      );
      await this.saveMetadata(db, entity);
      return {
        ...entity,
        description,
        prompt,
        appearance,
        isDefault: current.isDefault,
        isStarter: current.isStarter,
      };
    });
  }

  async delete(id: string): Promise<void> {
    await this.mutate(async (db) => {
      const current = await this.readPersona(db, id);
      if (!current) {
        if (
          await db.getFirstAsync(
            "SELECT entity_id FROM persona_tombstones WHERE entity_id=?",
            id,
          )
        )
          return;
        throw new PersonaLibraryError(
          "missing",
          "This Persona is no longer available.",
        );
      }
      if (current.isDefault)
        throw new PersonaLibraryError(
          "protected",
          "The Default profile cannot be deleted.",
        );
      const timestamp = this.timestamp();
      const tombstone = TombstoneSchema.parse({
        id,
        entityId: id,
        entityType: "persona",
        createdAt: current.createdAt,
        updatedAt: timestamp,
        revision: this.nextRevision(current.revision, timestamp),
      });
      await db.runAsync(
        "INSERT INTO persona_tombstones (entity_id,tombstone_json) VALUES (?,?)",
        id,
        JSON.stringify(tombstone),
      );
      if (id === STARTER_PERSONA_ID)
        await this.setState(db, STARTER_DELETED, "deleted");
      // Selection falls back to Default. Transcript rows and captured run identities remain intact.
      await db.runAsync(
        "UPDATE conversation_personas SET persona_id=NULL WHERE persona_id=?",
        id,
      );
      await db.runAsync("DELETE FROM personas WHERE id=?", id);
    });
  }

  async tombstones(): Promise<PersonaTombstone[]> {
    const rows = await this.db.getAllAsync<{ tombstone_json: string }>(
      "SELECT tombstone_json FROM persona_tombstones ORDER BY entity_id",
    );
    return rows.map((row) =>
      TombstoneSchema.parse(JSON.parse(row.tombstone_json)),
    );
  }

  async selected(conversationId: string): Promise<PersonaRecord> {
    return this.selectedPersona(this.db, conversationId);
  }

  private async selectedPersona(
    db: SQLiteDatabasePort,
    conversationId: string,
  ): Promise<PersonaRecord> {
    EntityIdSchema.parse(conversationId);
    const selected = await db.getFirstAsync<{ persona_id: string | null }>(
      "SELECT persona_id FROM conversation_personas WHERE conversation_id=?",
      conversationId,
    );
    const persona = selected?.persona_id
      ? await this.readPersona(db, selected.persona_id)
      : null;
    if (persona) return persona;
    const fallback = (await this.readPersonas(db)).find(
      (item) => item.isDefault,
    );
    if (!fallback)
      throw new PersonaLibraryError(
        "missing",
        "The Default profile is unavailable. Reopen the Persona library.",
      );
    return fallback;
  }

  async select(
    conversationId: string,
    personaId: string,
  ): Promise<PersonaSwitchIntent> {
    EntityIdSchema.parse(conversationId);
    await this.mutate(async (db) => {
      await this.require(db, personaId);
      const conversation = await db.getFirstAsync(
        "SELECT id FROM conversations WHERE id=?",
        conversationId,
      );
      if (!conversation)
        throw new PersonaLibraryError(
          "missing",
          "Open a saved conversation before switching its Persona.",
        );
      await db.runAsync(
        `INSERT INTO conversation_personas (conversation_id,persona_id,selected_at) VALUES (?,?,?)
         ON CONFLICT(conversation_id) DO UPDATE SET persona_id=excluded.persona_id,selected_at=excluded.selected_at`,
        conversationId,
        personaId,
        this.timestamp(),
      );
    });
    return {
      kind: "switch-persona",
      conversationId,
      personaId,
      preserveTranscript: true,
      appliesTo: "next-run",
    };
  }

  async chatIntent(
    personaId: string,
    conversationId = this.options.createId(),
  ): Promise<PersonaChatIntent> {
    EntityIdSchema.parse(conversationId);
    const persona = await this.require(this.db, personaId);
    return {
      kind: "individual-chat",
      conversationId,
      personaId,
      title: `Chat with ${persona.name}`,
      identity: snapshot(persona),
    };
  }

  async groupIntent(
    personaId: string,
    groupRoomId?: string,
  ): Promise<PersonaGroupIntent> {
    if (groupRoomId !== undefined) EntityIdSchema.parse(groupRoomId);
    return {
      kind: "add-persona-to-group",
      personaId,
      ...(groupRoomId ? { groupRoomId } : {}),
      identity: snapshot(await this.require(this.db, personaId)),
    };
  }

  async snapshotForNextRun(
    conversationId: string,
  ): Promise<PersonaRunSnapshot> {
    return snapshot(await this.selected(conversationId));
  }

  /** Persist once. Pass the pre-send snapshot when the engine allocates run IDs internally. */
  async captureRun(
    conversationId: string,
    runId: string,
    identity?: PersonaRunSnapshot,
  ): Promise<PersonaRunSnapshot> {
    EntityIdSchema.parse(conversationId);
    EntityIdSchema.parse(runId);
    return this.mutate(async (db) => {
      const existing = await db.getFirstAsync<{
        conversation_id: string;
        snapshot_json: string;
      }>(
        "SELECT conversation_id,snapshot_json FROM persona_run_snapshots WHERE run_id=?",
        runId,
      );
      if (existing) {
        if (existing.conversation_id !== conversationId)
          throw new PersonaLibraryError(
            "conflict",
            "A run identity cannot be reused in another conversation.",
          );
        return parseSnapshot(existing.snapshot_json);
      }
      const captured = identity
        ? parseSnapshot(JSON.stringify(identity))
        : snapshot(await this.selectedPersona(db, conversationId));
      await db.runAsync(
        "INSERT INTO persona_run_snapshots (run_id,conversation_id,snapshot_json,captured_at) VALUES (?,?,?,?)",
        runId,
        conversationId,
        JSON.stringify(captured),
        this.timestamp(),
      );
      return captured;
    });
  }

  private async insert(
    db: SQLiteDatabasePort,
    id: string,
    input: PersonaDraft,
    isDefault: boolean,
  ): Promise<PersonaRecord> {
    const timestamp = this.timestamp();
    const name = normalizeName(input.name);
    const description = normalizeText(
      input.description ?? "",
      4096,
      "Description",
    );
    const prompt = normalizeText(input.prompt ?? "", 65536, "System prompt");
    const appearance = normalizeAppearance(input.appearance ?? {});
    const profile = normalizeProfile(
      input.profile ?? {},
      description,
      prompt,
      appearance,
    );
    const entity = PersonaSchema.parse({
      id,
      name,
      profile,
      photoAttachmentId: input.photoAttachmentId ?? null,
      modelId: null,
      parameterPresetId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: this.nextRevision(undefined, timestamp),
    });
    await db.runAsync(
      "INSERT INTO personas (id,name,description,prompt,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      id,
      name,
      description || null,
      prompt,
      isDefault ? 1 : 0,
      timestamp,
      timestamp,
    );
    await this.saveMetadata(db, entity);
    return {
      ...entity,
      description,
      prompt,
      appearance,
      isDefault,
      isStarter: id === STARTER_PERSONA_ID,
    };
  }

  private async saveMetadata(
    db: SQLiteDatabasePort,
    entity: PersonaEntity,
  ): Promise<void> {
    await db.runAsync(
      `INSERT INTO persona_profiles (persona_id,profile_json,photo_attachment_id,model_id,parameter_preset_id,revision_wall_ms,revision_counter,revision_device_id)
       VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(persona_id) DO UPDATE SET
       profile_json=excluded.profile_json,photo_attachment_id=excluded.photo_attachment_id,
       model_id=excluded.model_id,parameter_preset_id=excluded.parameter_preset_id,
       revision_wall_ms=excluded.revision_wall_ms,revision_counter=excluded.revision_counter,revision_device_id=excluded.revision_device_id`,
      entity.id,
      JSON.stringify(entity.profile),
      entity.photoAttachmentId,
      entity.modelId,
      entity.parameterPresetId,
      entity.revision.wallMs,
      entity.revision.counter,
      entity.revision.deviceId,
    );
  }

  private async require(
    db: SQLiteDatabasePort,
    id: string,
  ): Promise<PersonaRecord> {
    const persona = await this.readPersona(db, id);
    if (!persona)
      throw new PersonaLibraryError(
        "missing",
        "This Persona is no longer available.",
      );
    return persona;
  }
  private timestamp(): string {
    return IsoTimestampSchema.parse(this.now().toISOString());
  }
  private nextRevision(
    previous: Revision | undefined,
    timestamp: string,
  ): Revision {
    if (!this.deviceId)
      throw new PersonaLibraryError(
        "schema-required",
        "Initialize the Persona library before editing it.",
      );
    const wallMs = Math.max(0, Date.parse(timestamp));
    return RevisionSchema.parse({
      wallMs: Math.max(wallMs, previous?.wallMs ?? 0),
      counter: previous && wallMs <= previous.wallMs ? previous.counter + 1 : 0,
      deviceId: this.deviceId,
    });
  }
  private async state(
    db: SQLiteDatabasePort,
    key: string,
  ): Promise<string | undefined> {
    const row = await db.getFirstAsync<{ value: string }>(
      "SELECT value FROM persona_library_state WHERE key=?",
      key,
    );
    return row?.value;
  }
  private async setState(
    db: SQLiteDatabasePort,
    key: string,
    value: string,
  ): Promise<void> {
    await db.runAsync(
      "INSERT INTO persona_library_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      value,
    );
  }
  private async mutate<T>(
    work: (db: SQLiteDatabasePort) => Promise<T>,
  ): Promise<T> {
    const previous = mutationQueues.get(this.db) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        let result!: T;
        await this.db.withTransactionAsync(
          async (transaction?: SQLiteDatabasePort) => {
            result = await work(transaction ?? this.db);
          },
        );
        return result;
      });
    mutationQueues.set(this.db, next);
    return next;
  }
}

function decodePersona(row: PersonaRow): PersonaRecord {
  const rawProfile = JSON.parse(row.profile_json) as Record<string, unknown>;
  const appearance = normalizeAppearance(
    (rawProfile.appearance ?? {}) as Partial<PersonaAppearance>,
  );
  const description = row.description ?? "";
  const profile = normalizeProfile(
    rawProfile,
    description,
    row.prompt,
    appearance,
  );
  const entity = PersonaSchema.parse({
    id: row.id,
    name: row.name,
    profile,
    photoAttachmentId: row.photo_attachment_id,
    modelId: row.model_id,
    parameterPresetId: row.parameter_preset_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: {
      wallMs: row.revision_wall_ms,
      counter: row.revision_counter,
      deviceId: row.revision_device_id,
    },
  });
  return {
    ...entity,
    description,
    prompt: row.prompt,
    appearance,
    isDefault: row.is_default === 1,
    isStarter: row.id === STARTER_PERSONA_ID,
  };
}

function normalizeName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 120)
    throw new PersonaLibraryError(
      "invalid",
      "Enter a Persona name between 1 and 120 characters.",
    );
  return name;
}
function normalizeText(value: string, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length > maximum)
    throw new PersonaLibraryError(
      "invalid",
      `${label} exceeds its size limit.`,
    );
  return value;
}
function normalizeAppearance(
  value: Partial<PersonaAppearance>,
): PersonaAppearance {
  const appearance = { ...DEFAULT_PERSONA_APPEARANCE, ...value };
  if (
    ![appearance.accentColor, appearance.backgroundColor].every(
      (color) => typeof color === "string" && /^#[\da-f]{6}$/i.test(color),
    )
  )
    throw new PersonaLibraryError(
      "invalid",
      "Use a six-digit hex color such as #6750A4.",
    );
  if (
    appearance.avatarShape !== "circle" &&
    appearance.avatarShape !== "square"
  )
    throw new PersonaLibraryError(
      "invalid",
      "Choose a circle or square avatar.",
    );
  return appearance;
}
function normalizeProfile(
  profile: Readonly<Record<string, unknown>>,
  description: string,
  prompt: string,
  appearance: PersonaAppearance,
): Record<string, unknown> {
  const value = { ...profile, description, systemPrompt: prompt, appearance };
  let encoded: string;
  try {
    encoded = JSON.stringify(value, (key, entry: unknown) => {
      if (
        /(?:api.?key|credential|authorization|password|access.?token|refresh.?token|secret)/i.test(
          key,
        )
      )
        throw new PersonaLibraryError(
          "invalid",
          "Store credentials in secure storage, outside Persona profiles.",
        );
      if (
        entry !== null &&
        (typeof entry === "function" ||
          typeof entry === "symbol" ||
          typeof entry === "bigint")
      )
        throw new PersonaLibraryError(
          "invalid",
          "Persona profiles require JSON data.",
        );
      return entry;
    });
  } catch (cause) {
    if (cause instanceof PersonaLibraryError) throw cause;
    throw new PersonaLibraryError(
      "invalid",
      "Persona profiles require JSON data.",
    );
  }
  if (encoded.length > 131072)
    throw new PersonaLibraryError(
      "invalid",
      "Persona profile exceeds its size limit.",
    );
  return JSON.parse(encoded) as Record<string, unknown>;
}
function snapshot(persona: PersonaRecord): PersonaRunSnapshot {
  return deepFreeze(
    JSON.parse(
      JSON.stringify({
        personaId: persona.id,
        name: persona.name,
        prompt: persona.prompt,
        description: persona.description,
        photoAttachmentId: persona.photoAttachmentId,
        appearance: persona.appearance,
        profile: persona.profile,
        revision: persona.revision,
      }),
    ) as PersonaRunSnapshot,
  );
}
function parseSnapshot(json: string): PersonaRunSnapshot {
  const value = JSON.parse(json) as PersonaRunSnapshot;
  EntityIdSchema.parse(value.personaId);
  RevisionSchema.parse(value.revision);
  if (value.photoAttachmentId !== null)
    EntityIdSchema.parse(value.photoAttachmentId);
  normalizeName(value.name);
  normalizeText(value.prompt, 65536, "System prompt");
  normalizeText(value.description, 4096, "Description");
  normalizeAppearance(value.appearance);
  normalizeProfile(
    value.profile,
    value.description,
    value.prompt,
    value.appearance,
  );
  return deepFreeze(value);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}
