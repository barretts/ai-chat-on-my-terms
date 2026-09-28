import { useState } from "react";
import { View } from "react-native";
import { Text } from "react-native-paper";
import { NativeButton, NativeSurface } from "@locallab/ui-native-primitives";
import type { ArchiveFeaturePorts } from "./index";
import { importLMStudioFile } from "./index";

export function ArchivesScreen(props: { ports: ArchiveFeaturePorts }) {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Archive operation failed",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <NativeSurface accessibilityLabel="Chat import and export">
      <View accessibilityLabel="Chat import and export">
        <Text variant="titleLarge">Import and export</Text>
        <NativeButton
          accessibilityLabel="Import LM Studio export"
          disabled={busy}
          onPress={() =>
            void run(async () => {
              const count = await importLMStudioFile(props.ports);
              setStatus(
                count ? `Imported ${count} conversations` : "Import canceled",
              );
            })
          }
        >
          Import LM Studio export
        </NativeButton>
        <NativeButton
          accessibilityLabel="Export chat as TXT"
          disabled={busy}
          onPress={() =>
            void run(async () => {
              await props.ports.exportSelected("txt");
              setStatus("TXT export ready");
            })
          }
        >
          Export chat as TXT
        </NativeButton>
        <NativeButton
          accessibilityLabel="Export chat as PDF"
          disabled={busy}
          onPress={() =>
            void run(async () => {
              await props.ports.exportSelected("pdf");
              setStatus("PDF export ready");
            })
          }
        >
          Export chat as PDF
        </NativeButton>
        <NativeButton
          accessibilityLabel="Export all chats as ZIP"
          disabled={busy}
          onPress={() =>
            void run(async () => {
              await props.ports.exportAll();
              setStatus("Chat archive ready");
            })
          }
        >
          Export all chats as ZIP
        </NativeButton>
        {props.ports.importAll ? (
          <NativeButton
            accessibilityLabel="Import ZIP archive"
            disabled={busy}
            onPress={() =>
              void run(async () => {
                const count = await props.ports.importAll!();
                setStatus(
                  count ? `Imported ${count} conversations` : "Import canceled",
                );
              })
            }
          >
            Import ZIP archive
          </NativeButton>
        ) : null}
        {status ? <Text accessibilityLiveRegion="polite">{status}</Text> : null}
      </View>
    </NativeSurface>
  );
}
