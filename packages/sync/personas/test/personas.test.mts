import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PERSONA_TIER_TYPES,
  SyncPersonaError,
  clearPersonaSelection,
  findPersonaSelection,
  isPersonaTierType,
  parsePersonaSelectionRecords,
  parsePersonaTierPayload,
  personaTierGate,
  resolvePersonaBindings,
  selectPersonas,
} from "../src/index.js";

const hex = (n: number) => n.toString(16).padStart(12, "0");
const id = (n: number) => `0198f2a3-0000-7000-8000-${hex(n)}`;
const ROUTE = id(0xf0);
const PERSONA_A = id(1);
const PERSONA_B = id(2);
const PHOTO_A = id(301);
const PHOTO_B = id(302);
const MEM_PERSONA_A = id(401);
const MEM_PERSONA_B = id(402);
const MEM_CONV = id(403);
const MEM_GLOBAL = id(404);
const CONV_SYNCED = id(51);
const MODEL_LOCAL = id(601);
const MODEL_GONE = id(602);

interface FakeStore {
  personas: Map<string, { photoAttachmentId: string | null }>;
  memories: Map<string, { scope: string; scopeId: string | null }>;
  attachments: Set<string>;
  conversations: Set<string>;
}

function ctxOf(store: FakeStore) {
  return {
    personaLive: (personaId: string) => store.personas.get(personaId) ?? null,
    memoryLive: (memoryId: string) => store.memories.get(memoryId) ?? null,
    attachmentOwner: (attachmentId: string) => {
      for (const [personaId, persona] of store.personas)
        if (persona.photoAttachmentId === attachmentId) return personaId;
      return null;
    },
    conversationSynced: (conversationId: string) => store.conversations.has(conversationId),
    localRowExists: (entityType: string, entityId: string) =>
      entityType === "persona"
        ? store.personas.has(entityId)
        : entityType === "memory"
          ? store.memories.has(entityId)
          : entityType === "attachment" && store.attachments.has(entityId),
  };
}

const selection = {
  routeId: ROUTE,
  personaIds: [PERSONA_A],
  photos: true,
  memories: true,
  updatedAt: "2026-10-01T00:00:00.000Z",
};

function storeWithEverything(): FakeStore {
  return {
    personas: new Map([
      [PERSONA_A, { photoAttachmentId: PHOTO_A }],
      [PERSONA_B, { photoAttachmentId: PHOTO_B }],
    ]),
    memories: new Map([
      [MEM_PERSONA_A, { scope: "persona", scopeId: PERSONA_A }],
      [MEM_PERSONA_B, { scope: "persona", scopeId: PERSONA_B }],
      [MEM_CONV, { scope: "conversation", scopeId: CONV_SYNCED }],
      [MEM_GLOBAL, { scope: "global", scopeId: null }],
    ]),
    attachments: new Set([PHOTO_A, PHOTO_B]),
    conversations: new Set([CONV_SYNCED]),
  };
}

test("persona tier selection admits ONLY the chosen persona and its allowed facts/photos", () => {
  const gate = personaTierGate(selection, ctxOf(storeWithEverything()));
  assert.equal(gate("persona", PERSONA_A), true);
  assert.equal(gate("persona", PERSONA_B), false, "non-selected character never crosses");
  assert.equal(gate("memory", MEM_PERSONA_A), true);
  assert.equal(gate("memory", MEM_PERSONA_B), false, "non-selected private memory never crosses");
  assert.equal(gate("memory", MEM_GLOBAL), false, "global user memory is private");
  assert.equal(gate("memory", MEM_CONV), true, "fact tied to an already-synced conversation");
  assert.equal(gate("attachment", PHOTO_A), true);
  assert.equal(gate("attachment", PHOTO_B), false, "photo of a non-selected character stays local");
});

test("no selection = persona tier is fully closed; toggles cut memories/photos only", () => {
  const closed = personaTierGate(null, ctxOf(storeWithEverything()));
  assert.equal(closed("persona", PERSONA_A), false);
  assert.equal(closed("memory", MEM_PERSONA_A), false);

  const store = storeWithEverything();
  store.conversations.delete(CONV_SYNCED);
  const noMemories = personaTierGate({ ...selection, memories: false }, ctxOf(store));
  assert.equal(noMemories("memory", MEM_PERSONA_A), false);
  assert.equal(noMemories("persona", PERSONA_A), true);
  assert.equal(noMemories("attachment", PHOTO_A), true);

  const noPhotos = personaTierGate({ ...selection, photos: false }, ctxOf(store));
  assert.equal(noPhotos("attachment", PHOTO_A), false);
  assert.equal(noPhotos("memory", MEM_PERSONA_A), true);
});

test("persona tier types are exactly persona/memory/attachment with schema-backed payloads", () => {
  assert.deepEqual(Object.keys(PERSONA_TIER_TYPES).sort(), ["attachment", "memory", "persona"]);
  assert.equal(isPersonaTierType("persona"), true);
  assert.equal(isPersonaTierType("conversation"), false, "chat tier is separate");

  const personaPayload = {
    id: PERSONA_A,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    revision: { wallMs: 1, counter: 0, deviceId: id(900) },
    name: "Ada",
    profile: { prompt: "ship fast" },
    photoAttachmentId: PHOTO_A,
    modelId: MODEL_LOCAL,
    parameterPresetId: null,
  };
  assert.equal(parsePersonaTierPayload("persona", personaPayload).id, PERSONA_A);
  assert.throws(
    () => parsePersonaTierPayload("persona", { ...personaPayload, credentials: { apiKey: "sk-no" } }),
    (error: unknown) => error instanceof SyncPersonaError && error.kind === "malformed",
  );
  assert.throws(
    () => parsePersonaTierPayload("model", personaPayload),
    (error: unknown) => error instanceof SyncPersonaError && error.kind === "state",
  );
});

test("selection rows parse fail-closed; select/clear round-trip per route", () => {
  assert.deepEqual(parsePersonaSelectionRecords([selection]), [selection]);
  assert.throws(
    () => parsePersonaSelectionRecords([{ routeId: ROUTE, personaIds: ["nope"] }]),
    (error: unknown) => error instanceof SyncPersonaError && error.kind === "malformed",
  );

  const withSel = selectPersonas([], ROUTE, [PERSONA_A], { photos: true, memories: false }, "2026-10-02T00:00:00.000Z");
  assert.equal(findPersonaSelection(withSel, ROUTE)!.memories, false);
  const swapped = selectPersonas(withSel, ROUTE, [PERSONA_A, PERSONA_B], { photos: true, memories: true }, "2026-10-03T00:00:00.000Z");
  assert.equal(swapped.length, 1, "one selection row per route");
  assert.equal(findPersonaSelection(swapped, ROUTE)!.personaIds.length, 2);
  assert.equal(findPersonaSelection(swapped, id(0x999)), null);

  const cleared = clearPersonaSelection(swapped, ROUTE);
  assert.equal(findPersonaSelection(cleared, ROUTE), null);
  assert.throws(
    () => clearPersonaSelection(cleared, ROUTE),
    (error: unknown) => error instanceof SyncPersonaError && error.kind === "state",
  );
});

test("device-local bindings resolve explicitly: resolved / unavailable / not-needed", () => {
  const persona = {
    id: PERSONA_A,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    revision: { wallMs: 1, counter: 0, deviceId: id(900) },
    name: "Ada",
    profile: {},
    photoAttachmentId: PHOTO_A,
    modelId: MODEL_GONE,
    parameterPresetId: null,
  };
  const index = {
    hasAttachment: (attachmentId: string) => attachmentId === PHOTO_A,
    hasModel: (modelId: string) => modelId === MODEL_LOCAL,
    hasPreset: () => false,
  };
  assert.deepEqual(resolvePersonaBindings(persona, index), {
    photoAttachmentId: "resolved",
    modelId: "unavailable",
    parameterPresetId: "not-needed",
  });
});
