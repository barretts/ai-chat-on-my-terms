import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import {
  ActivityIndicator,
  Divider,
  List,
  SegmentedButtons,
  Text,
  TextInput,
  useTheme,
} from "react-native-paper";
import {
  NativeButton,
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";
import type { ZipPort } from "@locallab/archives";
import type { ArchiveFilePort } from "../../composition/chat/archives/types";
import { writeClipboardMarkdown } from "../../platform/clipboard";
import { ErrorNotice } from "../diagnostics/error-notice";
import { describeError } from "../diagnostics/errors";
import { RichMarkdown } from "../transcript/rich/renderer";
import { exportWorkspaceFile, exportWorkspaceZip } from "./export";
import type {
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceFilesStore,
} from "./store";

export interface WorkspaceFilesScreenProps {
  store: WorkspaceFilesStore;
  files: Pick<ArchiveFilePort, "share">;
  zip: Pick<ZipPort, "encode">;
  /** Changes after a model response so the open panel sees newly written files. */
  refreshKey?: string | number;
  phoneLayout?: boolean;
  onFilesChanged?: () => void;
}

interface EditorDraft {
  path: string;
  content: string;
  expectedRevision?: number;
}

function displaySize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

/** A file workspace backed by this chat, with native previews and user-controlled exports. */
export function WorkspaceFilesScreen(props: WorkspaceFilesScreenProps) {
  const theme = useTheme();
  const layout = useWorkspaceLayout();
  const phone = props.phoneLayout ?? layout.phone;
  const [entries, setEntries] = useState<readonly WorkspaceFileMetadata[]>([]);
  const [selected, setSelected] = useState<WorkspaceFile | null>(null);
  const [editor, setEditor] = useState<EditorDraft | null>(null);
  const [view, setView] = useState("preview");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const selectedPath = useRef<string | null>(null);
  const editing = useRef(false);
  const version = useRef(0);
  const actionActive = useRef(false);
  const scroll = useRef<ScrollView>(null);

  const reload = useCallback(async () => {
    const request = ++version.current;
    const path = selectedPath.current;
    setLoading(true);
    try {
      const rows = await props.store.list();
      const current =
        path && !editing.current ? await props.store.read(path) : undefined;
      if (request !== version.current) return;
      setEntries(rows);
      setLoadError("");
      if (path && path === selectedPath.current && !editing.current) {
        setSelected(current ?? null);
        if (!current) selectedPath.current = null;
      }
    } catch (cause) {
      if (request !== version.current) return;
      setLoadError(
        describeError(cause, {
          operation: "Load chat files",
          recovery:
            "Tap Reload files to try again. Your saved files and unsaved editor text are kept.",
        }),
      );
    } finally {
      if (request === version.current) setLoading(false);
    }
  }, [props.store]);

  useEffect(() => {
    selectedPath.current = null;
    editing.current = false;
    setSelected(null);
    setEditor(null);
    setEntries([]);
    setError("");
    setStatus("");
  }, [props.store]);
  useEffect(() => {
    void reload();
    return () => {
      version.current++;
    };
  }, [reload, props.refreshKey]);
  useEffect(() => {
    if (phone && (error || loadError))
      scroll.current?.scrollTo({ y: 0, animated: true });
  }, [phone, error, loadError]);

  const perform = async (
    operation: string,
    recovery: string,
    work: () => Promise<void>,
    success?: string,
  ) => {
    if (actionActive.current) return;
    actionActive.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      // Invoke immediately so browser clipboard actions retain the user's gesture.
      await work();
      if (success) setStatus(success);
    } catch (cause) {
      setError(describeError(cause, { operation, recovery }));
    } finally {
      actionActive.current = false;
      setBusy(false);
    }
  };

  const open = (path: string) => {
    void perform(
      "Open chat file",
      "Tap Reload files, then open the file again.",
      async () => {
        ++version.current;
        const file = await props.store.read(path);
        if (!file)
          throw new Error(
            `The file ${path} is no longer available in this chat.`,
          );
        selectedPath.current = file.path;
        setSelected(file);
        setView("preview");
        setLoading(false);
        scroll.current?.scrollTo({ y: 0, animated: false });
      },
    );
  };
  const startEditor = (file?: WorkspaceFile) => {
    editing.current = true;
    setEditor(
      file
        ? {
            path: file.path,
            content: file.content,
            expectedRevision: file.revision,
          }
        : { path: "", content: "" },
    );
    setError("");
    setStatus("");
    scroll.current?.scrollTo({ y: 0, animated: false });
  };
  const cancelEditor = () => {
    editing.current = false;
    setEditor(null);
    setError("");
    void reload();
  };
  const save = () => {
    if (!editor) return;
    const draft = editor;
    void perform(
      "Save chat file",
      "Your editor text is kept. Check the filename or read the current file revision before trying again.",
      async () => {
        const file = await props.store.write(draft);
        selectedPath.current = file.path;
        editing.current = false;
        setEditor(null);
        setSelected(file);
        setView("preview");
        await reload();
        props.onFilesChanged?.();
      },
      `Saved ${draft.path}.`,
    );
  };
  const backToFiles = () => {
    selectedPath.current = null;
    setSelected(null);
    setError("");
    setStatus("");
    void reload();
  };
  const totalBytes = entries.reduce(
    (total, entry) => total + entry.byteLength,
    0,
  );
  const sourceStyle = {
    color: theme.colors.onSurface,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: phone ? 15 : 14,
    lineHeight: phone ? 23 : 21,
  };

  return (
    <ScrollView
      ref={scroll}
      style={{ flex: 1 }}
      contentContainerStyle={{
        padding: phone ? 16 : 20,
        gap: 16,
        paddingBottom: 32,
      }}
      keyboardShouldPersistTaps="handled"
      accessibilityLabel="Chat file workspace"
      testID="workspace-files-screen"
    >
      {error || loadError ? (
        <ErrorNotice
          message={[error, loadError].filter(Boolean).join("\n\n")}
        />
      ) : null}
      {status ? (
        <Text
          selectable
          accessibilityLiveRegion="polite"
          style={{ color: theme.colors.primary }}
        >
          {status}
        </Text>
      ) : null}
      {editor ? (
        <View style={{ gap: 16 }}>
          <Text variant="headlineSmall">
            {editor.expectedRevision ? "Edit file" : "New file"}
          </Text>
          <View style={{ gap: 8 }}>
            <Text variant="labelLarge">Filename</Text>
            <TextInput
              mode="outlined"
              placeholder="notes/plan.md"
              accessibilityLabel="Workspace filename"
              autoCapitalize="none"
              autoCorrect={false}
              value={editor.path}
              disabled={busy || editor.expectedRevision !== undefined}
              onChangeText={(path) =>
                setEditor((draft) => (draft ? { ...draft, path } : draft))
              }
            />
          </View>
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.onSurfaceVariant }}
          >
            Use a .md or .txt filename. Folders such as notes/plan.md are
            supported.
          </Text>
          <View style={{ gap: 8 }}>
            <Text variant="labelLarge">File content</Text>
            <TextInput
              mode="outlined"
              accessibilityLabel="Complete workspace file content"
              value={editor.content}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              disabled={busy}
              style={{ minHeight: phone ? 280 : 360 }}
              contentStyle={{
                ...sourceStyle,
                textAlignVertical: "top",
                paddingTop: 16,
              }}
              onChangeText={(content) =>
                setEditor((draft) => (draft ? { ...draft, content } : draft))
              }
            />
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <NativeButton
              accessibilityLabel="Save file in this chat"
              mode="contained"
              icon="content-save-outline"
              disabled={busy || !editor.path}
              loading={busy}
              onPress={save}
            >
              Save file
            </NativeButton>
            <NativeButton
              accessibilityLabel="Cancel editing this file"
              mode="outlined"
              disabled={busy}
              onPress={cancelEditor}
            >
              Cancel
            </NativeButton>
          </View>
          <Text
            variant="bodySmall"
            style={{ color: theme.colors.onSurfaceVariant }}
          >
            Save before closing the Files panel to keep your edits.
          </Text>
        </View>
      ) : selected ? (
        <View style={{ gap: 16 }}>
          <NativeButton
            accessibilityLabel="Back to chat files"
            icon="arrow-left"
            mode="text"
            disabled={busy}
            style={{ alignSelf: "flex-start" }}
            onPress={backToFiles}
          >
            Files
          </NativeButton>
          <Text selectable variant="titleLarge" style={{ flexShrink: 1 }}>
            {selected.path}
          </Text>
          <Text
            variant="bodySmall"
            style={{ color: theme.colors.onSurfaceVariant }}
          >
            {displaySize(selected.byteLength)} · Revision {selected.revision}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <NativeButton
              accessibilityLabel={`Edit ${selected.path}`}
              icon="pencil-outline"
              mode="outlined"
              disabled={busy}
              onPress={() => startEditor(selected)}
            >
              Edit
            </NativeButton>
            <NativeButton
              accessibilityLabel={`Copy the full text of ${selected.path}`}
              icon="content-copy"
              mode="text"
              disabled={busy}
              onPress={() => {
                void perform(
                  "Copy file text",
                  "Select the source text to copy it manually, or try Copy again.",
                  () => writeClipboardMarkdown(selected.content),
                  "File text copied.",
                );
              }}
            >
              Copy
            </NativeButton>
            <NativeButton
              accessibilityLabel={`Export ${selected.path}`}
              icon="export-variant"
              mode="text"
              disabled={busy}
              onPress={() => {
                void perform(
                  "Export file",
                  "Try Export again and choose Save to Files or another destination in the share sheet.",
                  () =>
                    exportWorkspaceFile(
                      props.store,
                      selected.path,
                      props.files,
                    ),
                  Platform.OS === "web"
                    ? "File download started."
                    : "File export opened.",
                );
              }}
            >
              Export
            </NativeButton>
          </View>
          {selected.kind === "markdown" ? (
            <SegmentedButtons
              value={view}
              onValueChange={setView}
              buttons={[
                {
                  value: "preview",
                  label: "Preview",
                  accessibilityLabel: "Preview Markdown file",
                },
                {
                  value: "source",
                  label: "Source",
                  accessibilityLabel: "View Markdown source",
                },
              ]}
            />
          ) : null}
          <Divider />
          {selected.kind === "markdown" && view === "preview" ? (
            <RichMarkdown
              markdown={selected.content || "_This file is empty._"}
              phoneLayout={phone}
              showCopyAction={false}
              accessibilityLabel={`Preview of ${selected.path}`}
            />
          ) : (
            <Text
              selectable
              style={sourceStyle}
              accessibilityLabel={`Source of ${selected.path}`}
            >
              {selected.content || "This file is empty."}
            </Text>
          )}
        </View>
      ) : (
        <View style={{ gap: 12 }}>
          {!phone ? <Text variant="headlineSmall">Files</Text> : null}
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.onSurfaceVariant }}
          >
            Files stay with this chat until you delete it.
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <NativeButton
              accessibilityLabel="Create a new chat file"
              mode="contained"
              icon="file-plus-outline"
              disabled={busy}
              onPress={() => startEditor()}
            >
              New file
            </NativeButton>
            <NativeButton
              accessibilityLabel="Export all chat files as ZIP"
              mode="outlined"
              icon="folder-zip-outline"
              disabled={busy || !entries.length}
              onPress={() => {
                void perform(
                  "Export chat files as ZIP",
                  "Try Export ZIP again and choose Save to Files or another destination in the share sheet.",
                  () => exportWorkspaceZip(props.store, props.files, props.zip),
                  Platform.OS === "web"
                    ? "ZIP download started."
                    : "ZIP export opened.",
                );
              }}
            >
              Export ZIP
            </NativeButton>
          </View>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant }}
            >
              {entries.length} {entries.length === 1 ? "file" : "files"} ·{" "}
              {displaySize(totalBytes)}
            </Text>
            <NativeButton
              accessibilityLabel="Reload files from this chat"
              mode="text"
              icon="refresh"
              disabled={busy}
              onPress={() => {
                void reload();
              }}
            >
              Reload
            </NativeButton>
          </View>
          {loading ? (
            <ActivityIndicator accessibilityLabel="Loading chat files" />
          ) : null}
          {!loading && !entries.length ? (
            <View style={{ paddingVertical: 24, gap: 12 }}>
              <Text variant="titleMedium">
                Your chat's files will appear here.
              </Text>
              <Text
                variant="bodyMedium"
                style={{ color: theme.colors.onSurfaceVariant }}
              >
                Ask the model to write a Markdown or text file, or create one
                yourself. Tap a file to preview, copy or export it.
              </Text>
            </View>
          ) : (
            entries.map((entry) => (
              <List.Item
                key={entry.path}
                title={entry.path}
                titleNumberOfLines={2}
                description={`${entry.kind === "markdown" ? "Markdown" : "Text"} · ${displaySize(entry.byteLength)} · Revision ${entry.revision}`}
                left={(iconProps) => (
                  <List.Icon
                    {...iconProps}
                    icon={
                      entry.kind === "markdown"
                        ? "language-markdown-outline"
                        : "file-document-outline"
                    }
                  />
                )}
                right={(iconProps) => (
                  <List.Icon {...iconProps} icon="chevron-right" />
                )}
                onPress={() => open(entry.path)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={`Open ${entry.path}, ${displaySize(entry.byteLength)}, revision ${entry.revision}`}
                style={{
                  backgroundColor: theme.colors.surfaceVariant,
                  borderRadius: 12,
                }}
              />
            ))
          )}
        </View>
      )}
    </ScrollView>
  );
}
