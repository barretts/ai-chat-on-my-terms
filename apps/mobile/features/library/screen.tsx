import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Searchbar, Text, TextInput, useTheme } from "react-native-paper";
import { NativeButton, NativeSurface } from "@locallab/ui-native-primitives";
import type { ConversationFolder, LibraryConversation } from "./index";
import { conversationDisplayTitle, type LibraryFeatureProps } from "./index";

export function LibraryScreen(props: LibraryFeatureProps) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [folders, setFolders] = useState<ConversationFolder[]>([]);
  const [conversations, setConversations] = useState<LibraryConversation[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ConversationFolder | null>(
    null,
  );
  const requestVersion = useRef(0);
  const mutationActive = useRef(false);
  const reload = useCallback(
    async (folderId = selectedFolder) => {
      const version = ++requestVersion.current;
      try {
        const result = await props.library.search(query, folderId);
        if (version !== requestVersion.current) return;
        setFolders(result.folders);
        setConversations(result.conversations);
        setError("");
      } catch (cause) {
        if (version !== requestVersion.current) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load conversations.",
        );
      }
    },
    [props.library, query, selectedFolder],
  );
  useEffect(() => {
    void reload();
    return () => {
      requestVersion.current++;
    };
  }, [reload]);
  const mutate = async (work: () => Promise<void>) => {
    if (mutationActive.current) return;
    mutationActive.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The library could not be updated.",
      );
    } finally {
      mutationActive.current = false;
      setBusy(false);
    }
  };
  const createFolder = async () => {
    await mutate(async () => {
      const folder = await props.library.createFolder({
        id: props.createId(),
        name: folderName,
        now: (props.now ?? (() => new Date().toISOString()))(),
      });
      setFolderName("");
      setSelectedFolder(folder.id);
      await reload(folder.id);
    });
  };
  const deleteFolder = async (folder: ConversationFolder) =>
    mutate(async () => {
      await props.library.deleteFolder(
        folder.id,
        (props.now ?? (() => new Date().toISOString()))(),
      );
      const nextFolder = selectedFolder === folder.id ? null : selectedFolder;
      setSelectedFolder(nextFolder);
      setPendingDelete(null);
      if (editingFolder === folder.id) setEditingFolder(null);
      await reload(nextFolder);
    });
  const move = async (conversationId: string, folderId: string | null) => {
    await mutate(async () => {
      await props.library.moveConversation(conversationId, folderId);
      await reload();
    });
  };
  const emptyText = query.trim()
    ? folders.length
      ? "No conversations match your search."
      : "No conversations or folders match your search."
    : selectedFolder
      ? "No conversations in this folder. Open All to move a saved chat here."
      : "No conversations yet. Start a chat and it will appear here.";

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}
    >
      <Text accessibilityRole="header" variant="headlineSmall">
        Library
      </Text>
      <Searchbar
        accessibilityLabel="Search conversations"
        maxLength={500}
        placeholder="Search conversations"
        value={query}
        onChangeText={setQuery}
      />
      {error ? (
        <Text accessibilityRole="alert" style={{ color: theme.colors.error }}>
          {error}
        </Text>
      ) : null}
      {pendingDelete ? (
        <NativeSurface
          accessibilityLabel="Confirm folder deletion"
          style={styles.card}
        >
          <Text>Delete {pendingDelete.name}?</Text>
          <Text>Conversations in this folder will stay in your library.</Text>
          <View style={styles.row}>
            <NativeButton
              accessibilityLabel="Confirm delete folder"
              disabled={busy}
              onPress={() => void deleteFolder(pendingDelete)}
            >
              Delete folder
            </NativeButton>
            <NativeButton
              accessibilityLabel="Cancel folder deletion"
              disabled={busy}
              onPress={() => setPendingDelete(null)}
            >
              Cancel
            </NativeButton>
          </View>
        </NativeSurface>
      ) : null}
      <Text variant="titleMedium">Folders</Text>
      <View style={styles.row}>
        <NativeButton
          accessibilityLabel="All conversations"
          accessibilityState={{ selected: selectedFolder === null }}
          disabled={busy}
          onPress={() => setSelectedFolder(null)}
        >
          All
        </NativeButton>
        {folders.map((folder) => (
          <NativeButton
            key={folder.id}
            accessibilityLabel={`Open folder ${folder.name}`}
            accessibilityState={{ selected: selectedFolder === folder.id }}
            disabled={busy}
            onPress={() => setSelectedFolder(folder.id)}
          >
            {folder.name}
          </NativeButton>
        ))}
      </View>
      {folders
        .filter(
          (folder) =>
            !query.trim() ||
            folder.name
              .toLocaleLowerCase()
              .includes(query.trim().toLocaleLowerCase()),
        )
        .map((folder) => (
          <NativeSurface
            accessibilityLabel={`Folder ${folder.name}`}
            key={`folder-${folder.id}`}
            style={[
              styles.card,
              { borderLeftColor: folder.color, borderLeftWidth: 4 },
            ]}
          >
            <Text variant="titleSmall">{folder.name}</Text>
            {folder.coverBlobId ? <Text>Folder cover saved</Text> : null}
            <View style={styles.row}>
              <NativeButton
                accessibilityLabel={`Rename ${folder.name}`}
                disabled={busy}
                onPress={() => {
                  setEditingFolder(folder.id);
                  setEditingName(folder.name);
                }}
              >
                Rename
              </NativeButton>
              <NativeButton
                accessibilityLabel={`Delete ${folder.name}`}
                disabled={busy}
                onPress={() => setPendingDelete(folder)}
              >
                Delete
              </NativeButton>
              {props.onSelectCover ? (
                <NativeButton
                  accessibilityLabel={`Change cover for ${folder.name}`}
                  disabled={busy}
                  onPress={() =>
                    void mutate(async () => {
                      const coverBlobId = await props.onSelectCover!(folder);
                      await props.library.updateFolder(folder.id, {
                        coverBlobId,
                        now: (props.now ?? (() => new Date().toISOString()))(),
                      });
                      await reload();
                    })
                  }
                >
                  Change cover
                </NativeButton>
              ) : null}
            </View>
            {editingFolder === folder.id ? (
              <View style={styles.row}>
                <TextInput
                  accessibilityLabel="Folder name"
                  mode="outlined"
                  value={editingName}
                  editable={!busy}
                  onChangeText={setEditingName}
                  style={styles.input}
                />
                <NativeButton
                  accessibilityLabel="Save folder name"
                  disabled={busy || !editingName.trim()}
                  onPress={() =>
                    void mutate(async () => {
                      await props.library.updateFolder(folder.id, {
                        name: editingName,
                        now: (props.now ?? (() => new Date().toISOString()))(),
                      });
                      await reload();
                      setEditingFolder(null);
                    })
                  }
                >
                  Save
                </NativeButton>
                <NativeButton
                  accessibilityLabel="Cancel folder rename"
                  disabled={busy}
                  onPress={() => setEditingFolder(null)}
                >
                  Cancel
                </NativeButton>
              </View>
            ) : null}
            <View style={styles.row}>
              {FOLDER_COLORS.map((color) => (
                <NativeButton
                  key={color}
                  accessibilityLabel={`Set ${folder.name} color ${color}`}
                  disabled={busy}
                  onPress={() =>
                    void mutate(async () => {
                      await props.library.updateFolder(folder.id, {
                        color,
                        now: (props.now ?? (() => new Date().toISOString()))(),
                      });
                      await reload();
                    })
                  }
                >
                  {color}
                </NativeButton>
              ))}
            </View>
          </NativeSurface>
        ))}
      <View style={styles.row}>
        <TextInput
          accessibilityLabel="New folder name"
          mode="outlined"
          value={folderName}
          editable={!busy}
          onChangeText={setFolderName}
          placeholder="Folder name"
          style={styles.input}
        />
        <NativeButton
          accessibilityLabel="Create folder"
          disabled={busy || !folderName.trim()}
          onPress={() => void createFolder()}
        >
          Create
        </NativeButton>
      </View>
      <Text variant="titleMedium">
        {selectedFolder ? "Folder conversations" : "Conversations"}
      </Text>
      {conversations.length === 0 ? (
        <Text accessibilityLabel="Library empty state" style={styles.empty}>
          {emptyText}
        </Text>
      ) : (
        conversations.map((conversation) => (
          <NativeSurface
            accessibilityLabel={`Conversation ${conversationDisplayTitle(conversation)}`}
            key={conversation.id}
            style={styles.card}
          >
            <NativeButton
              accessibilityLabel={`Open ${conversationDisplayTitle(conversation)}`}
              disabled={busy}
              onPress={() => props.onOpenConversation(conversation.id)}
            >
              {conversationDisplayTitle(conversation)}
            </NativeButton>
            <Text>
              {conversation.modelId
                ? `Model: ${conversation.modelId}`
                : "Model not recorded"}
              {conversation.lastUsedAt
                ? ` · Last used ${conversation.lastUsedAt}`
                : ""}
            </Text>
            {conversation.snippet ? (
              <Text numberOfLines={2}>{conversation.snippet}</Text>
            ) : null}
            <View style={styles.row}>
              {folders.map((folder) =>
                folder.id === conversation.folderId ? null : (
                  <NativeButton
                    key={folder.id}
                    accessibilityLabel={`Move to ${folder.name}`}
                    disabled={busy}
                    onPress={() => void move(conversation.id, folder.id)}
                  >
                    Move to {folder.name}
                  </NativeButton>
                ),
              )}
              {conversation.folderId ? (
                <NativeButton
                  accessibilityLabel="Remove from folder"
                  disabled={busy}
                  onPress={() => void move(conversation.id, null)}
                >
                  Remove from folder
                </NativeButton>
              ) : null}
            </View>
          </NativeSurface>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 32 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  card: { padding: 14, gap: 8 },
  input: { flex: 1, minWidth: 160 },
  empty: { opacity: 0.72, paddingVertical: 12 },
});

const FOLDER_COLORS = ["#6750A4", "#006A6A", "#9C4122", "#405F91"];
