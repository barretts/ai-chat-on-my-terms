import { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { Dialog, Icon, List, Portal, Text, useTheme } from "react-native-paper";
import type { ReactNode } from "react";
import {
  NativeButton,
  NativeSurface,
  NativeActivity,
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";
import { curatedCatalog, type CatalogModel } from "@locallab/models-catalog";
import {
  downloadLocalModel,
  listInstalledModels,
  deleteLocalModel,
  type InstalledLocalModel,
} from "../../platform/model-download";
import { describeError } from "../diagnostics/errors";
import { ErrorNotice } from "../diagnostics/error-notice";
import { traceLog } from "../diagnostics/trace-log";

export function LocalModelsSection({
  onSelect,
  selectedBlobId,
  onBusyChange,
  onReturnToChat,
  onErrorChange,
}: {
  onSelect(model: InstalledLocalModel): Promise<void>;
  selectedBlobId?: string;
  onBusyChange?(busy: boolean): void;
  onReturnToChat?(): void;
  onErrorChange?(message: string): void;
}) {
  const { phone } = useWorkspaceLayout();
  const theme = useTheme();
  const [installed, setInstalled] = useState<InstalledLocalModel[]>([]);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [modelChosen, setModelChosen] = useState(false);
  const [progress, setProgress] = useState("");
  const [remove, setRemove] = useState<InstalledLocalModel | null>(null);
  const [moreModelsExpanded, setMoreModelsExpanded] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    onErrorChange?.(error);
  }, [error, onErrorChange]);
  const reloadInstalled = async () => {
    setError("");
    try {
      const models = await listInstalledModels();
      if (mounted.current) setInstalled(models);
    } catch (cause) {
      if (mounted.current)
        setError(
          describeError(cause, {
            operation: "Load downloaded phone models",
            recovery:
              "Tap Reload Models to reopen model storage. Check available device storage, then try again.",
          }),
        );
    }
  };
  useEffect(() => {
    onBusyChange?.(!!busy || !!remove);
  }, [busy, remove, onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    void reloadInstalled();
    return () => {
      mounted.current = false;
      controller.current?.abort();
      onBusyChange?.(false);
    };
  }, []);
  const download = async (model: CatalogModel) => {
    if (controller.current || busy) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(model.id);
    setMessage("");
    setError("");
    setProgress("Starting download…");
    traceLog.event("Phone model download and install", "start");
    try {
      await downloadLocalModel(
        model,
        ({ bytes, total, phase }) => {
          if (mounted.current)
            setProgress(
              phase === "saving"
                ? "Download complete. Saving to your model library…"
                : `Downloading ${formatBytes(bytes)} / ${formatBytes(total)} (${Math.min(100, Math.floor((bytes / total) * 100))}%)`,
            );
        },
        abort.signal,
      );
      traceLog.event("Phone model download and install", "complete");
      if (mounted.current) {
        setInstalled(await listInstalledModels());
        setMessage(`${model.name} is ready in your model library.`);
      }
    } catch (error) {
      if (abort.signal.aborted) {
        traceLog.event("Phone model download and install", "cancelled");
        if (mounted.current)
          setMessage("Download cancelled. No partial model was installed.");
      } else {
        const message = describeError(error, {
          operation: "Download and install a phone model",
          recovery:
            "Keep Models open, check your internet connection and free device storage, then try Download again.",
        });
        if (mounted.current) setError(message);
      }
    } finally {
      controller.current = null;
      if (mounted.current) {
        setBusy("");
        setProgress("");
      }
    }
  };
  const useModel = async (model: InstalledLocalModel) => {
    setBusy(model.catalogId);
    setMessage("");
    setError("");
    setModelChosen(false);
    try {
      await onSelect(model);
      if (mounted.current) {
        setModelChosen(true);
        setMessage(
          Platform.OS === "web"
            ? "Model choice saved. Open the iPhone app to run it; browser downloads stay in this browser."
            : "Model selected. Return to chat to start an offline conversation.",
        );
      }
    } catch (error) {
      if (mounted.current)
        setError(
          describeError(error, {
            operation: "Select a downloaded phone model for chat",
            recovery:
              "Reload Models to check that this download remains installed, then try Use in chat again.",
          }),
        );
    } finally {
      if (mounted.current) setBusy("");
    }
  };
  const models = curatedCatalog.models.filter((model) => model.artifact);
  const phoneModels = [...models].sort(
    (left, right) =>
      Number(right.artifact!.tier === "balanced") -
      Number(left.artifact!.tier === "balanced"),
  );
  const phoneCard = (model: CatalogModel) => {
    const local = installed.find((item) => item.catalogId === model.id);
    const suggested = model.artifact!.tier === "balanced";
    return (
      <NativeSurface
        key={model.id}
        accessibilityLabel={`Phone model ${model.name}`}
        style={styles.phoneCard}
      >
        <View style={styles.phoneBadge}>
          <Icon
            source={suggested ? "star-four-points" : "cellphone"}
            size={16}
            color={theme.colors.primary}
          />
          <Text variant="labelLarge" style={{ color: theme.colors.primary }}>
            {suggested
              ? "Suggested"
              : model.artifact!.tier === "faster"
                ? "Faster"
                : "Larger"}
          </Text>
        </View>
        <View style={styles.phoneSummary}>
          <Text variant="headlineSmall" style={styles.phoneModelName}>
            {model.name.replace(/ Q4_K_M$/, "")}
          </Text>
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.onSurfaceVariant }}
          >
            {formatBytes(model.artifact!.sizeBytes)} ·{" "}
            {local ? "Ready on this device" : "Download once for offline use"}
          </Text>
          <Text variant="bodyLarge">
            {suggested
              ? "Start here on iPhone 17 Pro Max."
              : model.artifact!.tier === "faster"
                ? "A smaller download for quick offline replies."
                : "For more demanding replies; needs more memory."}
          </Text>
        </View>
        <View style={styles.phoneActions}>
          <NativeButton
            accessibilityLabel={`Download ${model.name} on this device`}
            mode={suggested && !local ? "contained" : "outlined"}
            {...(!local ? { icon: "download" } : {})}
            disabled={!!busy || !!local}
            onPress={() => void download(model)}
          >
            {local ? "Downloaded" : "Download"}
          </NativeButton>
          {local && (
            <>
              <NativeButton
                accessibilityLabel={`Use ${model.name} for offline chat`}
                mode="contained"
                disabled={!!busy}
                onPress={() => void useModel(local)}
              >
                {selectedBlobId === local.blobId ? "Selected" : "Use in chat"}
              </NativeButton>
              <NativeButton
                accessibilityLabel={`Remove ${model.name} download`}
                mode="text"
                textColor={theme.colors.error}
                disabled={!!busy}
                onPress={() => setRemove(local)}
              >
                Remove download
              </NativeButton>
            </>
          )}
        </View>
        <List.Accordion
          title="Model details"
          theme={{ colors: { background: theme.colors.surface } }}
          accessibilityLabel={`Show details for ${model.name}`}
          titleStyle={styles.phoneDetailsLabel}
          style={styles.phoneDetails}
        >
          <View style={styles.phoneDetailsBody}>
            <Text variant="bodyMedium">{model.name}</Text>
            <Text variant="bodyMedium">
              {model.artifact!.contextWindow / 1024}K context ·{" "}
              {model.license.id}
            </Text>
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant }}
            >
              Download size is exact. Speed and memory fit depend on your phone
              and current conditions.
            </Text>
          </View>
        </List.Accordion>
      </NativeSurface>
    );
  };
  return (
    <View style={{ gap: 12 }}>
      <Text variant={phone ? "titleMedium" : "titleLarge"}>Phone models</Text>
      {error && !onErrorChange ? <ErrorNotice message={error} /> : null}
      {error ? (
        <NativeButton
          accessibilityLabel="Reload downloaded phone models"
          mode="outlined"
          disabled={!!busy}
          onPress={() => void reloadInstalled()}
        >
          Reload phone models
        </NativeButton>
      ) : null}
      {message ? <Text accessibilityLiveRegion="polite">{message}</Text> : null}
      {modelChosen && onReturnToChat ? (
        <NativeButton
          accessibilityLabel="Return to chat with selected phone model"
          mode="contained"
          disabled={!!busy}
          onPress={onReturnToChat}
        >
          Return to chat
        </NativeButton>
      ) : null}
      {phone ? (
        <View style={styles.phoneNotice}>
          {Platform.OS === "web" ? (
            <Text
              variant="bodyMedium"
              style={{ color: theme.colors.onSurfaceVariant }}
            >
              Offline chat runs in the iPhone app. Browser downloads stay in
              this browser and do not transfer to your phone.
            </Text>
          ) : null}
          <Text
            variant="bodySmall"
            style={{ color: theme.colors.onSurfaceVariant }}
          >
            Keep Models open while downloading. Cancel leaves no installed
            partial file.
          </Text>
        </View>
      ) : (
        <>
          <Text>
            For iPhone 17 Pro Max, start with Qwen3.5 2B. Choose 0.8B for a
            smaller download, or try 4B for more demanding replies. These are
            text models at Q4_K_M, starting with a 4K context.
          </Text>
          <Text>
            Download size is exact. Speed and memory fit depend on your phone
            and current conditions.
          </Text>
          {Platform.OS === "web" && (
            <Text>
              Browser preview can download and save a model choice. Offline GGUF
              chat runs in the iPhone app. Downloads do not transfer between
              devices.
            </Text>
          )}
        </>
      )}
      {phone ? (
        <View style={styles.phoneModels}>
          {progress ? (
            <NativeSurface
              accessibilityLabel="Phone model download progress"
              style={styles.phoneCard}
            >
              <NativeActivity label={progress} />
              <NativeButton
                accessibilityLabel="Cancel phone model download"
                mode="outlined"
                onPress={() => controller.current?.abort()}
              >
                Cancel download
              </NativeButton>
            </NativeSurface>
          ) : null}
          {phoneModels.slice(0, 1).map(phoneCard)}
          <NativeSurface
            accessibilityLabel="Other phone models"
            style={styles.phoneAlternatives}
          >
            <List.Accordion
              title="Other phone models"
              description="A smaller download or more demanding replies"
              descriptionNumberOfLines={2}
              accessibilityLabel="Show other phone models"
              theme={{ colors: { background: theme.colors.surface } }}
              expanded={moreModelsExpanded}
              onPress={() => setMoreModelsExpanded((value) => !value)}
              style={styles.phoneDetails}
            >
              <View style={styles.phoneAlternativeCards}>
                {phoneModels.slice(1).map(phoneCard)}
              </View>
            </List.Accordion>
          </NativeSurface>
        </View>
      ) : (
        models.map((model) => {
          const local = installed.find((item) => item.catalogId === model.id);
          return (
            <NativeSurface
              key={model.id}
              accessibilityLabel={`Phone model ${model.name}`}
              style={{ padding: 14, gap: 8 }}
            >
              <Text variant="titleMedium">
                {model.artifact!.tier === "balanced"
                  ? "Suggested · "
                  : `${model.artifact!.tier === "faster" ? "Faster" : "Larger"} · `}
                {model.name}
              </Text>
              <Text>
                {formatBytes(model.artifact!.sizeBytes)} · {model.license.name}
              </Text>
              <Text>{model.description}</Text>
              <Text>
                {local
                  ? "Ready on this device"
                  : "Download once for offline use"}
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <NativeButton
                  accessibilityLabel={`Download ${model.name} on this device`}
                  disabled={!!busy || !!local}
                  onPress={() => void download(model)}
                >
                  {local ? "Downloaded" : "Download"}
                </NativeButton>
                {local && (
                  <>
                    <NativeButton
                      accessibilityLabel={`Use ${model.name} for offline chat`}
                      disabled={!!busy}
                      onPress={() => void useModel(local)}
                    >
                      {selectedBlobId === local.blobId
                        ? "Selected"
                        : "Use in chat"}
                    </NativeButton>
                    <NativeButton
                      accessibilityLabel={`Remove ${model.name} download`}
                      disabled={!!busy}
                      onPress={() => setRemove(local)}
                    >
                      Remove download
                    </NativeButton>
                  </>
                )}
              </View>
              {busy === model.id && progress ? (
                <NativeActivity label={progress} />
              ) : null}
            </NativeSurface>
          );
        })
      )}
      {!phone && controller.current && (
        <NativeButton
          accessibilityLabel="Cancel phone model download"
          {...(phone ? { mode: "outlined" as const } : {})}
          onPress={() => controller.current?.abort()}
        >
          Cancel download
        </NativeButton>
      )}
      {remove && (
        <LocalModelRemoval phone={phone} onCancel={() => setRemove(null)}>
          <Text variant={phone ? "titleLarge" : "bodyMedium"}>
            Remove {remove.name} from this device?
          </Text>
          <Text>
            Saved conversations remain available. Choose another model before
            continuing chat.
          </Text>
          <NativeButton
            accessibilityLabel="Confirm remove phone model"
            {...(phone
              ? {
                  mode: "contained" as const,
                  buttonColor: theme.colors.error,
                  textColor: theme.colors.onError,
                }
              : {})}
            onPress={() => {
              const target = remove;
              setRemove(null);
              setBusy(target.catalogId);
              setError("");
              setMessage("");
              traceLog.event("Remove downloaded phone model", "start");
              void deleteLocalModel(target)
                .then(async () => {
                  traceLog.event("Remove downloaded phone model", "complete");
                  if (mounted.current) {
                    setInstalled(await listInstalledModels());
                    setMessage("Model download removed.");
                  }
                })
                .catch((error: unknown) => {
                  const message = describeError(error, {
                    operation: "Remove a downloaded phone model",
                    recovery:
                      "Reload Models to check whether the download remains. Check available storage, then try Remove download again if needed.",
                  });
                  if (mounted.current) setError(message);
                })
                .finally(() => {
                  if (mounted.current) setBusy("");
                });
            }}
          >
            Remove
          </NativeButton>
          <NativeButton
            accessibilityLabel="Keep phone model download"
            onPress={() => setRemove(null)}
          >
            Keep download
          </NativeButton>
        </LocalModelRemoval>
      )}
      {!phone ? (
        <Text>
          Keep Models open while downloading. Cancel leaves no installed partial
          file.
        </Text>
      ) : null}
    </View>
  );
}

function LocalModelRemoval({
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
      <NativeSurface
        accessibilityLabel="Confirm phone model removal"
        style={{ padding: 14, gap: 8 }}
      >
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

const styles = StyleSheet.create({
  phoneNotice: { gap: 8, paddingBottom: 4 },
  phoneModels: { gap: 14 },
  phoneCard: { padding: 18, gap: 14 },
  phoneBadge: { flexDirection: "row", alignItems: "center", gap: 6 },
  phoneSummary: { gap: 6 },
  phoneModelName: { fontWeight: "600", letterSpacing: -0.4 },
  phoneActions: { gap: 8 },
  phoneDetails: { backgroundColor: "transparent", paddingVertical: 0 },
  phoneDetailsLabel: { fontSize: 15 },
  phoneDetailsBody: { gap: 8, paddingVertical: 8 },
  phoneAlternatives: { overflow: "hidden" },
  phoneAlternativeCards: { padding: 12, paddingTop: 0, gap: 12 },
});

function formatBytes(bytes: number): string {
  return bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(2)} GB`
    : `${(bytes / 1e6).toFixed(1)} MB`;
}
