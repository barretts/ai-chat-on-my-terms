import { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { Text } from "react-native-paper";
import {
  NativeButton,
  NativeSurface,
  NativeActivity,
} from "@locallab/ui-native-primitives";
import { curatedCatalog, type CatalogModel } from "@locallab/models-catalog";
import {
  downloadLocalModel,
  listInstalledModels,
  deleteLocalModel,
  type InstalledLocalModel,
} from "../../platform/model-download";

export function LocalModelsSection({
  onSelect,
  selectedBlobId,
  onBusyChange,
}: {
  onSelect(model: InstalledLocalModel): Promise<void>;
  selectedBlobId?: string;
  onBusyChange?(busy: boolean): void;
}) {
  const [installed, setInstalled] = useState<InstalledLocalModel[]>([]);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState("");
  const [remove, setRemove] = useState<InstalledLocalModel | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    onBusyChange?.(!!busy || !!remove);
  }, [busy, remove, onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    void listInstalledModels()
      .then(setInstalled)
      .catch((error: unknown) => setMessage(errorText(error)));
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
    setProgress("Starting download…");
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
      if (mounted.current) {
        setInstalled(await listInstalledModels());
        setMessage(`${model.name} is ready in your model library.`);
      }
    } catch (error) {
      if (mounted.current)
        setMessage(
          abort.signal.aborted
            ? "Download cancelled. No partial model was installed."
            : errorText(error),
        );
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
    try {
      await onSelect(model);
      if (mounted.current) {
        setMessage(
          Platform.OS === "web"
            ? "Model choice saved. Open the iPhone app to run it; browser downloads stay in this browser."
            : "Model selected. Return to chat to start an offline conversation.",
        );
      }
    } catch (error) {
      if (mounted.current) setMessage(errorText(error));
    } finally {
      if (mounted.current) setBusy("");
    }
  };
  return (
    <View style={{ gap: 12 }}>
      <Text variant="titleLarge">Phone models</Text>
      <Text>
        For iPhone 17 Pro Max, start with Qwen3.5 2B. Choose 0.8B for a smaller
        download, or try 4B for more demanding replies. These are text models at
        Q4_K_M, starting with a 4K context.
      </Text>
      <Text>
        Download size is exact. Speed and memory fit depend on your phone and
        current conditions.
      </Text>
      {Platform.OS === "web" && (
        <Text>
          Browser preview can download and save a model choice. Offline GGUF
          chat runs in the iPhone app. Downloads do not transfer between
          devices.
        </Text>
      )}
      {curatedCatalog.models
        .filter((model) => model.artifact)
        .map((model) => {
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
              <Text>{formatBytes(model.artifact!.sizeBytes)} · Apache 2.0</Text>
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
        })}
      {controller.current && (
        <NativeButton
          accessibilityLabel="Cancel phone model download"
          onPress={() => controller.current?.abort()}
        >
          Cancel download
        </NativeButton>
      )}
      {remove && (
        <NativeSurface
          accessibilityLabel="Confirm phone model removal"
          style={{ padding: 14, gap: 8 }}
        >
          <Text>Remove {remove.name} from this device?</Text>
          <Text>
            Saved conversations remain available. Choose another model before
            continuing chat.
          </Text>
          <NativeButton
            accessibilityLabel="Confirm remove phone model"
            onPress={() => {
              const target = remove;
              setRemove(null);
              setBusy(target.catalogId);
              void deleteLocalModel(target)
                .then(async () => {
                  if (mounted.current) {
                    setInstalled(await listInstalledModels());
                    setMessage("Model download removed.");
                  }
                })
                .catch((error: unknown) => {
                  if (mounted.current) setMessage(errorText(error));
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
        </NativeSurface>
      )}
      {message ? <Text accessibilityRole="alert">{message}</Text> : null}
      <Text>
        Keep Models open while downloading. Cancel leaves no installed partial
        file.
      </Text>
    </View>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Model action could not finish.";
}
function formatBytes(bytes: number): string {
  return bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(2)} GB`
    : `${(bytes / 1e6).toFixed(1)} MB`;
}
