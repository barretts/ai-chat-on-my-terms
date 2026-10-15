/**
 * T099 — selective Persona, photo and memory sync (SY-10).
 *
 * Personas ride the SAME sync envelope as chat (T098C) but cross the pair
 * only under an EXPLICIT per-persona selection that additionally requires
 * chat sync to be enabled for the route (SY-01 gate). The eligibility
 * rules here are the wall on BOTH the enqueue and the receive side:
 *
 *  - persona records/tombstones: only personas in `personaIds`;
 *  - memory records: rules read from the INCOMING payload (a first-time
 *    arrival has no local row): persona-scoped only for selected personas
 *    (when `memories` is on); conversation-scoped only when the
 *    conversation is already synced; global-scoped NEVER crosses (private
 *    user memory). Memory TOMBSTONES fall back to the local row. This is
 *    what keeps non-selected private memory and credentials out of the
 *    pair;
 *  - attachment records/tombstones (photos): only attachments referenced
 *    as `photoAttachmentId` by a SELECTED persona (local lookup, or a
 *    selected Persona ARRIVING in the same batch — R016: an initial copy
 *    ships a persona and its photo together, the photo sorting first,
 *    and a chunk boundary can split the pair across batches), and only
 *    when `photos` is on.
 *
 * Device-local model/preset/voice/provider/key references are NEVER
 * rewritten: they arrive as opaque ids the target resolves explicitly,
 * and `resolvePersonaBindings` turns each into a visible
 * resolved/unavailable decision without copying the device-local target.
 */
import { z } from "zod";
import { EntityIdSchema } from "@locallab/contracts/identity";
import { AttachmentSchema, MemoryEntrySchema, PersonaSchema } from "@locallab/contracts/entities";

type Persona = z.infer<typeof PersonaSchema>;
type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
type Attachment = z.infer<typeof AttachmentSchema>;

export type SyncPersonaErrorKind = "malformed" | "state";

export class SyncPersonaError extends Error {
  readonly kind: SyncPersonaErrorKind;
  constructor(kind: SyncPersonaErrorKind, message: string) {
    super(message);
    this.name = "SyncPersonaError";
    this.kind = kind;
  }
}

export const PersonaSyncSelectionSchema = z
  .object({
    routeId: EntityIdSchema,
    personaIds: z.array(EntityIdSchema),
    photos: z.boolean(),
    memories: z.boolean(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type PersonaSyncSelection = z.infer<typeof PersonaSyncSelectionSchema>;

/** Vault port for per-route persona selections (same shape as T098A). */
export interface PersonaSelectionVault {
  load(): Promise<readonly PersonaSyncSelection[]>;
  save(rows: readonly PersonaSyncSelection[]): Promise<void>;
}

/** Entity types that belong to the persona tier (vs the chat tier). */
export const PERSONA_TIER_TYPES: Record<string, z.ZodType> = {
  persona: PersonaSchema,
  memory: MemoryEntrySchema,
  attachment: AttachmentSchema,
};

export function isPersonaTierType(entityType: string): boolean {
  return PERSONA_TIER_TYPES[entityType] !== undefined;
}

/**
 * Everything the gate needs to know about the LOCAL live set, injected by
 * the host (typically backed by the engine's MergeStore) so the rules
 * stay pure and testable.
 */
export interface PersonaGateContext {
  personaLive(personaId: string): { photoAttachmentId: string | null } | null;
  memoryLive(memoryId: string): { scope: string; scopeId: string | null } | null;
  attachmentOwner(attachmentId: string): string | null;
  conversationSynced(conversationId: string): boolean;
  /** Any local row (live OR tombstone) for this persona-tier entity. */
  localRowExists(entityType: string, entityId: string): boolean;
}

/**
 * Build the persona-tier admission gate for a route. `selection === null`
 * means persona sync was never opted in: NOTHING persona-tier passes
 * (the SY-03 chat-tier wall is unaffected either way). `payload` is the
 * incoming change's payload (absent/null for tombstones) — the gate
 * trusts it only through schema validation and falls back to the local
 * live row. TOMBSTONES of rows the local store already carries always
 * pass (a deletion cannot leak private content; it must propagate so
 * both sides converge).
 */
export function personaTierGate(
  selection: PersonaSyncSelection | null,
  ctx: PersonaGateContext,
): (
  entityType: string,
  entityId: string,
  payload?: unknown,
  batchPersonas?: readonly { entityId: string; payload: unknown }[],
) => boolean {
  if (selection === null) return () => false;
  const selected = new Set(selection.personaIds);
  return (entityType, entityId, payload, batchPersonas) => {
    const tombstone = payload === undefined || payload === null;
    if (entityType === "persona") return selected.has(entityId);
    if (entityType === "memory") {
      if (!selection.memories) return false;
      const scoped = MemoryEntrySchema.safeParse(payload ?? null);
      if (scoped.success) {
        const { scope, scopeId } = scoped.data;
        if (scope === "persona") return scopeId !== null && selected.has(scopeId);
        if (scope === "conversation") return scopeId !== null && ctx.conversationSynced(scopeId);
        return false; // global memory is private
      }
      const view = ctx.memoryLive(entityId);
      if (view !== null) {
        if (view.scope === "persona") return view.scopeId !== null && selected.has(view.scopeId);
        if (view.scope === "conversation") return view.scopeId !== null && ctx.conversationSynced(view.scopeId);
        return false;
      }
      return tombstone && ctx.localRowExists("memory", entityId);
    }
    if (entityType === "attachment") {
      if (!selection.photos) return false;
      const owner = ctx.attachmentOwner(entityId);
      if (owner !== null) return selected.has(owner);
      // R016: the owning persona may ride in the SAME batch (snapshot
      // order sorts attachments first) or in a not-yet-arrived chunk.
      // A photo is admitted only under a persona this pair EXPLICITLY
      // selected; trust the incoming bytes only through validation —
      // unselected or malformed persona records authorize nothing.
      if (!tombstone)
        for (const persona of batchPersonas ?? []) {
          const incoming = PersonaSchema.safeParse(persona.payload);
          if (
            incoming.success &&
            incoming.data.photoAttachmentId === entityId &&
            selected.has(persona.entityId) &&
            selected.has(incoming.data.id)
          )
            return true;
        }
      return tombstone && ctx.localRowExists("attachment", entityId);
    }
    return false;
  };
}

/** Parse persisted selection rows, fail-closed. */
export function parsePersonaSelectionRecords(raw: unknown): PersonaSyncSelection[] {
  const parsed = z.array(PersonaSyncSelectionSchema).safeParse(raw);
  if (!parsed.success) throw new SyncPersonaError("malformed", "persona selection rows failed validation");
  return parsed.data;
}

export function findPersonaSelection(
  rows: readonly PersonaSyncSelection[],
  routeId: string,
): PersonaSyncSelection | null {
  return rows.find((row) => row.routeId === routeId) ?? null;
}

/**
 * Opt a set of personas in for a route (requires the caller to have
 * already enabled chat sync for that route — enforced upstream by
 * syncDataAllowed before a selection is ever consulted).
 */
export function selectPersonas(
  rows: readonly PersonaSyncSelection[],
  routeId: string,
  personaIds: readonly string[],
  opts: { photos: boolean; memories: boolean },
  now: string,
): PersonaSyncSelection[] {
  const parsed = PersonaSyncSelectionSchema.safeParse({
    routeId,
    personaIds: [...personaIds],
    photos: opts.photos,
    memories: opts.memories,
    updatedAt: now,
  });
  if (!parsed.success) throw new SyncPersonaError("malformed", "persona selection failed validation");
  return [...rows.filter((row) => row.routeId !== routeId), parsed.data];
}

export function clearPersonaSelection(
  rows: readonly PersonaSyncSelection[],
  routeId: string,
): PersonaSyncSelection[] {
  if (findPersonaSelection(rows, routeId) === null) {
    throw new SyncPersonaError("state", "persona sync was never opted in for this route");
  }
  return rows.filter((row) => row.routeId !== routeId);
}

// --- binding resolution -------------------------------------------------

export type BindingStatus = "resolved" | "unavailable" | "not-needed";

export interface PersonaBindings {
  photoAttachmentId: BindingStatus;
  modelId: BindingStatus;
  parameterPresetId: BindingStatus;
}

export interface PersonaBindingIndex {
  hasAttachment(attachmentId: string): boolean;
  hasModel(modelId: string): boolean;
  hasPreset(presetId: string): boolean;
}

/**
 * Explicitly resolve a persona's device-local references on the target.
 * A null reference is "not-needed"; a missing local target is
 * "unavailable" — the persona still syncs, the decision is shown to the
 * user, and nothing device-local (voice/provider/key/model binaries)
 * crosses with it.
 */
export function resolvePersonaBindings(persona: Persona, index: PersonaBindingIndex): PersonaBindings {
  const decide = (idValue: string | null, has: (id: string) => boolean): BindingStatus =>
    idValue === null ? "not-needed" : has(idValue) ? "resolved" : "unavailable";
  return {
    photoAttachmentId: decide(persona.photoAttachmentId, (idValue) => index.hasAttachment(idValue)),
    modelId: decide(persona.modelId, (idValue) => index.hasModel(idValue)),
    parameterPresetId: decide(persona.parameterPresetId, (idValue) => index.hasPreset(idValue)),
  };
}

/** Validate persona-tier payloads (used on the receive side). */
export function parsePersonaTierPayload(entityType: string, payload: unknown): Persona | MemoryEntry | Attachment {
  const schema = PERSONA_TIER_TYPES[entityType];
  if (schema === undefined) throw new SyncPersonaError("state", `unknown persona tier type ${entityType}`);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new SyncPersonaError("malformed", `${entityType} payload failed validation`);
  return parsed.data as Persona | MemoryEntry | Attachment;
}
