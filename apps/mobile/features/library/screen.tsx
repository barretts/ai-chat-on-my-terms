import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  Divider,
  Icon,
  List,
  Searchbar,
  Text,
  TextInput,
  useTheme,
} from "react-native-paper";
import {
  NativeButton,
  NativeSurface,
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";
import type { ConversationFolder, LibraryConversation } from "./index";
import { conversationDisplayTitle, type LibraryFeatureProps } from "./index";
import { describeError } from "../diagnostics/errors";
import { ErrorNotice } from "../diagnostics/error-notice";

export function LibraryScreen(props: LibraryFeatureProps) {
  const theme = useTheme();
  const { phone } = useWorkspaceLayout();
  const scroll = useRef<ScrollView>(null);
  const [query, setQuery] = useState("");
  const [folders, setFolders] = useState<ConversationFolder[]>([]);
  const [conversations, setConversations] = useState<LibraryConversation[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ConversationFolder | null>(
    null,
  );
  const requestVersion = useRef(0);
  const mutationActive = useRef(false);
  useEffect(() => {
    if (phone && error) scroll.current?.scrollTo({ y: 0, animated: true });
  }, [phone, error]);
  const reload = useCallback(
    async (folderId = selectedFolder) => {
      const version = ++requestVersion.current;
      setLoading(true);
      try {
        const result = await props.library.search(query, folderId);
        if (version !== requestVersion.current) return;
        setFolders(result.folders);
        setConversations(result.conversations);
        setError("");
      } catch (cause) {
        if (version !== requestVersion.current) return;
        setError(describeError(cause, {
          operation: "Load conversations and folders",
          recovery: "Tap Reload conversations to read the library again.",
        }));
      } finally {
        if (version === requestVersion.current) setLoading(false);
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
  const mutate = async (operation: string, work: () => Promise<void>) => {
    if (mutationActive.current) return;
    mutationActive.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(describeError(cause, {
        operation,
        recovery: "Tap Reload conversations to check the saved result, then try this action again if needed.",
      }));
    } finally {
      mutationActive.current = false;
      setBusy(false);
    }
  };
  const createFolder = async () => {
    await mutate("Create a conversation folder", async () => {
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
    mutate("Delete a conversation folder", async () => {
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
    await mutate("Move a conversation between folders", async () => {
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
      ref={scroll}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={phone ? styles.phoneContent : styles.content}
    >
      <Text
        accessibilityRole="header"
        accessibilityLabel="Library"
        variant={phone ? "headlineMedium" : "headlineSmall"}
        style={phone ? styles.phoneHeading : undefined}
      >
        {phone ? "Your conversations" : "Library"}
      </Text>
      <Text
        variant="bodyMedium"
        style={{ color: theme.colors.onSurfaceVariant }}
      >
        Open a saved chat or organize it into folders. Recent and archived chats
        are managed in Recent chats.
      </Text>
      <Searchbar
        role="searchbox"
        accessibilityLabel="Search conversations"
        maxLength={500}
        placeholder="Search conversations"
        value={query}
        onChangeText={setQuery}
        style={phone ? styles.phoneSearch : undefined}
      />
      {error ? (
        <View style={{ gap: 8 }}>
          <ErrorNotice message={error} />
          <NativeButton
            accessibilityLabel="Reload conversations"
            mode="outlined"
            disabled={busy || loading}
            onPress={() => void reload()}
          >
            Reload conversations
          </NativeButton>
        </View>
      ) : null}
      {pendingDelete ? (
        <NativeSurface
          accessibilityLabel="Confirm folder deletion"
          style={phone ? styles.phoneCard : styles.card}
        >
          <Text>Delete {pendingDelete.name}?</Text>
          <Text>Conversations in this folder will stay in your library.</Text>
          <View style={styles.row}>
            <NativeButton
              accessibilityLabel="Confirm delete folder"
              {...(phone ? { mode: "contained" as const } : {})}
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
      {!phone ? <Text variant="titleMedium">Folders</Text> : null}
      <FolderFilterRow phone={phone}>
        <NativeButton
          accessibilityLabel="All conversations"
          accessibilityState={{ selected: selectedFolder === null }}
          {...(phone
            ? {
                mode:
                  selectedFolder === null
                    ? ("contained-tonal" as const)
                    : ("outlined" as const),
              }
            : {})}
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
            {...(phone
              ? {
                  mode:
                    selectedFolder === folder.id
                      ? ("contained-tonal" as const)
                      : ("outlined" as const),
                }
              : {})}
            disabled={busy}
            onPress={() => setSelectedFolder(folder.id)}
          >
            {folder.name}
          </NativeButton>
        ))}
      </FolderFilterRow>
      <FolderManagement phone={phone}>
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
                  {...(phone ? { textColor: theme.colors.error } : {})}
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
                      void mutate("Change a folder cover", async () => {
                        const coverBlobId = await props.onSelectCover!(folder);
                        await props.library.updateFolder(folder.id, {
                          coverBlobId,
                          now: (
                            props.now ?? (() => new Date().toISOString())
                          )(),
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
                    {...(phone
                      ? {
                          label: "Folder name",
                          outlineStyle: styles.phoneFieldOutline,
                        }
                      : {})}
                  />
                  <NativeButton
                    accessibilityLabel="Save folder name"
                    {...(phone ? { mode: "contained" as const } : {})}
                    disabled={busy || !editingName.trim()}
                    onPress={() =>
                      void mutate("Rename a conversation folder", async () => {
                        await props.library.updateFolder(folder.id, {
                          name: editingName,
                          now: (
                            props.now ?? (() => new Date().toISOString())
                          )(),
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
                    accessibilityLabel={`Set ${folder.name} color ${FOLDER_COLOR_NAMES[color] ?? color}`}
                    accessibilityState={{ selected: folder.color === color }}
                    disabled={busy}
                    onPress={() =>
                      void mutate("Change a folder color", async () => {
                        await props.library.updateFolder(folder.id, {
                          color,
                          now: (
                            props.now ?? (() => new Date().toISOString())
                          )(),
                        });
                        await reload();
                      })
                    }
                  >
                    {phone ? FOLDER_COLOR_NAMES[color] ?? color : color}
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
            {...(phone
              ? { label: "New folder", outlineStyle: styles.phoneFieldOutline }
              : {})}
          />
          <NativeButton
            accessibilityLabel="Create folder"
            {...(phone ? { mode: "contained" as const } : {})}
            disabled={busy || !folderName.trim()}
            onPress={() => void createFolder()}
          >
            Create
          </NativeButton>
        </View>
      </FolderManagement>
      {!phone || selectedFolder ? (
        <Text variant="titleMedium">
          {selectedFolder ? "Folder conversations" : "Conversations"}
        </Text>
      ) : null}
      {loading ? (
        <Text accessibilityLiveRegion="polite">Loading conversations…</Text>
      ) : error ? null : phone ? (
        conversations.length === 0 ? (
          <View style={styles.phoneEmpty}>
            <Icon
              source={query.trim() ? "magnify" : "message-text-outline"}
              size={32}
              color={theme.colors.onSurfaceVariant}
            />
            <Text variant="titleMedium">
              {query.trim()
                ? "Nothing found"
                : selectedFolder
                  ? "This folder is empty"
                  : "A fresh start"}
            </Text>
            <Text
              accessibilityLabel="Library empty state"
              variant="bodyLarge"
              style={[
                styles.phoneEmptyCopy,
                { color: theme.colors.onSurfaceVariant },
              ]}
            >
              {emptyText}
            </Text>
          </View>
        ) : (
          <NativeSurface
            accessibilityLabel="Saved conversations"
            style={styles.phoneConversationList}
          >
            {conversations.map((conversation, index) => (
              <View
                key={conversation.id}
                accessibilityLabel={`Conversation ${conversationDisplayTitle(conversation)}`}
              >
                {index > 0 ? <Divider /> : null}
                <List.Item
                  title={conversationDisplayTitle(conversation)}
                  titleNumberOfLines={2}
                  titleStyle={styles.phoneConversationTitle}
                  description={
                    conversation.snippet || "Continue this conversation"
                  }
                  descriptionNumberOfLines={2}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${conversationDisplayTitle(conversation)}`}
                  accessibilityState={{ disabled: busy }}
                  onPress={() => {
                    if (!busy) props.onOpenConversation(conversation.id);
                  }}
                  left={(iconProps) => (
                    <List.Icon {...iconProps} icon="message-outline" />
                  )}
                  right={(iconProps) => (
                    <View style={styles.phoneConversationEnd}>
                      {conversation.lastUsedAt ? (
                        <Text
                          variant="bodySmall"
                          style={{ color: theme.colors.onSurfaceVariant }}
                        >
                          {displayDate(conversation.lastUsedAt)}
                        </Text>
                      ) : null}
                      <List.Icon {...iconProps} icon="chevron-right" />
                    </View>
                  )}
                  style={styles.phoneConversationRow}
                />
                {folders.length || conversation.folderId ? (
                  <List.Accordion
                    title="Organize conversation"
                    accessibilityLabel={`Organize ${conversationDisplayTitle(conversation)}`}
                    theme={{ colors: { background: theme.colors.surface } }}
                    style={styles.phoneDisclosure}
                    titleStyle={styles.phoneOrganizeTitle}
                  >
                    <View style={styles.phoneMoveActions}>
                      {folders.map((folder) =>
                        folder.id === conversation.folderId ? null : (
                          <NativeButton
                            key={folder.id}
                            accessibilityLabel={`Move to ${folder.name}`}
                            disabled={busy}
                            onPress={() =>
                              void move(conversation.id, folder.id)
                            }
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
                  </List.Accordion>
                ) : null}
              </View>
            ))}
          </NativeSurface>
        )
      ) : conversations.length === 0 ? (
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

function FolderFilterRow({
  phone,
  children,
}: {
  phone: boolean;
  children: ReactNode;
}) {
  return phone ? (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.phoneFilters}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={styles.row}>{children}</View>
  );
}

function FolderManagement({
  phone,
  children,
}: {
  phone: boolean;
  children: ReactNode;
}) {
  const theme = useTheme();
  if (!phone) return <>{children}</>;
  return (
    <NativeSurface
      accessibilityLabel="Folder management"
      style={styles.phoneFolderManagement}
    >
      <List.Accordion
        title="Manage folders"
        accessibilityLabel="Manage folders"
        left={(iconProps) => <List.Icon {...iconProps} icon="folder-outline" />}
        theme={{ colors: { background: theme.colors.surface } }}
        style={styles.phoneDisclosure}
      >
        <View style={styles.phoneFolderControls}>{children}</View>
      </List.Accordion>
    </NativeSurface>
  );
}

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 32 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  card: { padding: 14, gap: 8 },
  input: { flex: 1, minWidth: 160 },
  empty: { opacity: 0.72, paddingVertical: 12 },
  phoneContent: { padding: 20, gap: 16, paddingBottom: 32 },
  phoneHeading: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: "600",
    letterSpacing: -0.4,
  },
  phoneSearch: { borderRadius: 18 },
  phoneCard: { padding: 18, gap: 12 },
  phoneFieldOutline: { borderRadius: 14 },
  phoneFilters: { flexDirection: "row", alignItems: "center", gap: 8 },
  phoneFolderManagement: { padding: 0, overflow: "hidden" },
  phoneDisclosure: { backgroundColor: "transparent", padding: 0 },
  phoneFolderControls: { padding: 16, paddingTop: 4, gap: 16 },
  phoneConversationList: { padding: 0, overflow: "hidden" },
  phoneConversationRow: { minHeight: 88, paddingVertical: 12 },
  phoneConversationTitle: { fontSize: 17, lineHeight: 23, fontWeight: "600" },
  phoneConversationEnd: { flexDirection: "row", alignItems: "center" },
  phoneOrganizeTitle: { fontSize: 14 },
  phoneMoveActions: { paddingHorizontal: 16, paddingBottom: 12, gap: 8 },
  phoneEmpty: { alignItems: "center", gap: 12, paddingVertical: 36 },
  phoneEmptyCopy: { textAlign: "center", maxWidth: 340 },
});

const FOLDER_COLORS = ["#6750A4", "#006A6A", "#9C4122", "#405F91"];
const FOLDER_COLOR_NAMES: Readonly<Record<string, string>> = {
  "#6750A4": "Purple",
  "#006A6A": "Teal",
  "#9C4122": "Orange",
  "#405F91": "Blue",
};
