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
import { nativeTheme, nativeDarkTheme } from "@locallab/ui-native-primitives";
import {
  SQLiteOnboardingRepository,
  type OnboardingTheme,
} from "../onboarding";
import { openMobileDatabase } from "../../platform/database-open";

interface AppThemeSettings {
  readonly themePreference: OnboardingTheme;
  setThemePreference(value: OnboardingTheme): Promise<void>;
}

const AppThemeContext = createContext<AppThemeSettings | null>(null);

/** Live Paper colors and a durable preference shared by every route. */
export function AppThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useSystemColorScheme();
  const [themePreference, setPreference] = useState<OnboardingTheme>("system");
  const preferenceChanged = useRef(false);
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
      async setThemePreference(value) {
        preferenceChanged.current = true;
        setPreference(value);
        const db = await openMobileDatabase();
        await new SQLiteOnboardingRepository(db).updatePreferences({
          theme: value,
        });
      },
    }),
    [themePreference],
  );
  const dark =
    themePreference === "dark" ||
    (themePreference === "system" && systemScheme === "dark");
  return (
    <AppThemeContext.Provider value={settings}>
      <PaperProvider theme={dark ? nativeDarkTheme : nativeTheme}>
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
