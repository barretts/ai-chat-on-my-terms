import {
  BUILTIN_THEME_IDS,
  parseOverrideImport,
  parseThemeImport,
  clampControls,
  type AppearanceOverrideV1,
  type ThemeControlsV1,
  type ThemeV1,
} from "@locallab/themes-schema";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type {
  nativeDarkTheme,
  nativeTheme,
  phoneDarkTheme,
  phoneTheme,
} from "@locallab/ui-native-primitives";

/** Versioned live-theme records sharing the app's durable SQLite connection. */

export const themeStateSql = `CREATE TABLE IF NOT EXISTS theme_state (
  scope TEXT PRIMARY KEY NOT NULL,
  doc TEXT NOT NULL
)`;
export const customThemesSql = `CREATE TABLE IF NOT EXISTS custom_themes (
  id TEXT PRIMARY KEY NOT NULL,
  doc TEXT NOT NULL
)`;

const GLOBAL_SCOPE = "global";
/** Shared per-chat scope-key prefix; the provider's LIKE scan reuses it. */
export const CHAT_SCOPE_PREFIX = "chat:";

/** Single source of truth for the per-chat scope key used by the store and provider. */
export function chatScope(conversationId: string): string {
  return `${CHAT_SCOPE_PREFIX}${conversationId}`;
}

export interface ThemesState {
  themeId: string;
  customThemes: ThemeV1[];
}

export type ThemesWriteResult = { ok: true } | { ok: false; reason: string };

export interface ThemesStore {
  loadState(): Promise<ThemesState>;
  setGlobalThemeId(id: string): Promise<void>;
  saveCustomTheme(theme: ThemeV1): Promise<ThemesWriteResult>;
  deleteCustomTheme(id: string): Promise<ThemesWriteResult>;
  getChatOverride(conversationId: string): Promise<AppearanceOverrideV1 | null>;
  setChatOverride(
    conversationId: string,
    override: AppearanceOverrideV1 | null,
  ): Promise<void>;
}

function parseStoredJson(doc: string): unknown {
  try {
    return JSON.parse(doc);
  } catch {
    return null;
  }
}

/** Every stored theme doc goes through the strict import validator. */
export function decodeThemeDoc(doc: string): ThemeV1 | null {
  const parsed = parseThemeImport(parseStoredJson(doc));
  if (!parsed.ok) return null;
  return { ...parsed.theme, version: 1 };
}

/** Every stored per-chat doc goes through the strict override validator. */
export function decodeOverrideDoc(doc: string): AppearanceOverrideV1 | null {
  const parsed = parseOverrideImport(parseStoredJson(doc));
  return parsed.ok ? parsed.override : null;
}

const builtinIds = new Set<string>(BUILTIN_THEME_IDS);
const upsertStateSql =
  "INSERT INTO theme_state(scope,doc) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET doc=excluded.doc";
const upsertThemeSql =
  "INSERT INTO custom_themes(id,doc) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc";

export function createThemesStore(db: SQLiteDatabasePort): ThemesStore {
  return {
    async loadState() {
      await db.execAsync(themeStateSql);
      await db.execAsync(customThemesSql);
      const [stateRows, themeRows] = await Promise.all([
        db.getAllAsync<{ scope: string; doc: string }>(
          "SELECT scope, doc FROM theme_state",
        ),
        db.getAllAsync<{ id: string; doc: string }>(
          "SELECT id, doc FROM custom_themes",
        ),
      ]);
      let themeId = "builtin";
      const globalRow = stateRows.find((row) => row.scope === GLOBAL_SCOPE);
      if (globalRow) {
        const doc = parseStoredJson(globalRow.doc);
        if (doc !== null && typeof doc === "object" && "themeId" in doc) {
          const stored = doc.themeId;
          if (typeof stored === "string" && stored.length > 0) themeId = stored;
        }
      }
      const customThemes: ThemeV1[] = [];
      const seenIds = new Set<string>();
      for (const row of themeRows) {
        const theme = decodeThemeDoc(row.doc);
        if (theme === null || seenIds.has(theme.id)) continue;
        seenIds.add(theme.id);
        customThemes.push(theme);
      }
      return { themeId, customThemes };
    },
    async setGlobalThemeId(id) {
      await db.execAsync(themeStateSql);
      await db.runAsync(upsertStateSql, GLOBAL_SCOPE, JSON.stringify({ themeId: id }));
    },
    async saveCustomTheme(theme) {
      if (builtinIds.has(theme.id))
        return {
          ok: false as const,
          reason: `"${theme.id}" is a built-in id and cannot be overwritten`,
        };
      const parsed = parseThemeImport(theme);
      if (!parsed.ok) return { ok: false as const, reason: parsed.reason };
      await db.execAsync(customThemesSql);
      await db.runAsync(
        upsertThemeSql,
        parsed.theme.id,
        JSON.stringify(parsed.theme),
      );
      return { ok: true as const };
    },
    async deleteCustomTheme(id) {
      if (builtinIds.has(id))
        return { ok: false as const, reason: "built-in themes cannot be deleted" };
      await db.execAsync(customThemesSql);
      await db.runAsync("DELETE FROM custom_themes WHERE id=?", id);
      return { ok: true as const };
    },
    async getChatOverride(conversationId) {
      await db.execAsync(themeStateSql);
      const rows = await db.getAllAsync<{ scope: string; doc: string }>(
        "SELECT scope, doc FROM theme_state WHERE scope=?",
        chatScope(conversationId),
      );
      const row = rows[0];
      return row === undefined ? null : decodeOverrideDoc(row.doc);
    },
    async setChatOverride(conversationId, override) {
      await db.execAsync(themeStateSql);
      const scope = chatScope(conversationId);
      if (override === null) {
        await db.runAsync("DELETE FROM theme_state WHERE scope=?", scope);
        return;
      }
      await db.runAsync(upsertStateSql, scope, JSON.stringify(override));
    },
  };
}

/** The four Paper surfaces the provider may hand to applyThemeV1. */
export type MobilePaperTheme =
  | typeof phoneTheme
  | typeof phoneDarkTheme
  | typeof nativeTheme
  | typeof nativeDarkTheme;

/** Repaints a base Paper theme with a ThemeV1 palette and scaled reading fonts. */
export function applyThemeV1(
  base: MobilePaperTheme,
  theme: ThemeV1,
  controls: ThemeControlsV1,
) {
  // Re-clamped so any caller-forged scale still yields a finite readable size.
  const scale = clampControls(controls).fontScale;
  return {
    ...base,
    colors: {
      ...base.colors,
      background: theme.palette.background,
      surface: theme.palette.surface,
      primary: theme.palette.primary,
      onSurface: theme.palette.text,
    },
    fonts: {
      ...base.fonts,
      bodyLarge: { ...base.fonts.bodyLarge, fontSize: 16 * scale },
      bodyMedium: { ...base.fonts.bodyMedium, fontSize: 14 * scale },
    },
  };
}
