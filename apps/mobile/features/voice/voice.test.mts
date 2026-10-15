import { describe, expect, it } from "vitest";
import type { PersonaRecord } from "@locallab/personas-library";
import {
  DEFAULT_VOICE_PREFERENCES,
  effectiveVoiceControls,
  parseVoicePreferences,
  personaVoicePatch,
  resolveReadAloudTarget,
  resolveVoicePreferences,
  serializeVoicePreferences,
  parsePersonaVoice,
  SQLiteTranscriptionImportStore,
  SQLiteVoicePreferenceStore,
  type ImportedTranscription,
  type VoicePreferences,
} from "./index.ts";

type FakeRow = Record<string, string | number>;

function fakeDb() {
  const settings: { row: FakeRow | null } = { row: null };
  const imports: FakeRow[] = [];
  const db = {
    execAsync: async () => undefined,
    getFirstAsync: async () => settings.row,
    getAllAsync: async () =>
      [...imports].sort((a, b) => (b.created_at as number) - (a.created_at as number)),
    runAsync: async (sql: string, ...params: (string | number)[]) => {
      if (sql.startsWith("INSERT INTO voice_preferences"))
        settings.row = { singleton: 1, settings: String(params[0]) };
      else if (sql.startsWith("INSERT INTO voice_transcription_imports"))
        imports.push({
          id: params[0],
          name: params[1],
          audio_path: params[2],
          transcript: params[3],
          created_at: params[4],
        });
      else if (sql.startsWith("DELETE FROM voice_transcription_imports"))
        imports.splice(
          imports.findIndex((row) => row.id === params[0]),
          1,
        );
    },
  };
  return { db, imports };
}

const prefs = (patch: Partial<VoicePreferences>): VoicePreferences => ({
  ...DEFAULT_VOICE_PREFERENCES,
  ...patch,
});

describe("voice preferences", () => {
  it("round-trips defaults through serialization", () => {
    expect(parseVoicePreferences(serializeVoicePreferences(DEFAULT_VOICE_PREFERENCES))).toEqual(
      DEFAULT_VOICE_PREFERENCES,
    );
  });

  it("falls back to defaults for unusable stored text", () => {
    expect(parseVoicePreferences("not json")).toEqual(DEFAULT_VOICE_PREFERENCES);
    expect(parseVoicePreferences("[1,2]")).toEqual(DEFAULT_VOICE_PREFERENCES);
    expect(parseVoicePreferences(JSON.stringify({ rate: "fast" }))).toEqual(
      DEFAULT_VOICE_PREFERENCES,
    );
  });

  it("repairs out-of-range fields without discarding the rest", () => {
    const stored = {
      autoRead: true,
      engine: "offline",
      rate: 9,
      pitch: -3,
      silenceTimeoutMs: 1,
      maxListeningMs: 99_999_999,
      locale: "en-US",
    };
    expect(parseVoicePreferences(JSON.stringify(stored))).toEqual(
      prefs({
        autoRead: true,
        rate: 2,
        pitch: 0.5,
        silenceTimeoutMs: 300,
        maxListeningMs: 300_000,
        locale: "en-US",
      }),
    );
  });

  it("clamps the rate to the stored engine's legal range", () => {
    expect(
      resolveVoicePreferences({ engine: "elevenlabs", rate: 1.9 }).rate,
    ).toBe(1.2);
    expect(resolveVoicePreferences({ engine: "xai", rate: 0.2 }).rate).toBe(0.7);
    expect(resolveVoicePreferences({ engine: "nonsense" }).engine).toBe(
      "offline",
    );
  });

  it("hides controls the engine cannot honor but keeps stored values", () => {
    const value = prefs({ engine: "offline", pitch: 1.4 });
    expect(effectiveVoiceControls(value)).toEqual({ rate: 1 });
    expect(value.pitch).toBe(1.4);
    expect(effectiveVoiceControls(prefs({ engine: "system", pitch: 1.4 }))).toEqual(
      { rate: 1, pitch: 1.4 },
    );
    expect(
      effectiveVoiceControls(
        prefs({ engine: "elevenlabs", rate: 1.8 }),
        "elevenlabs",
      ).rate,
    ).toBe(1.2);
    expect(effectiveVoiceControls(prefs({ engine: "xai" })).pitch).toBeUndefined();
  });

  it("persists preferences through the app SQLite port", async () => {
    const { db } = fakeDb();
    const store = new SQLiteVoicePreferenceStore(db);
    expect(await store.load()).toBeNull();
    const next = prefs({ autoRead: true, engine: "system", pitch: 0.8 });
    await store.save(next);
    expect(await store.load()).toEqual(next);
    await store.save(prefs({ autoRead: false }));
    expect(await store.load()).toEqual(prefs({ autoRead: false }));
  });
});

describe("persona voice bindings", () => {
  const personaWith = (profile: Record<string, unknown>): PersonaRecord =>
    ({ profile }) as PersonaRecord;

  it("reads engine, voice, connection and rate from the profile", () => {
    expect(
      parsePersonaVoice(
        personaWith({
          speechEngine: "xai",
          speechVoice: "eve",
          speechConnectionId: "conn-1",
          speechRate: 1.2,
        }).profile,
      ),
    ).toEqual({
      engine: "xai",
      voiceId: "eve",
      connectionId: "conn-1",
      rate: 1.2,
    });
  });

  it("keeps the legacy speechVoiceId fallback and ignores junk", () => {
    expect(parsePersonaVoice(undefined)).toEqual({
      engine: undefined,
      voiceId: undefined,
      connectionId: undefined,
      rate: undefined,
    });
    expect(
      parsePersonaVoice(
        personaWith({
          speechVoiceId: "af_nova",
          speechEngine: "not-an-engine",
          speechConnectionId: "   ",
        }).profile,
      ),
    ).toEqual({
      engine: undefined,
      voiceId: "af_nova",
      connectionId: undefined,
      rate: undefined,
    });
    expect(
      parsePersonaVoice(personaWith({ speechVoiceId: "default" }).profile)
        .voiceId,
    ).toBeUndefined();
  });

  it("patches only the keys the caller touched", () => {
    expect(personaVoicePatch({ engine: "system", voiceId: null })).toEqual({
      speechEngine: "system",
      speechVoice: null,
    });
    expect(personaVoicePatch({})).toEqual({});
  });
});

describe("read-aloud target resolution", () => {
  const personaWith = (profile: Record<string, unknown>): PersonaRecord =>
    ({ profile }) as PersonaRecord;

  it("defaults to the offline engine and app voice", () => {
    expect(resolveReadAloudTarget(prefs({ voiceId: "af_heart" }), undefined)).toEqual(
      { kind: "offline", rate: 1, voiceId: "af_heart" },
    );
    expect(resolveReadAloudTarget(DEFAULT_VOICE_PREFERENCES, undefined)).toEqual({
      kind: "offline",
      rate: 1,
    });
  });

  it("lets the Persona binding override the app default", () => {
    const persona = personaWith({
      speechEngine: "system",
      speechRate: 1.3,
    });
    expect(
      resolveReadAloudTarget(
        prefs({ engine: "offline", rate: 0.75, pitch: 1.5, locale: "de-DE" }),
        persona,
      ),
    ).toEqual({ kind: "system", rate: 1.3, pitch: 1.5, language: "de-DE" });
  });

  it("requires a voice and connection before promising a cloud voice", () => {
    const bound = personaWith({
      speechEngine: "elevenlabs",
      speechVoice: "brian",
      speechConnectionId: "conn-el",
      speechRate: 2,
    });
    expect(resolveReadAloudTarget(DEFAULT_VOICE_PREFERENCES, bound)).toEqual({
      kind: "cloud",
      provider: "elevenlabs",
      connectionId: "conn-el",
      voiceId: "brian",
      speed: 1.2,
    });
    const missingConnection = personaWith({
      speechEngine: "xai",
      speechVoice: "eve",
    });
    const unbound = resolveReadAloudTarget(
      DEFAULT_VOICE_PREFERENCES,
      missingConnection,
    );
    expect(unbound.kind).toBe("unbound");
    if (unbound.kind === "unbound")
      expect(unbound.message).toContain("xAI");
  });
});

describe("transcription import store", () => {
  const record = (
    id: string,
    createdAt: number,
    name = "clip.m4a",
  ): ImportedTranscription => ({
    id,
    name,
    audioUri: `file:///doc/voice-transcriptions/${id}.m4a`,
    text: "hello",
    createdAt,
  });

  it("adds, lists newest first and removes", async () => {
    const { db } = fakeDb();
    const store = new SQLiteTranscriptionImportStore(db);
    expect(await store.list()).toEqual([]);
    await store.add(record("older01", 1_000));
    await store.add(record("newest01", 2_000, "second.mp3"));
    const listed = await store.list();
    expect(listed.map((item) => item.id)).toEqual(["newest01", "older01"]);
    expect(listed[0]?.name).toBe("second.mp3");
    await store.remove("newest01");
    expect((await store.list()).map((item) => item.id)).toEqual(["older01"]);
  });

  it("rejects unusable rows instead of storing broken players", async () => {
    const { db } = fakeDb();
    const store = new SQLiteTranscriptionImportStore(db);
    await expect(store.add(record("bad", 1, "   "))).rejects.toThrow(
      /name is required/,
    );
    await expect(
      store.add({ ...record("bad2", 1), audioUri: " " }),
    ).rejects.toThrow(/audio path is required/);
    await expect(store.add(record("!!", 1))).rejects.toThrow(/id is invalid/);
    expect(await store.list()).toEqual([]);
  });
});
