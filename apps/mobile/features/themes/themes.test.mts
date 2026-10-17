import { describe, expect, it } from "vitest";
import {
  applyThemeV1,
  chatScope,
  createThemesStore,
  decodeOverrideDoc,
  decodeThemeDoc,
  type MobilePaperTheme,
} from "./index";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type {
  AppearanceOverrideV1,
  ThemeV1,
} from "@locallab/themes-schema";

/** Tiny in-memory stand-in understanding only the statements the store uses. */
function fakeThemesDb() {
  const themeState = new Map<string, string>();
  const customThemes = new Map<string, string>();
  const db: SQLiteDatabasePort = {
    async execAsync() {},
    async getFirstAsync<T>(sql: string, ...params: (string | number)[]) {
      const rows = await db.getAllAsync<T>(sql, ...params);
      return rows[0] ?? null;
    },
    async getAllAsync<T>(sql: string, ...params: (string | number)[]) {
      if (sql.startsWith("SELECT scope, doc FROM theme_state WHERE")) {
        const doc = themeState.get(String(params[0]));
        return (doc === undefined
          ? []
          : [{ scope: String(params[0]), doc }]) as T[];
      }
      if (sql.startsWith("SELECT scope, doc FROM theme_state")) {
        return [...themeState].map(([scope, doc]) => ({
          scope,
          doc,
        })) as T[];
      }
      return [...customThemes].map(([id, doc]) => ({ id, doc })) as T[];
    },
    async runAsync(sql: string, ...params: (string | number)[]) {
      if (sql.startsWith("INSERT INTO theme_state")) {
        themeState.set(String(params[0]), String(params[1]));
        return {};
      }
      if (sql.startsWith("INSERT INTO custom_themes")) {
        customThemes.set(String(params[0]), String(params[1]));
        return {};
      }
      if (sql.startsWith("DELETE FROM theme_state")) {
        themeState.delete(String(params[0]));
        return {};
      }
      customThemes.delete(String(params[0]));
      return {};
    },
    async withTransactionAsync(work: () => Promise<void>) {
      await work();
    },
  };
  return { db, themeState, customThemes };
}

function sampleTheme(id = "teal-night"): ThemeV1 {
  return {
    version: 1,
    id,
    name: "Teal Night",
    kind: "custom",
    scheme: "dark",
    palette: {
      background: "#101820",
      surface: "#17242e",
      primary: "#7fd1c8",
      text: "#e6f1f0",
    },
    controls: {
      fontScale: 1.2,
      bubbleStyle: "rounded",
      gradient: { from: "#101820", to: "#274a46", angleDegrees: 90 },
      backgroundDim: 0.2,
      avatarSize: "large",
      avatarPlacement: "trailing",
      fontChoice: "serif",
    },
  };
}

/** Structurally enough of a Paper base for applyThemeV1's repaint surface. */
const fakePaperBase = {
  dark: true,
  colors: {
    background: "#faf9f7",
    surface: "#ffffff",
    primary: "#59328b",
    onSurface: "#26232b",
  },
  fonts: {
    bodyLarge: { fontFamily: "System", fontSize: 16, lineHeight: 24 },
    bodyMedium: { fontFamily: "System", fontSize: 14, lineHeight: 20 },
  },
} as unknown as MobilePaperTheme;

describe("theme and appearance persistence", () => {
  it("per-chat overrides live only in the chat scope and never touch global defaults", async () => {
    const { db, themeState } = fakeThemesDb();
    const store = createThemesStore(db);
    await store.setGlobalThemeId("teal-night");
    const override: AppearanceOverrideV1 = {
      version: 1,
      fontScale: 1.8,
      avatarPlacement: "hidden",
    };
    await store.setChatOverride("conversation-1", override);
    expect(await store.getChatOverride("conversation-1")).toMatchObject({
      version: 1,
      fontScale: 1.8,
      avatarPlacement: "hidden",
    });
    expect(await store.getChatOverride("conversation-2")).toBeNull();
    const state = await store.loadState();
    expect(state.themeId).toBe("teal-night");
    expect(themeState.get("global")).toBe(
      JSON.stringify({ themeId: "teal-night" }),
    );
  });

  it("clearing a chat override deletes only that row", async () => {
    const { db, themeState } = fakeThemesDb();
    const store = createThemesStore(db);
    await store.setGlobalThemeId("light");
    await store.setChatOverride("conversation-1", {
      version: 1,
      bubbleStyle: "sharp",
    });
    await store.setChatOverride("conversation-1", null);
    expect(await store.getChatOverride("conversation-1")).toBeNull();
    expect(themeState.has("global")).toBe(true);
  });

  it("corrupt stored rows fall back silently while valid rows survive", async () => {
    const { db, themeState, customThemes } = fakeThemesDb();
    themeState.set("global", "{ not json");
    customThemes.set("garbage", "this is not json either");
    customThemes.set("good", JSON.stringify(sampleTheme("good")));
    const store = createThemesStore(db);
    const state = await store.loadState();
    expect(state.themeId).toBe("builtin");
    expect(state.customThemes.map((theme) => theme.id)).toEqual(["good"]);
  });

  it("chat rows with invalid override docs decode to null, not a crash", async () => {
    const { db, themeState } = fakeThemesDb();
    themeState.set(
      chatScope("conversation-9"),
      JSON.stringify({ version: 2, fontScale: 0.5 }),
    );
    const store = createThemesStore(db);
    expect(await store.getChatOverride("conversation-9")).toBeNull();
    expect(decodeOverrideDoc("{{")).toBeNull();
  });

  it("built-in ids are guarded on save and delete", async () => {
    const { db, customThemes } = fakeThemesDb();
    const store = createThemesStore(db);
    const save = await store.saveCustomTheme(sampleTheme("teal"));
    expect(save.ok).toBe(false);
    if (!save.ok) expect(save.reason).toContain("built-in");
    expect(customThemes.size).toBe(0);
    const remove = await store.deleteCustomTheme("amber");
    expect(remove.ok).toBe(false);
  });

  it("out-of-range theme docs are rejected through the strict validator", async () => {
    const { db, customThemes } = fakeThemesDb();
    const store = createThemesStore(db);
    const forged = sampleTheme();
    forged.controls.fontScale = 99;
    const result = await store.saveCustomTheme(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("fontScale");
    expect(customThemes.size).toBe(0);
  });

  it("stored themes round-trip and a forged max font scale stays readable", async () => {
    const { db } = fakeThemesDb();
    const store = createThemesStore(db);
    const saved = await store.saveCustomTheme(sampleTheme());
    expect(saved.ok).toBe(true);
    const state = await store.loadState();
    expect(state.customThemes[0]).toEqual(sampleTheme());
    expect(decodeThemeDoc(JSON.stringify(sampleTheme()))).not.toBeNull();
    const theme = state.customThemes[0]!;
    const repainted = applyThemeV1(fakePaperBase, theme, {
      ...theme.controls,
      fontScale: 99,
    });
    expect(repainted.colors.background).toBe("#101820");
    expect(repainted.fonts.bodyLarge.fontSize).toBe(16 * 2.0);
    expect(repainted.fonts.bodyMedium.fontSize).toBe(14 * 2.0);
  });

  it("keeps dark Paper surfaces when the selected palette is light", () => {
    const light = {
      ...sampleTheme("light-test"),
      scheme: "light" as const,
      palette: {
        background: "#faf9f7",
        surface: "#ffffff",
        primary: "#59328b",
        text: "#26232b",
      },
    };
    const repainted = applyThemeV1(fakePaperBase, light, light.controls);
    expect(repainted.colors.background).toBe("#faf9f7");

    const darkBase = {
      ...fakePaperBase,
      colors: {
        ...fakePaperBase.colors,
        background: "#19171c",
        surface: "#242128",
        onSurface: "#f2edf5",
      },
    } as MobilePaperTheme;
    const darkRepainted = applyThemeV1(darkBase, light, light.controls);
    expect(darkRepainted.colors.background).toBe("#19171c");
    expect(darkRepainted.colors.surface).toBe("#242128");
    expect(darkRepainted.colors.onSurface).toBe("#f2edf5");
  });

  it("repaints each scheme variant when a theme set carries both palettes", () => {
    const set: ThemeV1 = {
      ...sampleTheme("set-with-variants"),
      scheme: "light",
      palette: {
        background: "#f8f9fb",
        surface: "#ffffff",
        primary: "#2f5fa8",
        text: "#20232b",
      },
      variants: {
        light: {
          background: "#f8f9fb",
          surface: "#ffffff",
          primary: "#2f5fa8",
          text: "#20232b",
        },
        dark: {
          background: "#0f1c38",
          surface: "#16294c",
          primary: "#a8c7fa",
          text: "#e7eefb",
        },
      },
    };
    const darkRepainted = applyThemeV1(fakePaperBase, set, set.controls);
    expect(darkRepainted.colors.background).toBe("#0f1c38");
    expect(darkRepainted.colors.surface).toBe("#16294c");
    expect(darkRepainted.colors.primary).toBe("#a8c7fa");
    expect(darkRepainted.colors.onSurface).toBe("#e7eefb");
    const lightBase = {
      ...fakePaperBase,
      dark: false,
    } as MobilePaperTheme;
    const lightRepainted = applyThemeV1(lightBase, set, set.controls);
    expect(lightRepainted.colors.background).toBe("#f8f9fb");
    expect(lightRepainted.colors.surface).toBe("#ffffff");
    expect(lightRepainted.colors.primary).toBe("#2f5fa8");
    expect(lightRepainted.colors.onSurface).toBe("#20232b");
  });
});
