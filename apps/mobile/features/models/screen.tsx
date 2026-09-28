import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Searchbar, Text, TextInput, useTheme } from "react-native-paper";
import { NativeButton, NativeSurface } from "@locallab/ui-native-primitives";
import { searchCatalog } from "@locallab/models-catalog";
import type {
  ModelFeatureDependencies,
  RemoteModel,
  RemotePullOperation,
} from "./index";
import { applyModelSelection, modelStatus } from "./index";

export function ModelsScreen(props: ModelFeatureDependencies) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [remoteModels, setRemoteModels] = useState<readonly RemoteModel[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [pull, setPull] = useState<RemotePullOperation | null>(null);
  const [pullProgress, setPullProgress] = useState("");
  const [selectedId, setSelectedId] = useState(props.initialSelectedModelId);
  const [downloadId, setDownloadId] = useState("");
  const [inventoryBusy, setInventoryBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    message: string;
    resolve: (value: boolean) => void;
  } | null>(null);
  const pendingConfirmation = useRef<((value: boolean) => void) | null>(null);
  const activePull = useRef<RemotePullOperation | null>(null);
  const pullTicker = useRef<ReturnType<typeof setInterval> | undefined>(
    undefined,
  );
  const inventoryController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const confirm = (title: string, message: string): Promise<boolean> =>
    new Promise((resolve) => {
      pendingConfirmation.current?.(false);
      pendingConfirmation.current = resolve;
      setConfirmation({ title, message, resolve });
    });
  useEffect(() => {
    props.onBusyChange?.(busy || !!confirmation);
  }, [busy, confirmation, props.onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingConfirmation.current?.(false);
      inventoryController.current?.abort();
      activePull.current?.cancel();
      if (pullTicker.current) clearInterval(pullTicker.current);
      props.onBusyChange?.(false);
    };
  }, []);
  const catalogModels = useMemo(
    () =>
      searchCatalog(
        { schemaVersion: 1, revision: "ui", models: [...props.catalog] },
        query,
      ),
    [props.catalog, query],
  );
  const reload = useCallback(
    async (modelId = selectedId) => {
      inventoryController.current?.abort();
      const controller = new AbortController();
      inventoryController.current = controller;
      if (!props.remote || !props.connectionId) {
        setRemoteModels([]);
        return;
      }
      setInventoryBusy(true);
      try {
        const models = await props.remote.inventory(
          props.connectionId,
          modelId,
          controller.signal,
        );
        if (!controller.signal.aborted && mounted.current)
          setRemoteModels(models);
      } catch (error) {
        if (!controller.signal.aborted && mounted.current) {
          setRemoteModels([]);
          setMessage(errorText(error));
        }
      } finally {
        if (!controller.signal.aborted && mounted.current)
          setInventoryBusy(false);
      }
    },
    [props.remote, props.connectionId, selectedId],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  const select = async (id: string) => {
    const previous = selectedId;
    if (previous && previous !== id) {
      const confirmed = await confirm(
        "Change saved model choice?",
        "Save this exact model for the selected server. Choose the saved provider in chat to use it. Existing chat history stays available.",
      );
      if (!confirmed) return;
    }
    if (!mounted.current) return;
    setBusy(true);
    try {
      await props.onSelectModel?.(id);
      if (!mounted.current) return;
      const serverModel = remoteById.get(id);
      applyModelSelection(props.lifecycle, id, serverModel);
      setSelectedId(id);
      if (previous && previous !== id) await props.onContextReload?.(id);
      if (previous && previous !== id && props.onImageHostUpdate) {
        const update = await confirm(
          "Update image model host?",
          "The image endpoint is configured independently. Update it to use this model host?",
        );
        if (update) await props.onImageHostUpdate(id);
      }
      await reload(id);
      setMessage(
        "Model choice saved. Choose the saved provider in chat to use it.",
      );
    } catch (error) {
      if (mounted.current) setMessage(errorText(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const download = async (id: string) => {
    if (!props.remote?.pull || !props.connectionId) {
      setMessage("Connect to an Ollama server to download models.");
      return;
    }
    let ticker: ReturnType<typeof setInterval> | undefined;
    try {
      setBusy(true);
      setMessage("");
      const operation = props.remote.pull(props.connectionId, id);
      activePull.current = operation;
      setPull(operation);
      ticker = setInterval(() => {
        if (mounted.current)
          setPullProgress(formatProgress(operation.progress));
      }, 300);
      pullTicker.current = ticker;
      const result = await operation.result;
      clearInterval(ticker);
      pullTicker.current = undefined;
      activePull.current = null;
      if (!mounted.current) return;
      setPullProgress("");
      setPull(null);
      const status =
        typeof result === "object" && result !== null && "status" in result
          ? String(result.status)
          : "completed";
      setMessage(
        status === "completed" ? "Download complete." : `Download ${status}.`,
      );
      await reload();
    } catch (error) {
      if (ticker) clearInterval(ticker);
      pullTicker.current = undefined;
      activePull.current = null;
      if (!mounted.current) return;
      setPullProgress("");
      setPull(null);
      setMessage(errorText(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const deleteRemote = async (id: string) => {
    if (!props.remote?.delete || !props.connectionId) return;
    const yes = await confirm(
      "Delete downloaded model?",
      `Remove ${id} from ${props.connectionName ?? "the server"}?`,
    );
    if (!yes) return;
    if (!mounted.current) return;
    setBusy(true);
    try {
      await props.remote.delete(props.connectionId, id);
      if (!mounted.current) return;
      setMessage("Model deleted.");
      await reload();
    } catch (error) {
      if (mounted.current) setMessage(errorText(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const local = props.lifecycle.getAll();
  const matchesQuery = (id: string) =>
    id.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const remoteById = new Map(remoteModels.map((model) => [model.id, model]));
  const localById = new Map(local.map((model) => [model.modelId, model]));

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}
    >
      <Text accessibilityRole="header" variant="headlineSmall">
        Models
      </Text>
      {props.localModelsSection}
      <Text>
        {props.connectionName
          ? `Server: ${props.connectionName}`
          : "Choose a server in Connections to manage remote models."}
      </Text>
      <Searchbar
        accessibilityLabel="Search models"
        placeholder="Search models"
        value={query}
        onChangeText={setQuery}
      />
      {props.remote ? (
        <NativeButton
          accessibilityLabel="Refresh server models"
          disabled={busy || inventoryBusy || !!confirmation}
          onPress={() => {
            setMessage("");
            void reload();
          }}
        >
          Refresh server models
        </NativeButton>
      ) : null}
      {inventoryBusy ? (
        <Text accessibilityLiveRegion="polite">
          Refreshing server inventory…
        </Text>
      ) : null}
      {confirmation ? (
        <NativeSurface
          accessibilityLabel="Confirm model action"
          style={styles.card}
        >
          <Text accessibilityRole="header">{confirmation.title}</Text>
          <Text>{confirmation.message}</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <NativeButton
              accessibilityLabel="Confirm model action"
              onPress={() => {
                pendingConfirmation.current = null;
                setConfirmation(null);
                confirmation.resolve(true);
              }}
            >
              Continue
            </NativeButton>
            <NativeButton
              accessibilityLabel="Cancel model action"
              onPress={() => {
                pendingConfirmation.current = null;
                setConfirmation(null);
                confirmation.resolve(false);
              }}
            >
              Cancel
            </NativeButton>
          </View>
        </NativeSurface>
      ) : null}
      {message ? (
        <Text
          accessibilityRole="alert"
          style={{ color: theme.colors.onSurface }}
        >
          {message}
        </Text>
      ) : null}
      {pull ? (
        <View>
          <Text>
            Downloading {pull.id}… {pullProgress}
          </Text>
          <NativeButton
            accessibilityLabel="Cancel download"
            onPress={() => pull.cancel()}
          >
            Cancel download
          </NativeButton>
        </View>
      ) : null}
      <Text variant="titleMedium">Imported models and saved choices</Text>
      {local.length === 0 ? (
        <Text>No imported or downloaded models yet.</Text>
      ) : (
        local
          .filter((model) => matchesQuery(model.modelId))
          .map((model) => (
            <NativeSurface
              accessibilityLabel={`Model ${model.modelId}`}
              key={model.modelId}
              style={styles.card}
            >
              <Text variant="titleSmall">{model.modelId}</Text>
              <Text>{modelStatus(model).join(" · ")}</Text>
              <NativeButton
                accessibilityLabel={
                  model.selected ? "Selected" : `Select ${model.modelId}`
                }
                disabled={
                  busy || inventoryBusy || !!confirmation || model.selected
                }
                onPress={() => void select(model.modelId)}
              >
                {model.selected ? "Selected" : "Select"}
              </NativeButton>
            </NativeSurface>
          ))
      )}
      <Text variant="titleMedium">Server models</Text>
      {props.remote && props.connectionId ? (
        remoteModels
          .filter((model) => matchesQuery(model.id))
          .map((model) => (
            <NativeSurface
              accessibilityLabel={`Server model ${model.id}`}
              key={model.id}
              style={styles.card}
            >
              <Text variant="titleSmall">{model.id}</Text>
              <Text>
                {modelStatus({
                  ...model,
                  selected: model.id === selectedId,
                }).join(" · ")}
              </Text>
              {model.id !== selectedId ? (
                <NativeButton
                  accessibilityLabel={`Select ${model.id}`}
                  disabled={busy || inventoryBusy || !!confirmation}
                  onPress={() => void select(model.id)}
                >
                  Select
                </NativeButton>
              ) : (
                <NativeButton
                  accessibilityLabel="Save selected model for chat"
                  disabled={busy || inventoryBusy || !!confirmation}
                  onPress={() => void select(model.id)}
                >
                  Use selected model in chat
                </NativeButton>
              )}
              {!model.installed && props.remote?.pull ? (
                <NativeButton
                  accessibilityLabel={`Download ${model.id}`}
                  disabled={busy || !!confirmation || !!pull}
                  onPress={() => void download(model.id)}
                >
                  Download
                </NativeButton>
              ) : null}
              {model.installed && props.remote?.delete ? (
                <NativeButton
                  accessibilityLabel={`Delete ${model.id}`}
                  disabled={busy || inventoryBusy || !!confirmation}
                  onPress={() => void deleteRemote(model.id)}
                >
                  Delete
                </NativeButton>
              ) : null}
            </NativeSurface>
          ))
      ) : (
        <Text>
          No supported server connected. Add an Ollama or OpenAI-compatible
          connection in Connections.
        </Text>
      )}
      {props.remote &&
      !inventoryBusy &&
      remoteModels.filter((model) => matchesQuery(model.id)).length === 0 ? (
        <Text>
          No server models match this search. Refresh inventory or check the
          selected connection.
        </Text>
      ) : null}
      {props.remote?.pull ? (
        <View style={{ gap: 8 }}>
          <TextInput
            accessibilityLabel="Exact Ollama model ID to download"
            label="Exact Ollama model ID"
            value={downloadId}
            onChangeText={setDownloadId}
            editable={!busy}
            autoCapitalize="none"
          />
          <NativeButton
            accessibilityLabel="Download exact Ollama model"
            disabled={busy || !!confirmation || !downloadId.trim()}
            onPress={() => void download(downloadId.trim())}
          >
            Download model on server
          </NativeButton>
        </View>
      ) : props.remote ? (
        <Text>
          This API lists available model IDs. Downloaded and loaded states,
          download, and delete are not exposed by this server API.
        </Text>
      ) : null}
      <Text variant="titleMedium">Browse catalog</Text>
      {catalogModels.map((model) => {
        const status = remoteById.get(model.id);
        const imported = localById.get(model.id);
        return (
          <NativeSurface
            accessibilityLabel={`Catalog model ${model.name}`}
            key={model.id}
            style={styles.card}
          >
            <Text variant="titleSmall">{model.name}</Text>
            <Text>
              {model.publisher} · {model.formats.join(", ")} ·{" "}
              {model.quants.join(", ")}
            </Text>
            <Text>{model.description}</Text>
            <Text>
              License: {model.license.name} ({model.license.commercialUse})
            </Text>
            <Text>
              {modelStatus({
                ...(status ?? {}),
                ...(imported?.imported === undefined
                  ? {}
                  : { imported: imported.imported }),
                ...(imported?.downloaded === undefined
                  ? {}
                  : { downloaded: imported.downloaded }),
              }).join(" · ")}
            </Text>
          </NativeSurface>
        );
      })}
      <Text style={styles.note}>
        Server model IDs can differ from catalog names. Ollama downloads require
        an exact server model ID. Phone downloads use the verified GGUF files
        listed above.
      </Text>
    </ScrollView>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Model action failed.";
}
function formatProgress(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const progress = "progress" in value ? value.progress : undefined;
  const completed = "completed" in value ? value.completed : undefined;
  const total = "total" in value ? value.total : undefined;
  if (typeof progress === "number" && Number.isFinite(progress))
    return `${Math.round(progress * 100)}%`;
  if (typeof completed === "number" && typeof total === "number" && total > 0)
    return `${Math.round((completed / total) * 100)}%`;
  return "";
}
const styles = StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 32 },
  card: { padding: 14, gap: 8 },
  note: { opacity: 0.7 },
});
