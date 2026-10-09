import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Dialog, List, Portal, Searchbar, SegmentedButtons, Text, TextInput, useTheme } from "react-native-paper";
import {
  NativeButton,
  NativeSurface,
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";
import { searchCatalog } from "@locallab/models-catalog";
import type {
  ModelFeatureDependencies,
  RemoteModel,
  RemotePullOperation,
} from "./index";
import { applyModelSelection, modelStatus } from "./index";
import { describeError } from "../diagnostics/errors";
import { ErrorNotice } from "../diagnostics/error-notice";
import { traceLog } from "../diagnostics/trace-log";

export function ModelsScreen(props: ModelFeatureDependencies) {
  const theme = useTheme();
  const { phone } = useWorkspaceLayout();
  const scroll = useRef<ScrollView>(null);
  const [section, setSection] = useState<"phone" | "connected">(
    () => props.initialSection ?? (props.connectionId ? "connected" : "phone"),
  );
  const [query, setQuery] = useState("");
  const [remoteModels, setRemoteModels] = useState<readonly RemoteModel[]>([]);
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [modelChosen, setModelChosen] = useState(false);
  const [inventoryError, setInventoryError] = useState("");
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
  useEffect(() => {
    if (props.initialSection) setSection(props.initialSection);
  }, [props.initialSection]);
  useEffect(() => {
    if (phone && (message || actionError || inventoryError))
      scroll.current?.scrollTo({ y: 0, animated: true });
  }, [phone, message, actionError, inventoryError]);
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
      setInventoryError("");
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
          setInventoryError(describeError(error, {
            operation: "Load models from the selected connection",
            recovery: "Check that this server is running and reachable, then tap Reload models. Open Connections to check its address and API key.",
          }));
        }
      } finally {
        if (!controller.signal.aborted && mounted.current)
          setInventoryBusy(false);
      }
    },
    [props.remote, props.connectionId, selectedId],
  );
  useEffect(() => {
    if (!phone || section === "connected") void reload();
  }, [reload, phone, section]);

  const select = async (id: string) => {
    const previous = selectedId;
    if (previous && previous !== id) {
      const confirmed = await confirm(
        "Change saved model choice?",
        props.onReturnToChat
          ? "Use this model for your next message. Your saved conversations stay available."
          : "Save this exact model for the selected server. Choose the saved provider in chat to use it. Existing chat history stays available.",
      );
      if (!confirmed) return;
    }
    if (!mounted.current) return;
    setBusy(true);
    setModelChosen(false);
    setMessage("");
    setActionError("");
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
        props.onReturnToChat
          ? "Model selected. Return to chat to use it."
          : "Model choice saved. Choose the saved provider in chat to use it.",
      );
      setModelChosen(true);
    } catch (error) {
      if (mounted.current) setActionError(describeError(error, {
        operation: "Select a connected model for chat",
        recovery: "Reload models to check the saved choice. Open Connections to check this provider, then try selecting the model again.",
      }));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const download = async (id: string) => {
    if (!props.remote?.pull || !props.connectionId) {
      setMessage("");
      setActionError(describeError(new Error("This connection does not expose an Ollama model download API."), {
        operation: "Download a model on the server",
        recovery: "Open Connections and choose an Ollama server, or install this model using your provider's own app.",
      }));
      return;
    }
    let ticker: ReturnType<typeof setInterval> | undefined;
    try {
      setBusy(true);
      setMessage("");
      setActionError("");
      traceLog.event("Server model download", "start");
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
      if (status === "failed") {
        const cause = typeof result === "object" && result !== null && "error" in result
          ? result.error : "The server reported a failed download without details.";
        throw new Error(String(cause));
      }
      traceLog.event("Server model download", status === "completed" ? "complete" : "cancelled");
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
      setActionError(describeError(error, {
        operation: "Download a model on the server",
        recovery: "Check the server connection and available disk space. Refresh server models before trying the download again.",
      }));
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
    setMessage("");
    setActionError("");
    try {
      await props.remote.delete(props.connectionId, id);
      if (!mounted.current) return;
      setMessage("Model deleted.");
      await reload();
    } catch (error) {
      if (mounted.current) setActionError(describeError(error, {
        operation: "Delete a model from the server",
        recovery: "Refresh server models to check whether it remains. Check the connection, then try Delete again if needed.",
      }));
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
      ref={scroll}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={phone ? styles.phoneContent : styles.content}
    >
      <View style={phone ? styles.phoneIntro : undefined}>
        <Text
          accessibilityRole="header"
          accessibilityLabel="Models"
          variant={phone ? "headlineMedium" : "headlineSmall"}
          style={phone ? styles.phoneHeading : undefined}
        >
          {phone ? "Your models" : "Models"}
        </Text>
        {phone ? (
          <Text
            variant="bodyLarge"
            style={{ color: theme.colors.onSurfaceVariant }}
          >
            Chat offline on this phone, or choose a model from a saved
            connection.
          </Text>
        ) : null}
      </View>
      {phone ? (
        <SegmentedButtons
          value={section}
          onValueChange={(value) => setSection(value as "phone" | "connected")}
          buttons={[
            { value: "phone", label: "On this phone", accessibilityLabel: "On this phone", style: { minHeight: 44 } },
            { value: "connected", label: "Connected models", accessibilityLabel: "Connected models", style: { minHeight: 44 } },
          ].map((item) => ({ ...item, disabled: busy || !!confirmation || !!props.phoneDownloadBusy }))}
        />
      ) : null}
      {actionError ? <ErrorNotice message={actionError} /> : null}
      {inventoryError ? (
        <View style={{ gap: 8 }}>
          <ErrorNotice message={inventoryError} />
          <NativeButton
            accessibilityLabel="Retry loading connected models"
            mode="outlined"
            disabled={busy || inventoryBusy}
            onPress={() => void reload()}
          >
            Reload models
          </NativeButton>
          {props.onOpenConnections ? (
            <NativeButton accessibilityLabel="Check model connection" disabled={busy || inventoryBusy} onPress={props.onOpenConnections}>
              Open Connections
            </NativeButton>
          ) : null}
        </View>
      ) : null}
      {props.localModelsSection ? (
        <View style={phone ? { display: section === "phone" ? "flex" : "none" } : undefined}>
          {props.localModelsSection}
        </View>
      ) : null}
      <View style={{ display: !phone || section === "connected" ? "flex" : "none", gap: phone ? 20 : 12 }}>
      {props.connectionSelector}
      {message ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: theme.colors.onSurface }}
        >
          {message}
        </Text>
      ) : null}
      {modelChosen && props.onReturnToChat ? (
        <NativeButton
          accessibilityLabel="Return to chat with selected model"
          mode="contained"
          disabled={busy}
          onPress={props.onReturnToChat}
        >
          Return to chat
        </NativeButton>
      ) : null}
      <Text
        variant="bodyMedium"
        style={phone ? { color: theme.colors.onSurfaceVariant } : undefined}
      >
        {props.connectionName
          ? `Server: ${props.connectionName}`
          : "Choose a server in Connections to manage remote models."}
      </Text>
      {!props.connectionId && props.onOpenConnections ? (
        <NativeButton
          accessibilityLabel="Connect a model provider"
          mode="outlined"
          icon="lan-connect"
          onPress={props.onOpenConnections}
        >
          Add a connection
        </NativeButton>
      ) : null}
      <Searchbar
        role="searchbox"
        accessibilityLabel="Search models"
        placeholder={phone ? "Search server and catalog" : "Search models"}
        value={query}
        onChangeText={setQuery}
        style={phone ? styles.phoneSearch : undefined}
      />
      {props.remote ? (
        <NativeButton
          accessibilityLabel="Refresh server models"
          {...(phone ? { mode: "outlined" as const, icon: "refresh" } : {})}
          disabled={busy || inventoryBusy || !!confirmation}
          onPress={() => {
            setMessage("");
            setActionError("");
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
        <ModelConfirmation
          phone={phone}
          onCancel={() => {
            pendingConfirmation.current = null;
            setConfirmation(null);
            confirmation.resolve(false);
          }}
        >
          <Text accessibilityRole="header" variant={phone ? "titleLarge" : "bodyMedium"}>
            {confirmation.title}
          </Text>
          <Text>{confirmation.message}</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <NativeButton
              accessibilityLabel="Confirm model action"
              {...(phone ? { mode: "contained" as const } : {})}
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
        </ModelConfirmation>
      ) : null}
      {pull ? (
        <View
          style={
            phone
              ? [
                  styles.phoneDownload,
                  { backgroundColor: theme.colors.secondaryContainer },
                ]
              : undefined
          }
        >
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
      <PhoneModelSection
        phone={phone}
        title="Saved model choices"
        reveal={!!query.trim()}
        description={
          local.length
            ? `${local.length} saved on this device`
            : "Imported models and saved selections"
        }
      >
        {!phone ? (
          <Text variant="titleMedium">Imported models and saved choices</Text>
        ) : null}
        {local.length === 0 ? (
          <Text>No imported or downloaded models yet.</Text>
        ) : (
          local
            .filter((model) => matchesQuery(model.modelId))
            .map((model) => (
              <NativeSurface
                accessibilityLabel={`Model ${model.modelId}`}
                key={model.modelId}
                style={phone ? styles.phoneCard : styles.card}
              >
                <Text variant={phone ? "titleMedium" : "titleSmall"}>
                  {model.modelId}
                </Text>
                <Text>{modelStatus(model).join(" · ")}</Text>
                <NativeButton
                  accessibilityLabel={
                    model.selected ? "Selected" : `Select ${model.modelId}`
                  }
                  {...(phone ? { mode: "outlined" as const } : {})}
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
      </PhoneModelSection>
      <PhoneModelSection
        phone={phone}
        title="Connected models"
        description={props.connectionName ?? "Use a connected model server"}
        initiallyExpanded={!!props.connectionId}
        reveal={!!query.trim()}
      >
        {!phone ? <Text variant="titleMedium">Server models</Text> : null}
        {props.remote && props.connectionId ? (
          remoteModels
            .filter((model) => matchesQuery(model.id))
            .map((model) => (
              <NativeSurface
                accessibilityLabel={`Server model ${model.id}`}
                key={model.id}
                style={phone ? styles.phoneCard : styles.card}
              >
                <Text variant={phone ? "titleMedium" : "titleSmall"}>
                  {model.id}
                </Text>
                <Text>
                  {modelStatus({
                    ...model,
                    selected: model.id === selectedId,
                  }).join(" · ")}
                </Text>
                {model.id !== selectedId ? (
                  <NativeButton
                    accessibilityLabel={`Select ${model.id}`}
                    {...(phone ? { mode: "contained" as const } : {})}
                    disabled={busy || inventoryBusy || !!confirmation}
                    onPress={() => void select(model.id)}
                  >
                    {phone && props.onReturnToChat ? "Use in chat" : "Select"}
                  </NativeButton>
                ) : (
                  <NativeButton
                    accessibilityLabel="Save selected model for chat"
                    {...(phone ? { mode: "contained" as const } : {})}
                    disabled={busy || inventoryBusy || !!confirmation}
                    onPress={() => void select(model.id)}
                  >
                    Use selected model in chat
                  </NativeButton>
                )}
                {!model.installed && props.remote?.pull ? (
                  <NativeButton
                    accessibilityLabel={`Download ${model.id}`}
                    {...(phone ? { mode: "outlined" as const } : {})}
                    disabled={busy || !!confirmation || !!pull}
                    onPress={() => void download(model.id)}
                  >
                    Download
                  </NativeButton>
                ) : null}
                {model.installed && props.remote?.delete ? (
                  <NativeButton
                    accessibilityLabel={`Delete ${model.id}`}
                    {...(phone ? { textColor: theme.colors.error } : {})}
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
        !inventoryError &&
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
              {...(phone ? { mode: "outlined" as const } : {})}
            />
            <NativeButton
              accessibilityLabel="Download exact Ollama model"
              {...(phone ? { mode: "contained" as const } : {})}
              disabled={busy || !!confirmation || !downloadId.trim()}
              onPress={() => void download(downloadId.trim())}
            >
              Download model on server
            </NativeButton>
          </View>
        ) : props.remote ? (
          <Text>
            {phone
              ? "Use these models through your saved connection. Downloads are managed by the provider."
              : "This API lists available model IDs. Downloaded and loaded states, download, and delete are not exposed by this server API."}
          </Text>
        ) : null}
      </PhoneModelSection>
      <PhoneModelSection
        phone={phone}
        title="Model reference"
        description="Publishers, formats, and licences"
        reveal={!!query.trim()}
      >
        {!phone ? <Text variant="titleMedium">Browse catalog</Text> : null}
        {catalogModels.map((model) => {
          const status = remoteById.get(model.id);
          const imported = localById.get(model.id);
          return (
            <NativeSurface
              accessibilityLabel={`Catalog model ${model.name}`}
              key={model.id}
              style={phone ? styles.phoneCard : styles.card}
            >
              <Text variant={phone ? "titleMedium" : "titleSmall"}>
                {model.name}
              </Text>
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
          Server model IDs can differ from catalog names. Ollama downloads
          require an exact server model ID. Phone downloads use the verified
          GGUF files listed above.
        </Text>
      </PhoneModelSection>
      </View>
    </ScrollView>
  );
}

function PhoneModelSection({
  phone,
  title,
  description,
  children,
  initiallyExpanded = false,
  reveal = false,
}: {
  phone: boolean;
  title: string;
  description: string;
  children: ReactNode;
  initiallyExpanded?: boolean;
  reveal?: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const theme = useTheme();
  if (!phone) return <>{children}</>;
  return (
    <NativeSurface
      accessibilityLabel={title}
      style={styles.phoneDisclosureCard}
    >
      <List.Accordion
        title={title}
        description={description}
        titleNumberOfLines={2}
        descriptionNumberOfLines={2}
        accessibilityLabel={`Show ${title.toLowerCase()}`}
        expanded={expanded || reveal}
        onPress={() => setExpanded((value) => !value)}
        style={styles.phoneDisclosure}
        theme={{ colors: { background: theme.colors.surface } }}
      >
        <View style={styles.phoneDisclosureBody}>{children}</View>
      </List.Accordion>
    </NativeSurface>
  );
}

function ModelConfirmation({
  phone,
  onCancel,
  children,
}: {
  phone: boolean;
  onCancel: () => void;
  children: ReactNode;
}) {
  if (!phone)
    return (
      <NativeSurface accessibilityLabel="Confirm model action" style={styles.card}>
        {children}
      </NativeSurface>
    );
  return (
    <Portal>
      <Dialog visible onDismiss={onCancel}>
        <Dialog.Content>
          <View style={{ gap: 12 }}>{children}</View>
        </Dialog.Content>
      </Dialog>
    </Portal>
  );
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
  phoneContent: { padding: 20, gap: 20, paddingBottom: 32 },
  phoneIntro: { gap: 8, paddingBottom: 4 },
  phoneHeading: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  phoneSearch: { borderRadius: 18 },
  phoneCard: { padding: 18, gap: 12 },
  phoneDownload: { borderRadius: 20, padding: 16, gap: 10 },
  phoneDisclosureCard: { padding: 0, overflow: "hidden" },
  phoneDisclosure: { backgroundColor: "transparent" },
  phoneDisclosureBody: { padding: 16, paddingTop: 4, gap: 16 },
});
