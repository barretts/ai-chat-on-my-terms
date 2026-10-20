import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import {
  SQLiteGroupConfigStore,
  emptyGroupParticipant,
  type GroupRoomDraft,
} from "@locallab/groups-config";
import {
  directModelSeat,
  groupModelChoices,
  groupSeatChoices,
  newGroupRoomDraft,
  personaSeatFromIntent,
} from ".";

const PERSONA = "0195c000-0000-7000-8000-0000000000b1";
const CONNECTION = "0195c000-0000-7000-8000-0000000000b2";

describe("group setup helpers", () => {
  it("seats a Persona by identity from the add-to-group intent", () => {
    const seat = personaSeatFromIntent({
      kind: "add-persona-to-group",
      personaId: PERSONA,
      identity: {
        personaId: PERSONA,
        name: "Ada Lovelace",
        prompt: "",
        description: "",
        photoAttachmentId: null,
        appearance: {
          initials: "AL",
          shape: "circle",
          accentColor: "#000000",
          backgroundColor: "#ffffff",
        },
        profile: {},
        revision: { wallMs: 1, counter: 1, deviceId: "" },
      },
    });
    expect(seat.personaId).toBe(PERSONA);
    expect(seat.providerConnectionId).toBeNull();
    expect(seat.displayName).toBe("Ada Lovelace");
  });

  it("binds a direct model seat to the connection identity and exact model", () => {
    const seat = directModelSeat({
      id: CONNECTION,
      label: "Lab",
      modelId: "llama-3.3-70b",
    });
    expect(seat.providerConnectionId).toBe(CONNECTION);
    expect(seat.modelId).toBe("llama-3.3-70b");
    expect(seat.personaId).toBeNull();
  });

  it("offers personas before direct connections with distinct details", () => {
    const choices = groupSeatChoices(
      [{ id: PERSONA, name: "Ada" }],
      [{ id: CONNECTION, label: "Lab", modelId: "llama" }],
    );
    expect(choices[0]).toEqual({
      value: `persona:${PERSONA}`,
      label: "Ada",
      detail: "Persona",
    });
    expect(choices[1]?.value).toBe(`connection:${CONNECTION}`);
    expect(choices[1]?.detail).toContain("direct model");
  });

  it("starts a fresh room draft empty", () => {
    const draft = newGroupRoomDraft("0195c000-0000-7000-8000-0000000000c1");
    expect(draft.id).toBeNull();
    expect(draft.participants).toEqual([]);
  });
});

const CONVERSATION = "0195c000-0000-7000-8000-0000000000c1";

function adapter(database: DatabaseSync): SQLiteDatabasePort {
  return {
    execAsync: async (sql) => database.exec(sql),
    runAsync: async (sql, ...params: SqliteBindValue[]) =>
      database.prepare(sql).run(...params),
    getFirstAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      (database.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      database.prepare(sql).all(...params) as T[],
    withTransactionAsync: async (work) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        await work();
        database.exec("COMMIT");
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
  };
}

const id = (n: number) =>
  `0195c000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
let nextId = 900;
const createId = () => id(nextId++);

describe("room settings persistence", () => {
  it("maps installed models to blob: shared-model choices", () => {
    expect(
      groupModelChoices([
        { blobId: "b1", name: "Liquid LFM2.5-2.6B" },
        { blobId: "", name: "ignored" },
      ]),
    ).toEqual([{ value: "blob:b1", label: "Liquid LFM2.5-2.6B" }]);
  });

  it("persists room settings and per-seat drunk through saveRoom/loadRoom", async () => {
    const database = new DatabaseSync(":memory:");
    const port = adapter(database);
    await SQLiteGroupConfigStore.initialize(port);
    const config = new SQLiteGroupConfigStore(port);
    const draft: GroupRoomDraft = {
      id: null,
      name: "War room",
      scenario: "Ship-day standup",
      userDisplayName: "Barrett",
      conversationId: CONVERSATION,
      settings: {
        conversationMode: "independent",
        speakerOrder: "dice",
        replyDisplay: "live",
        sharedModelId: "blob:cafe",
        responseLimitTokens: 320,
      },
      participants: [
        {
          ...emptyGroupParticipant(),
          personaId: PERSONA,
          displayName: "Ada",
          drunk: true,
        },
        {
          ...emptyGroupParticipant(),
          personaId: PERSONA,
          displayName: "Grace",
          drunk: false,
        },
      ],
    };
    const roomId = await config.saveRoom(draft, createId);
    const loaded = await config.loadRoom(roomId);
    expect(loaded?.settings).toEqual(draft.settings);
    expect(loaded?.participants.map((seat) => seat.drunk)).toEqual([
      true,
      false,
    ]);
  });
});
