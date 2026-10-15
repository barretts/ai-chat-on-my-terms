import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSystemColorScheme } from "./system-color-scheme";
import { PaperProvider } from "react-native-paper";
import {
  nativeTheme,
  nativeDarkTheme,
  phoneTheme,
  phoneDarkTheme,
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";
import {
  SQLiteOnboardingRepository,
  type OnboardingTheme,
} from "../onboarding";
import { openMobileDatabase } from "../../platform/database-open";
import {
  BUILTIN_THEMES,
  resolveAppearance,
  type AppearanceOverrideV1,
  type ThemeControlsV1,
  type ThemeV1,
} from "@locallab/themes-schema";
import {
  applyThemeV1,
  CHAT_SCOPE_PREFIX,
  chatScope,
  createThemesStore,
  decodeOverrideDoc,
  type ThemesStore,
  type ThemesWriteResult,
} from "./index";
import { ThemeEditorSheet } from "./theme-editor";

interface AppThemeSettings {
  readonly themePreference: OnboardingTheme;
  setThemePreference(value: OnboardingTheme): Promise<void>;
  readonly layout: LayoutPreferences;
  setLayoutPreferences(value: Partial<LayoutPreferences>): Promise<void>;
  readonly themeId: string;
  readonly customThemes: ThemeV1[];
  setThemeId(value: string): Promise<void>;
  saveCustomTheme(theme: ThemeV1): Promise<ThemesWriteResult>;
  deleteCustomTheme(id: string): Promise<ThemesWriteResult>;
  setChatOverrideFor(
    conversationId: string,
    override: AppearanceOverrideV1 | null,
  ): Promise<void>;
  chatAppearanceFor(conversationId: string): {
    theme: ThemeV1;
    controls: ThemeControlsV1;
  };
  openThemeEditor(conversationId?: string): void;
  closeThemeEditor(): void;
}

export interface LayoutPreferences {
  windowCollapsed: boolean;
  chatCollapsed: boolean;
  composerCollapsed: boolean;
}
const initialLayout: LayoutPreferences = {
  windowCollapsed: false,
  chatCollapsed: false,
  composerCollapsed: false,
};
const layoutSql = `CREATE TABLE IF NOT EXISTS workspace_layout_preferences (
  preference TEXT PRIMARY KEY NOT NULL,
  collapsed INTEGER NOT NULL CHECK(collapsed IN (0,1))
)`;

/** The schema always ships this theme; the guard keeps the invariant checked. */
function builtinDefaultTheme() {
  const theme = BUILTIN_THEMES.find((candidate) => candidate.id === "builtin");
  if (theme === undefined)
    throw new Error("themes schema is missing its built-in default theme");
  return theme;
}

const AppThemeContext = createContext<AppThemeSettings | null>(null);

/** Live Paper colors and a durable preference shared by every route. */
export function AppThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useSystemColorScheme();
  const { phone } = useWorkspaceLayout();
  const [themePreference, setPreference] = useState<OnboardingTheme>("system");
  const preferenceChanged = useRef(false);
  const [layout, setLayout] = useState<LayoutPreferences>(initialLayout);
  const layoutChanged = useRef(new Set<keyof LayoutPreferences>());
  const [themeId, setThemeIdState] = useState("builtin");
  const [customThemes, setCustomThemes] = useState<ThemeV1[]>([]);
  const [chatOverrides, setChatOverrides] = useState(
    () => new Map<string, AppearanceOverrideV1>(),
  );
  const [editorChatId, setEditorChatId] = useState<string | null | undefined>(
    undefined,
  );
  const themesStore = useRef<ThemesStore | null>(null);
  const layoutWrites = useRef(Promise.resolve());
  useEffect(() => {
    let mounted = true;
    void openMobileDatabase()
      .then(async (db) => {
        await db.execAsync(layoutSql);
        const rows = await db.getAllAsync<{
          preference: string;
          collapsed: number;
        }>("SELECT preference, collapsed FROM workspace_layout_preferences");
        if (!mounted) return;
        setLayout((current) => {
          const next = { ...current };
          for (const key of Object.keys(
            initialLayout,
          ) as (keyof LayoutPreferences)[]) {
            const row = rows.find((item) => item.preference === key);
            if (row && !layoutChanged.current.has(key))
              next[key] = row.collapsed === 1;
          }
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);
  useEffect(() => {
    let mounted = true;
    void openMobileDatabase()
      .then((db) => new SQLiteOnboardingRepository(db).get())
      .then((state) => {
        if (mounted && !preferenceChanged.current) setPreference(state.theme);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);
  useEffect(() => {
    let mounted = true;
    void openMobileDatabase()
      .then(async (db) => {
        const store = createThemesStore(db);
        themesStore.current = store;
        const state = await store.loadState();
        const chatRows = await db.getAllAsync<{ scope: string; doc: string }>(
          "SELECT scope, doc FROM theme_state WHERE scope LIKE ?",
          `${CHAT_SCOPE_PREFIX}%`,
        );
        if (!mounted) return;
        setThemeIdState(state.themeId);
        setCustomThemes(state.customThemes);
        setChatOverrides(() => {
          const map = new Map<string, AppearanceOverrideV1>();
          for (const row of chatRows) {
            const conversationId = row.scope.slice(CHAT_SCOPE_PREFIX.length);
            const override = decodeOverrideDoc(row.doc);
            if (conversationId.length > 0 && override !== null)
              map.set(conversationId, override);
          }
          return map;
        });
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);
  const allThemes = [...BUILTIN_THEMES, ...customThemes];
  const globalTheme =
    allThemes.find((candidate) => candidate.id === themeId) ??
    builtinDefaultTheme();
  const settings = useMemo<AppThemeSettings>(
    () => ({
      themePreference,
      layout,
      themeId,
      customThemes,
      async setLayoutPreferences(value) {
        const keys = (
          Object.keys(initialLayout) as (keyof LayoutPreferences)[]
        ).filter((key) => typeof value[key] === "boolean");
        for (const key of keys) layoutChanged.current.add(key);
        const write = layoutWrites.current.then(async () => {
          const db = await openMobileDatabase();
          await db.execAsync(layoutSql);
          await db.withTransactionAsync(async (transaction) => {
            for (const key of keys)
              await (transaction ?? db).runAsync(
                "INSERT INTO workspace_layout_preferences(preference,collapsed) VALUES(?,?) ON CONFLICT(preference) DO UPDATE SET collapsed=excluded.collapsed",
                key,
                value[key] ? 1 : 0,
              );
          });
        });
        layoutWrites.current = write.catch(() => undefined);
        try {
          await write;
        } finally {
          // A visible layout change normally means its save has completed.
          setLayout((current) => ({ ...current, ...value }));
        }
      },
      async setThemePreference(value) {
        preferenceChanged.current = true;
        setPreference(value);
        const db = await openMobileDatabase();
        await new SQLiteOnboardingRepository(db).updatePreferences({
          theme: value,
        });
      },
      chatAppearanceFor(conversationId) {
        return resolveAppearance(
          globalTheme,
          chatOverrides.get(conversationId) ?? null,
          allThemes,
        );
      },
      async setThemeId(value) {
        setThemeIdState(value);
        await themesStore.current?.setGlobalThemeId(value);
      },
      async saveCustomTheme(theme) {
        const store = themesStore.current;
        if (store === null)
          return {
            ok: false as const,
            reason: "theme storage is not ready yet",
          };
        const result = await store.saveCustomTheme(theme);
        if (result.ok) setCustomThemes((await store.loadState()).customThemes);
        return result;
      },
      async deleteCustomTheme(id) {
        const store = themesStore.current;
        if (store === null)
          return {
            ok: false as const,
            reason: "theme storage is not ready yet",
          };
        const result = await store.deleteCustomTheme(id);
        if (result.ok)
          setCustomThemes((current) =>
            current.filter((item) => item.id !== id),
          );
        return result;
      },
      async setChatOverrideFor(conversationId, override) {
        const store = themesStore.current;
        if (store === null) throw new Error("theme storage is not ready yet");
        await store.setChatOverride(conversationId, override);
        setChatOverrides((current) => {
          const next = new Map(current);
          if (override === null) next.delete(conversationId);
          else next.set(conversationId, override);
          return next;
        });
      },
      openThemeEditor(conversationId) {
        setEditorChatId(conversationId ?? null);
      },
      closeThemeEditor() {
        setEditorChatId(undefined);
      },
    }),
    [themePreference, layout, themeId, customThemes, chatOverrides],
  );
  const dark =
    themePreference === "dark" ||
    (themePreference === "system" && systemScheme === "dark");
  return (
    <AppThemeContext.Provider value={settings}>
      <PaperProvider
        theme={applyThemeV1(
          phone
            ? dark
              ? phoneDarkTheme
              : phoneTheme
            : dark
              ? nativeDarkTheme
              : nativeTheme,
          globalTheme,
          globalTheme.controls,
        )}
      >
          {children}
          {editorChatId !== undefined && (
            <ThemeEditorSheet
              visible
              onClose={() => setEditorChatId(undefined)}
              {...(editorChatId !== null ? { conversationId: editorChatId } : {})}
            />
          )}
      </PaperProvider>
    </AppThemeContext.Provider>
  );
}

export function useAppTheme(): AppThemeSettings {
  const settings = useContext(AppThemeContext);
  if (!settings) throw new Error("AppThemeProvider is required");
  return settings;
}
