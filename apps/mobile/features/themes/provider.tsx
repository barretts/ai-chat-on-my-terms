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

interface AppThemeSettings {
  readonly themePreference: OnboardingTheme;
  setThemePreference(value: OnboardingTheme): Promise<void>;
  readonly layout: LayoutPreferences;
  setLayoutPreferences(value: Partial<LayoutPreferences>): Promise<void>;
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

const AppThemeContext = createContext<AppThemeSettings | null>(null);

/** Live Paper colors and a durable preference shared by every route. */
export function AppThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useSystemColorScheme();
  const { phone } = useWorkspaceLayout();
  const [themePreference, setPreference] = useState<OnboardingTheme>("system");
  const preferenceChanged = useRef(false);
  const [layout, setLayout] = useState<LayoutPreferences>(initialLayout);
  const layoutChanged = useRef(new Set<keyof LayoutPreferences>());
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
  const settings = useMemo<AppThemeSettings>(
    () => ({
      themePreference,
      layout,
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
    }),
    [themePreference, layout],
  );
  const dark =
    themePreference === "dark" ||
    (themePreference === "system" && systemScheme === "dark");
  return (
    <AppThemeContext.Provider value={settings}>
      <PaperProvider
        theme={
          phone
            ? dark
              ? phoneDarkTheme
              : phoneTheme
            : dark
              ? nativeDarkTheme
              : nativeTheme
        }
      >
        {children}
      </PaperProvider>
    </AppThemeContext.Provider>
  );
}

export function useAppTheme(): AppThemeSettings {
  const settings = useContext(AppThemeContext);
  if (!settings) throw new Error("AppThemeProvider is required");
  return settings;
}
