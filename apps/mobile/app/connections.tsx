import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { openMobileDatabase } from "../platform/database-open";
import { providerFetch } from "../platform/provider-fetch";
import { Link } from "expo-router";
import { createId } from "../platform/crypto";
import { SQLiteConnectionRepository } from "../features/connections";
import type { ConnectionFeatureDependencies } from "../features/connections";
import { ConnectionsScreen } from "../features/connections/screen";
import { createNativeMobileSecretStore } from "../platform/secrets";
import { createManualRedirectConnectionRequest } from "../features/connections";
import { createUnauthenticatedHttpProbe } from "../../../modules/lan-discovery/src";

export default function ConnectionsRoute() {
  const theme = useTheme();
  const [dependencies, setDependencies] =
    useState<ConnectionFeatureDependencies | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void openMobileDatabase()
      .then((database) => {
        if (!mounted) return;
        setDependencies({
          repository: new SQLiteConnectionRepository(database, createId),
          secrets: createNativeMobileSecretStore(),
          // Scanning only starts from the explicit user action on this screen.
          // iOS presents its Local Network prompt on the first selected-host request.
          permission: {
            request: async () =>
              Platform.OS === "ios" || Platform.OS === "android"
                ? "granted"
                : "unavailable",
          },
          probe: createUnauthenticatedHttpProbe(providerFetch),
          connectivity: createManualRedirectConnectionRequest(providerFetch),
          discoveryAvailable: Platform.OS !== "web",
        });
      })
      .catch((cause: unknown) => {
        if (mounted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Connection storage could not be opened.",
          );
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (error) return <Text accessibilityRole="alert">{error}</Text>;
  if (!dependencies)
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
        <Text>Opening connection settings…</Text>
      </View>
    );
  return (
    <View style={{ flex: 1 }}>
      <ConnectionsScreen {...dependencies} />
      <Link href="/" style={{ padding: 16, color: theme.colors.primary }}>
        Back to chat
      </Link>
      <Link href="/models" style={{ padding: 16, color: theme.colors.primary }}>
        Open Models
      </Link>
    </View>
  );
}
