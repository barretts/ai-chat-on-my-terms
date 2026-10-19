import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, ScrollView } from "react-native";
import { Text } from "react-native-paper";
import { SQLiteOnboardingRepository } from "../features/onboarding";
import { openMobileDatabase } from "../platform/database-open";
import { retryMobileDatabaseOpen } from "../platform/database-retry";
import { NativeButton } from "@locallab/ui-native-primitives";
import { chatStartupError } from "../composition/chat/startup-errors";
import { ErrorNotice } from "../features/diagnostics/error-notice";
import { describeError } from "../features/diagnostics/errors";

export default function IndexRoute() {
  const [destination, setDestination] = useState<
    "/onboarding" | "/chat" | null
  >(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let mounted = true;
    setError("");
    void openMobileDatabase()
      .then(async (database) => {
        const state = await new SQLiteOnboardingRepository(database).get();
        if (mounted) setDestination(state.completed ? "/chat" : "/onboarding");
      })
      .catch((cause: unknown) => {
        if (mounted)
          setError(
            describeError(cause, {
              operation: "Open app storage",
              recovery: chatStartupError(cause, Platform.OS),
            }),
          );
      });
    return () => {
      mounted = false;
    };
  }, [attempt]);
  if (destination) return <Redirect href={destination} />;
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        flexGrow: 1,
        padding: 24,
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
      }}
    >
      {error ? (
        <>
          <ErrorNotice message={error} />
          <NativeButton
            accessibilityLabel="Retry opening the app"
            onPress={() =>
              retryMobileDatabaseOpen(() => setAttempt((value) => value + 1))
            }
          >
            Try again
          </NativeButton>
        </>
      ) : (
        <>
          <ActivityIndicator />
          <Text>Preparing your chat…</Text>
        </>
      )}
    </ScrollView>
  );
}
