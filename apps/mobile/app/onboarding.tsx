import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, ScrollView, View } from "react-native";
import { Text } from "react-native-paper";
import { router } from "expo-router";
import { curatedCatalog } from "@locallab/models-catalog";
import { recommendModelFits } from "@locallab/models-fit";
import {
  OnboardingScreen,
  type OnboardingPreferences,
} from "../features/onboarding/screen";
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
import { describeError } from "../features/diagnostics/errors";
import { ErrorNotice } from "../features/diagnostics/error-notice";

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
        if (mounted)
          setError(
            describeError(cause, {
              operation: "Open onboarding storage",
              recovery:
                chatStartupError(cause, Platform.OS) +
                " Use Try again to reopen setup.",
            }),
          );
      });
    return () => {
      mounted = false;
    };
  }, [attempt]);

  if (error)
    return (
      <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 20, gap: 12 }}>
        <ErrorNotice message={error} />
        <NativeButton
          accessibilityLabel="Retry opening setup"
          onPress={() =>
            retryMobileDatabaseOpen(() => setAttempt((value) => value + 1))
          }
        >
          Try again
        </NativeButton>
      </ScrollView>
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
        <Text>Opening setup…</Text>
      </View>
    );
  const completeSetup = async (
    input: OnboardingPreferences & { modelId: string | null },
    destination: "chat" | "models" | "connections",
  ) => {
    await setThemePreference(input.theme);
    await repository.save(input);
    if (destination === "connections")
      router.replace({ pathname: "/chat", params: { panel: "connections" } });
    else
      router.replace(
        destination === "models" ? "/models?section=phone" : "/chat",
      );
  };
  return (
    <OnboardingScreen
      {...(initialState ? { initialState } : {})}
      recommendations={recommendations}
      downloadAvailable={false}
      onConnect={(preferences) =>
        completeSetup({ ...preferences, modelId: null }, "connections")
      }
      onBrowseModels={(preferences) =>
        completeSetup({ ...preferences, modelId: null }, "models")
      }
      onModeChange={(mode) => repository.updatePreferences({ mode })}
      onThemeChange={setThemePreference}
      onDownload={async () => {
        throw new Error("Choose a phone model in Models to download it.");
      }}
      onFinish={(input) => completeSetup(input, "chat")}
    />
  );
}
