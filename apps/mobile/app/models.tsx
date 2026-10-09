import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { Link, router, useLocalSearchParams } from "expo-router";
import { openMobileDatabase } from "../platform/database-open";
import { providerFetch } from "../platform/provider-fetch";
import { curatedCatalog } from "@locallab/models-catalog";
import { ModelLifecycleRegistry } from "@locallab/models-imports";
import {
  NativeButton,
  NativeDropdown,
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";
import { ModelsScreen } from "../features/models/screen";
import type { ModelFeatureDependencies } from "../features/models";
import { SQLiteModelSelectionRepository } from "../features/models/selection";
import { createRegisteredConnectionModels } from "../features/models/registered-connections";
import { createNativeMobileSecretStore } from "../platform/secrets";
import {
  SQLiteChatProviderRegistry,
  type ChatProviderRegistration,
} from "../composition/chat/providers";
import { openConnectionCatalog } from "../composition/chat/connection-catalog";
import { LocalModelsSection } from "../features/models/local-models";
import { readActiveChat } from "../composition/chat/selection";
import type { InstalledLocalModel } from "../platform/model-download";
import { describeError } from "../features/diagnostics/errors";
import { ErrorNotice } from "../features/diagnostics/error-notice";

function isNetworkConnection(connection: ChatProviderRegistration): boolean {
  return !["local-gguf", "mlx-ios", "mac-gguf", "mac-mlx"].includes(
    connection.kind,
  );
}

export default function ModelsRoute() {
  const theme = useTheme();
  const { phone } = useWorkspaceLayout();
  const { section: sectionParam } = useLocalSearchParams<{
    section?: string | string[];
  }>();
  const requestedSection = Array.isArray(sectionParam) ? sectionParam[0] : sectionParam;
  const [dependencies, setDependencies] =
    useState<ModelFeatureDependencies | null>(null);
  const [connections, setConnections] = useState<ChatProviderRegistration[]>([]);
  const [error, setError] = useState("");
  const [localError, setLocalError] = useState("");
  const [reloadRevision, setReloadRevision] = useState(0);
  const [changingServer, setChangingServer] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [selectedLocalBlobId, setSelectedLocalBlobId] = useState("");
  const [openConnection, setOpenConnection] = useState<
    ((connection: ChatProviderRegistration) => Promise<void>) | null
  >(null);
  const returnToChat = () => router.navigate("/chat");
  const openConnections = () => router.navigate("/chat?panel=connections");

  const selectLocal = async (model: InstalledLocalModel) => {
    const db = await openMobileDatabase();
    const registry = new SQLiteChatProviderRegistry(db);
    await registry.initialize();
    await db.withTransactionAsync(async (transaction) => {
      const scoped = transaction ?? db;
      const catalog = new SQLiteChatProviderRegistry(scoped);
      await catalog.save({
        id: model.blobId,
        label: model.name,
        kind: "local-gguf",
        modelId: "blob:" + model.blobId,
        allowCrossProviderRouting: false,
      });
      await scoped.execAsync(
        "CREATE TABLE IF NOT EXISTS phone_model_choice_local (singleton INTEGER PRIMARY KEY CHECK(singleton=1), provider_id TEXT NOT NULL)",
      );
      await scoped.runAsync(
        "INSERT INTO phone_model_choice_local(singleton,provider_id) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET provider_id=excluded.provider_id",
        model.blobId,
      );
      const conversationId = await readActiveChat(scoped);
      if (conversationId) await catalog.select(conversationId, model.blobId);
    });
    setSelectedLocalBlobId(model.blobId);
  };

  useEffect(() => {
    let mounted = true;
    setError("");
    setLocalError("");
    setDependencies(null);
    setSelectedLocalBlobId("");
    void openMobileDatabase()
      .then(async (db) => {
        const registry = await openConnectionCatalog(db);
        const saved = (await registry.list()).filter(isNetworkConnection);
        const selection = new SQLiteModelSelectionRepository(db);
        await selection.initialize();
        const activeChatId = await readActiveChat(db);
        const activeProvider = activeChatId
          ? await registry.selected(activeChatId)
          : undefined;
        if (!mounted) return;
        if (activeProvider?.kind === "local-gguf") {
          setSelectedLocalBlobId(activeProvider.id);
        } else if (!activeProvider) {
          await db.execAsync(
            "CREATE TABLE IF NOT EXISTS phone_model_choice_local (singleton INTEGER PRIMARY KEY CHECK(singleton=1), provider_id TEXT NOT NULL)",
          );
          const phoneChoice = await db.getFirstAsync<{ provider_id: string }>(
            "SELECT provider_id FROM phone_model_choice_local WHERE singleton=1",
          );
          if (mounted && phoneChoice)
            setSelectedLocalBlobId(phoneChoice.provider_id);
        }
        const active = await selection.active();
        const secrets = createNativeMobileSecretStore();
        const open = async (connection: ChatProviderRegistration) => {
          await selection.chooseConnection(connection.id);
          const selected =
            connection.modelId !== "model-discovery"
              ? connection.modelId
              : await selection.modelForConnection(connection.id);
          if (!mounted) return;
          setDependencies({
            catalog: curatedCatalog.models,
            lifecycle: new ModelLifecycleRegistry(),
            remote: createRegisteredConnectionModels(
              connection,
              secrets,
              providerFetch,
            ),
            connectionId: connection.id,
            connectionName: connection.label,
            onBusyChange: setModelBusy,
            onReturnToChat: returnToChat,
            onOpenConnections: openConnections,
            ...(selected ? { initialSelectedModelId: selected } : {}),
            onSelectModel: async (modelId) => {
              await db.withTransactionAsync(async (transaction) => {
                const scoped = transaction ?? db;
                const catalog = new SQLiteChatProviderRegistry(scoped);
                const current = await catalog.get(connection.id);
                if (!current || !isNetworkConnection(current))
                  throw new Error(
                    "This connection is no longer available. Open Connections and choose another provider.",
                  );
                await catalog.save({ ...current, modelId });
                const conversationId = await readActiveChat(scoped);
                if (conversationId)
                  await catalog.select(conversationId, connection.id);
                await new SQLiteModelSelectionRepository(scoped).selectModel(
                  connection.id,
                  modelId,
                );
              });
              if (mounted) {
                setSelectedLocalBlobId("");
                setConnections((items) =>
                  items.map((item) =>
                    item.id === connection.id ? { ...item, modelId } : item,
                  ),
                );
              }
            },
          });
        };
        if (!mounted) return;
        setConnections(saved);
        setOpenConnection(() => open);
        const connection =
          saved.find((item) => item.id === activeProvider?.id) ??
          saved.find((item) => item.id === active?.connectionId) ??
          saved[0];
        if (connection) await open(connection);
        else
          setDependencies({
            catalog: curatedCatalog.models,
            lifecycle: new ModelLifecycleRegistry(),
            onReturnToChat: returnToChat,
            onOpenConnections: openConnections,
          });
      })
      .catch((cause: unknown) => {
        if (mounted)
          setError(describeError(cause, {
            operation: "Open model storage and saved connections",
            recovery: "Tap Reload Models to reopen storage. Open Connections to check your saved provider settings.",
          }));
      });
    return () => {
      mounted = false;
    };
  }, [reloadRevision]);

  const connectionSelector = (
    connections.length > 0 ? (
            <View style={{ padding: phone ? 0 : 16, paddingBottom: phone ? 0 : 8 }}>
              <NativeDropdown
                label="Model connection"
                value={dependencies?.connectionId ?? ""}
                options={connections.map((connection) => ({
                  value: connection.id,
                  label: connection.label,
                  detail:
                    connection.modelId === "model-discovery"
                      ? "Choose a model"
                      : connection.modelId,
                }))}
                disabled={changingServer || modelBusy || phoneBusy}
                onChange={(id) => {
                  if (!openConnection || id === dependencies?.connectionId) return;
                  const connection = connections.find((item) => item.id === id);
                  if (!connection) return;
                  setChangingServer(true);
                  setError("");
                  void openConnection(connection)
                    .catch((cause: unknown) =>
                      setError(describeError(cause, {
                        operation: "Open a saved model connection",
                        recovery: "Try choosing this connection again, or open Connections to check its saved settings.",
                      })),
                    )
                    .finally(() => setChangingServer(false));
                }}
              />
            </View>
          ) : null
  );

  if (!dependencies && !error)
    return (
      <View
        style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}
      >
        <ActivityIndicator />
        <Text>Opening model manager…</Text>
      </View>
    );

  return (
    <View style={{ flex: 1 }}>
      {error || localError ? (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 8 }}>
          <ErrorNotice message={error || localError} />
          <NativeButton
            accessibilityLabel="Retry opening Models"
            mode="outlined"
            disabled={changingServer || modelBusy || phoneBusy}
            onPress={() => setReloadRevision((value) => value + 1)}
          >
            Reload Models
          </NativeButton>
          <NativeButton
            accessibilityLabel="Open model connections"
            disabled={changingServer || modelBusy || phoneBusy}
            onPress={openConnections}
          >
            Open Connections
          </NativeButton>
        </ScrollView>
      ) : null}
      {!phone ? connectionSelector : null}
      {dependencies && !error && !localError ? (
        <ModelsScreen
          key={dependencies.connectionId ?? "catalog"}
          {...dependencies}
          phoneDownloadBusy={phoneBusy}
          {...(phone && connectionSelector ? { connectionSelector } : {})}
          {...(requestedSection === "phone" || requestedSection === "connected"
            ? { initialSection: requestedSection }
            : {})}
          localModelsSection={
            <LocalModelsSection
              onSelect={selectLocal}
              onErrorChange={setLocalError}
              onReturnToChat={returnToChat}
              selectedBlobId={selectedLocalBlobId}
              onBusyChange={setPhoneBusy}
            />
          }
        />
      ) : null}
      {!phone ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          <Link href="/chat" style={{ padding: 16, color: theme.colors.primary }}>
            Back to chat
          </Link>
          <Link
            href="/chat?panel=connections"
            style={{ padding: 16, color: theme.colors.primary }}
          >
            Open Connections
          </Link>
          <Link
            href="/onboarding"
            style={{ padding: 16, color: theme.colors.primary }}
          >
            Get Started setup
          </Link>
        </View>
      ) : null}
    </View>
  );
}
