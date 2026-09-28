import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { Link } from "expo-router";
import { openMobileDatabase } from "../platform/database-open";
import { providerFetch } from "../platform/provider-fetch";
import { curatedCatalog } from "@locallab/models-catalog";
import { ModelLifecycleRegistry } from "@locallab/models-imports";
import { NativeButton } from "@locallab/ui-native-primitives";
import type { SecretRef } from "@locallab/security-secrets";
import {
  SQLiteConnectionRepository,
  type SavedConnection,
} from "../features/connections";
import { ModelsScreen } from "../features/models/screen";
import type { ModelFeatureDependencies } from "../features/models";
import { SQLiteModelSelectionRepository } from "../features/models/selection";
import {
  createConnectionModels,
  modelConnectionKind,
} from "../features/models/connections";
import { createNativeMobileSecretStore } from "../platform/secrets";
import { SQLiteChatProviderRegistry } from "../composition/chat/providers";
import { LocalModelsSection } from "../features/models/local-models";
import { readActiveChat } from "../composition/chat/selection";
import type { InstalledLocalModel } from "../platform/model-download";

export default function ModelsRoute() {
  const theme = useTheme();
  const [dependencies, setDependencies] =
    useState<ModelFeatureDependencies | null>(null);
  const [connections, setConnections] = useState<SavedConnection[]>([]);
  const [error, setError] = useState("");
  const [changingServer, setChangingServer] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [selectedLocalBlobId, setSelectedLocalBlobId] = useState("");
  const selectLocal = async (model: InstalledLocalModel) => {
    const db = await openMobileDatabase();
    const registry = new SQLiteChatProviderRegistry(db);
    await registry.initialize();
    await registry.save({
      id: model.blobId,
      label: model.name,
      kind: "local-gguf",
      modelId: `blob:${model.blobId}`,
      allowCrossProviderRouting: false,
    });
    await db.execAsync(
      "CREATE TABLE IF NOT EXISTS phone_model_choice_local (singleton INTEGER PRIMARY KEY CHECK(singleton=1), provider_id TEXT NOT NULL)",
    );
    await db.runAsync(
      "INSERT INTO phone_model_choice_local(singleton,provider_id) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET provider_id=excluded.provider_id",
      model.blobId,
    );
    const conversationId = await readActiveChat(db);
    if (conversationId) await registry.select(conversationId, model.blobId);
    setSelectedLocalBlobId(model.blobId);
  };
  const [openConnection, setOpenConnection] = useState<
    ((connection: SavedConnection) => Promise<void>) | null
  >(null);
  useEffect(() => {
    let mounted = true;
    void openMobileDatabase()
      .then(async (db) => {
        const repository = new SQLiteConnectionRepository(db);
        const saved = (await repository.list()).filter((item) =>
          modelConnectionKind(item.kind),
        );
        const selection = new SQLiteModelSelectionRepository(db);
        await selection.initialize();
        const chatRegistry = new SQLiteChatProviderRegistry(db);
        await chatRegistry.initialize();
        const activeChatId = await readActiveChat(db);
        const activeProvider = activeChatId
          ? await chatRegistry.selected(activeChatId)
          : undefined;
        if (activeProvider?.kind === "local-gguf")
          setSelectedLocalBlobId(activeProvider.id);
        else if (!activeProvider) {
          await db.execAsync(
            "CREATE TABLE IF NOT EXISTS phone_model_choice_local (singleton INTEGER PRIMARY KEY CHECK(singleton=1), provider_id TEXT NOT NULL)",
          );
          const phoneChoice = await db.getFirstAsync<{ provider_id: string }>(
            "SELECT provider_id FROM phone_model_choice_local WHERE singleton=1",
          );
          if (phoneChoice) setSelectedLocalBlobId(phoneChoice.provider_id);
        }
        const active = await selection.active();
        const secrets = createNativeMobileSecretStore();
        const open = async (connection: SavedConnection) => {
          await selection.chooseConnection(connection.id);
          const selected = await selection.modelForConnection(connection.id);
          if (!mounted) return;
          setDependencies({
            catalog: curatedCatalog.models,
            lifecycle: new ModelLifecycleRegistry(),
            remote: createConnectionModels(connection, secrets, providerFetch),
            connectionId: connection.id,
            connectionName: connection.name,
            onBusyChange: setModelBusy,
            ...(selected ? { initialSelectedModelId: selected } : {}),
            onSelectModel: async (modelId) => {
              const current = (await repository.list()).find(
                (item) => item.id === connection.id,
              );
              if (
                !current ||
                JSON.stringify(current) !== JSON.stringify(connection)
              )
                throw new Error(
                  "This connection changed. Reopen Models before choosing a model.",
                );
              const kind = modelConnectionKind(connection.kind);
              if (!kind)
                throw new Error(
                  "This provider cannot be selected for chat here.",
                );
              await db.withTransactionAsync(async (transaction) => {
                const scoped = transaction ?? db;
                await new SQLiteChatProviderRegistry(scoped).save({
                  id: connection.id,
                  label: connection.name,
                  kind,
                  endpoint: connection.host,
                  modelId,
                  ...(connection.credentialRef
                    ? { credentialRef: connection.credentialRef as SecretRef }
                    : {}),
                  ...(connection.customHeadersEnabled &&
                  connection.headerRefs.length
                    ? { headerRefs: connection.headerRefs as SecretRef[] }
                    : {}),
                  cleartextAuthorized: connection.host.startsWith("http://"),
                  allowCrossProviderRouting: false,
                });
                await new SQLiteModelSelectionRepository(scoped).selectModel(
                  connection.id,
                  modelId,
                );
              });
            },
          });
        };
        if (!mounted) return;
        setConnections(saved);
        setOpenConnection(() => open);
        const connection =
          saved.find((item) => item.id === active?.connectionId) ?? saved[0];
        if (connection) await open(connection);
        else
          setDependencies({
            catalog: curatedCatalog.models,
            lifecycle: new ModelLifecycleRegistry(),
          });
      })
      .catch((cause: unknown) => {
        if (mounted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not open model storage.",
          );
      });
    return () => {
      mounted = false;
    };
  }, []);
  if (!dependencies && !error)
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
        <Text>Opening model manager…</Text>
      </View>
    );
  return (
    <View style={{ flex: 1 }}>
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      {connections.length > 1 ? (
        <View
          style={{
            padding: 16,
            gap: 8,
            flexDirection: "row",
            flexWrap: "wrap",
          }}
        >
          {connections.map((connection) => (
            <NativeButton
              key={connection.id}
              accessibilityLabel={`Use model server ${connection.name}`}
              disabled={
                changingServer ||
                modelBusy ||
                phoneBusy ||
                dependencies?.connectionId === connection.id
              }
              onPress={() => {
                if (!openConnection) return;
                setChangingServer(true);
                setError("");
                void openConnection(connection)
                  .catch((cause: unknown) =>
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "Could not change model server.",
                    ),
                  )
                  .finally(() => setChangingServer(false));
              }}
            >
              {connection.name}
              {dependencies?.connectionId === connection.id
                ? " (selected)"
                : ""}
            </NativeButton>
          ))}
        </View>
      ) : null}
      {dependencies ? (
        <ModelsScreen
          key={dependencies.connectionId ?? "catalog"}
          {...dependencies}
          localModelsSection={
            <LocalModelsSection
              onSelect={selectLocal}
              selectedBlobId={selectedLocalBlobId}
              onBusyChange={setPhoneBusy}
            />
          }
        />
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        <Link href="/" style={{ padding: 16, color: theme.colors.primary }}>
          Back to chat
        </Link>
        <Link
          href="/connections"
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
    </View>
  );
}
