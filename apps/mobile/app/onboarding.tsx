import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { Text } from "react-native-paper";
import { router } from "expo-router";
import { curatedCatalog } from "@locallab/models-catalog";
import { recommendModelFits } from "@locallab/models-fit";
import { OnboardingScreen } from "../features/onboarding/screen";
import {
  SQLiteOnboardingRepository,
  type OnboardingState,
} from "../features/onboarding";
import { useAppTheme } from "../features/themes/provider";
import { openMobileDatabase } from "../platform/database-open";
import { retryMobileDatabaseOpen } from "../platform/database-retry";
import { readDeviceCapacity } from "../platform/device-capacity";
import { NativeButton } from "@locallab/ui-native-primitives";
import { chatStartupError } from "../composition/chat/startup-errors";

export default function OnboardingRoute() {
  const [repository, setRepository] =
    useState<SQLiteOnboardingRepository | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [initialState, setInitialState] = useState<OnboardingState | null>(
    null,
  );
  const { setThemePreference } = useAppTheme();
  const recommendations = useMemo(
    () =>
      recommendModelFits(
        curatedCatalog.models,
        {
          ...readDeviceCapacity(),
          supportedFormats: ["gguf"],
        },
        "gguf",
      ),
    [],
  );

  useEffect(() => {
    let mounted = true;
    setError("");
    void openMobileDatabase()
      .then(async (database) => {
        const store = new SQLiteOnboardingRepository(database);
        const state = await store.get();
        if (!mounted) return;
        setInitialState(state);
        setRepository(store);
      })
      .catch((cause: unknown) => {
        if (mounted) setError(chatStartupError(cause, Platform.OS));
      });
    return () => {
      mounted = false;
    };
  }, [attempt]);

  if (error)
    return (
      <View style={{ flex: 1, padding: 20, justifyContent: "center", gap: 12 }}>
        <Text accessibilityRole="alert">{error}</Text>
        <NativeButton
          accessibilityLabel="Retry opening setup"
          onPress={() =>
            retryMobileDatabaseOpen(() => setAttempt((value) => value + 1))
          }
        >
          Try again
        </NativeButton>
      </View>
    );
  if (!repository)
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
        }}
      >
        <ActivityIndicator />
        <Text>Opening first-run setup…</Text>
      </View>
    );
  return (
    <OnboardingScreen
      {...(initialState ? { initialState } : {})}
      recommendations={recommendations}
      downloadAvailable={false}
      onBrowseModels={() => router.push("/models")}
      onModeChange={(mode) => repository.updatePreferences({ mode })}
      onThemeChange={setThemePreference}
      onDownload={async () => {
        throw new Error("Choose a phone model in Models to download it.");
      }}
      onFinish={async (input) => {
        await repository.save(input);
        await setThemePreference(input.theme);
        router.replace("/chat");
      }}
    />
  );
}
