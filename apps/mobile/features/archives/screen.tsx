import { useEffect, useRef, useState } from "react";
import { ScrollView } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { NativeButton, NativeSurface, useWorkspaceLayout } from "@locallab/ui-native-primitives";
import { describeError } from "../diagnostics/errors";
import { ErrorNotice } from "../diagnostics/error-notice";
import type { ArchiveFeaturePorts } from "./index";
import { importLMStudioFile } from "./index";

export function ArchivesScreen(props: {
  ports: ArchiveFeaturePorts;
  onOpenLibrary?: () => void;
}) {
  const theme = useTheme();
  const { phone } = useWorkspaceLayout();
  const scroll = useRef<ScrollView>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [importedCount, setImportedCount] = useState(0);
  const operationActive = useRef(false);
  useEffect(() => {
    if (phone && failed) scroll.current?.scrollTo({ y: 0, animated: true });
  }, [phone, failed, status]);
  const run = async (operation: string, recovery: string, work: () => Promise<void>) => {
    if (operationActive.current) return;
    operationActive.current = true;
    setBusy(true);
    setStatus("");
    setFailed(false);
    setImportedCount(0);
    try {
      await work();
    } catch (error) {
      setFailed(true);
      setStatus(describeError(error, { operation, recovery }));
    } finally {
      operationActive.current = false;
      setBusy(false);
    }
  };
  return (
    <ScrollView
      ref={scroll}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: 16, paddingBottom: 24 }}
    >
      <Text accessibilityRole="header" variant="headlineSmall">
        Import & export
      </Text>
      <Text>
        Save a copy of the open chat, back up your conversations, or bring chats
        into LocalLab. To find chats you archived, open Recent chats.
      </Text>
      {failed && status ? <ErrorNotice message={status} /> : status ? (
        <Text
          accessibilityRole={failed ? "alert" : "text"}
          accessibilityLiveRegion="polite"
          style={{ color: failed ? theme.colors.error : theme.colors.onSurface }}
        >
          {status}
        </Text>
      ) : null}
      {importedCount > 0 && props.onOpenLibrary ? (
        <NativeButton
          accessibilityLabel="View imported chats in Library"
          mode="contained"
          onPress={props.onOpenLibrary}
        >
          View imported chats
        </NativeButton>
      ) : null}
      {busy ? <Text accessibilityLiveRegion="polite">Working…</Text> : null}
      <NativeSurface
        accessibilityLabel="Export the open conversation"
        style={{ padding: 16, gap: 12 }}
      >
        <Text variant="titleMedium">This conversation</Text>
        <Text>Export the chat that is currently open. Choose where to save or share the file.</Text>
        <NativeButton
          accessibilityLabel="Export chat as TXT"
          mode="outlined"
          disabled={busy}
          onPress={() =>
            void run("Export the open chat as TXT", "Try Export chat as TXT again and choose a writable save location.", async () => {
              await props.ports.exportSelected("txt");
              setStatus("TXT export ready");
            })
          }
        >
          Export chat as TXT
        </NativeButton>
        <NativeButton
          accessibilityLabel="Export chat as PDF"
          mode="outlined"
          disabled={busy}
          onPress={() =>
            void run("Export the open chat as PDF", "Try Export chat as PDF again and choose a writable save location.", async () => {
              await props.ports.exportSelected("pdf");
              setStatus("PDF export ready");
            })
          }
        >
          Export chat as PDF
        </NativeButton>
      </NativeSurface>
      <NativeSurface
        accessibilityLabel="Back up all conversations"
        style={{ padding: 16, gap: 12 }}
      >
        <Text variant="titleMedium">Back up your chats</Text>
        <Text>Save a ZIP you can import into LocalLab later.</Text>
        <NativeButton
          accessibilityLabel="Export all chats as ZIP"
          mode="contained"
          disabled={busy}
          onPress={() =>
            void run("Back up all chats as ZIP", "Try Export all chats as ZIP again and choose a writable save location.", async () => {
              await props.ports.exportAll();
              setStatus("Chat archive ready");
            })
          }
        >
          Export all chats as ZIP
        </NativeButton>
      </NativeSurface>
      <NativeSurface
        accessibilityLabel="Import conversations"
        style={{ padding: 16, gap: 12 }}
      >
        <Text variant="titleMedium">Import chats</Text>
        <Text>
          {props.ports.importAll
            ? "Choose a LocalLab ZIP backup or a JSON file exported by LM Studio."
            : "Choose a JSON file exported by LM Studio."}
        </Text>
        <NativeButton
          accessibilityLabel="Import LM Studio export"
          disabled={busy}
          onPress={() =>
            void run("Import LM Studio chats", "Choose the JSON chat export from LM Studio and try the import again.", async () => {
              const count = await importLMStudioFile(props.ports);
              setImportedCount(count);
              setStatus(
                count ? `Imported ${count} conversations` : "Import canceled",
              );
            })
          }
        >
          Import LM Studio export
        </NativeButton>
        {props.ports.importAll ? (
          <NativeButton
            accessibilityLabel="Import ZIP archive"
            disabled={busy}
            onPress={() =>
              void run("Import a LocalLab ZIP backup", "Choose a ZIP exported by LocalLab and try the import again.", async () => {
                const count = await props.ports.importAll!();
                setImportedCount(count);
                setStatus(
                  count ? `Imported ${count} conversations` : "Import canceled",
                );
              })
            }
          >
            Import ZIP archive
          </NativeButton>
        ) : null}
      </NativeSurface>
    </ScrollView>
  );
}
