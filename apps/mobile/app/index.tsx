import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { Text } from "react-native-paper";
import { SQLiteOnboardingRepository } from "../features/onboarding";
import { openMobileDatabase } from "../platform/database-open";
import { retryMobileDatabaseOpen } from "../platform/database-retry";
import { NativeButton } from "@locallab/ui-native-primitives";
import { chatStartupError } from "../composition/chat/startup-errors";

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
        if (mounted) setError(chatStartupError(cause, Platform.OS));
      });
    return () => {
      mounted = false;
    };
  }, [attempt]);
  if (destination) return <Redirect href={destination} />;
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
      }}
    >
      {error ? (
        <>
          <Text accessibilityRole="alert">{error}</Text>
          <NativeButton
            accessibilityLabel="Retry opening LocalLab"
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
          <Text>Preparing LocalLab…</Text>
        </>
      )}
    </View>
  );
}
