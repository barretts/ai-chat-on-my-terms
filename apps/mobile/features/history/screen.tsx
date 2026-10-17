import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
} from "react-native";
import { IconButton, Searchbar, SegmentedButtons, Text, useTheme, type MD3Theme } from "react-native-paper";
import { NativeButton, useWorkspaceLayout } from "@locallab/ui-native-primitives";
import { describeError } from "../diagnostics/errors";
import { ErrorNotice } from "../diagnostics/error-notice";
import {
  deleteConfirmationText,
  formatHistoryDate,
  historyDisplayTitle,
  historyRowDate,
  historyRowLabel,
  historyRowReducer,
  IDLE_ROW,
  type HistoryConversation,
  type HistoryFeatureProps,
  type HistoryView,
} from "./index";

type Notice = { text: string; undo?: { id: string; title: string } } | null;

export function HistoryScreen(
  props: HistoryFeatureProps & { hideBackButton?: boolean },
) {
  const theme = useTheme();
  const { phone } = useWorkspaceLayout();
  const scroll = useRef<ScrollView>(null);
  const styles = useMemo(() => createStyles(theme, phone), [theme, phone]);
  const now = props.now ?? (() => new Date());
  const [view, setView] = useState<HistoryView>("recent");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<HistoryConversation[]>([]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [row, dispatch] = useReducer(historyRowReducer, IDLE_ROW);
  const requestVersion = useRef(0);
  const mutationActive = useRef(false);
  useEffect(() => {
    if (phone && error) scroll.current?.scrollTo({ y: 0, animated: true });
  }, [phone, error]);

  const reload = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const [next, count] = await Promise.all([
        props.history.listHistory({ archived: view === "archived", query }),
        props.history.countArchived(),
      ]);
      if (version !== requestVersion.current) return;
      setRows(next);
      setArchivedCount(count);
      setError("");
    } catch (cause) {
      if (version !== requestVersion.current) return;
      setError(describeError(cause, {
        operation: `Load ${view === "archived" ? "archived" : "recent"} chats`,
        recovery: "Tap Reload chats to read your saved conversations again.",
      }));
    } finally {
      if (version === requestVersion.current) setLoaded(true);
    }
  }, [props.history, query, view]);

  useEffect(() => {
    void reload();
    return () => {
      requestVersion.current++;
    };
  }, [reload]);

  const say = (text: string) => AccessibilityInfo.announceForAccessibility(text);

  const mutate = async (work: () => Promise<void>, operation: string, recovery: string) => {
    if (mutationActive.current) return;
    mutationActive.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      const message = describeError(cause, { operation, recovery });
      setError(message);
      say(message);
    } finally {
      mutationActive.current = false;
      setBusy(false);
    }
  };

  const archive = (conversation: HistoryConversation) =>
    mutate(async () => {
      const title = historyDisplayTitle(conversation);
      await props.history.archiveConversation(conversation.id, now().toISOString());
      dispatch({ type: "dismiss" });
      const text =
        conversation.id === props.currentConversationId
          ? `Archived "${title}". It stays open until you switch chats.`
          : `Archived "${title}". Find it under Archived.`;
      setNotice({ text, undo: { id: conversation.id, title } });
      say(text);
      await reload();
    }, "Archive a chat", "Reload chats to check its current location, then try Archive again.");

  const unarchive = (conversationId: string, title: string, fromUndo = false) =>
    mutate(async () => {
      await props.history.unarchiveConversation(conversationId);
      dispatch({ type: "dismiss" });
      const text = fromUndo
        ? `"${title}" is back in Recent.`
        : `Moved "${title}" back to Recent.`;
      setNotice({ text });
      say(text);
      await reload();
    }, "Move an archived chat back to Recent", "Reload chats to check its current location, then try Move to Recent again.");

  const remove = (conversation: HistoryConversation) =>
    mutate(async () => {
      const title = historyDisplayTitle(conversation);
      await props.onDeleteConversation(conversation.id);
      dispatch({ type: "dismiss" });
      const text = `Deleted "${title}".`;
      setNotice({ text });
      say(text);
      await reload();
    }, "Delete a chat", "Reload chats to check whether it remains, then try Delete again if needed.");

  const switchView = (next: HistoryView) => {
    dispatch({ type: "dismiss" });
    setNotice(null);
    setView(next);
  };

  const emptyText = query.trim()
    ? `No ${view === "archived" ? "archived " : ""}chats match "${query.trim()}".`
    : view === "archived"
      ? "Nothing archived. Archived chats wait here until you move them back."
      : "No chats yet. Go back to chat and start a new conversation.";

  return (
    <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      {!phone ? <View style={styles.titleRow}>
        <Text accessibilityRole="header" variant="titleLarge" style={styles.flex}>
          Chat history
        </Text>
        {!props.hideBackButton ? (
          <NativeButton accessibilityLabel="Back to chat" onPress={props.onClose}>
            Back to chat
          </NativeButton>
        ) : null}
      </View> : !props.hideBackButton ? (
        <NativeButton accessibilityLabel="Back to chat" onPress={props.onClose}>
          Back to chat
        </NativeButton>
      ) : null}

      {phone ? (
        <SegmentedButtons
          value={view}
          onValueChange={(value) => switchView(value as HistoryView)}
          buttons={[
            {
              value: "recent",
              label: "Recent",
              accessibilityLabel: "Recent",
              testID: "history-tab-recent",
              style: { minHeight: 44 },
            },
            {
              value: "archived",
              label: `Archived${archivedCount ? ` (${archivedCount})` : ""}`,
              accessibilityLabel: `Archived${archivedCount ? ` (${archivedCount})` : ""}`,
              testID: "history-tab-archived",
              style: { minHeight: 44 },
            },
          ]}
        />
      ) : <View accessibilityRole="tablist" style={styles.tabs}>
        {(["recent", "archived"] as const).map((key) => {
          const selected = view === key;
          const label = key === "recent" ? "Recent" : `Archived${archivedCount ? ` (${archivedCount})` : ""}`;
          return (
            <Pressable
              key={key}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected }}
              onPress={() => switchView(key)}
              style={[styles.bevel, styles.tab, selected && styles.tabSelected]}
              testID={`history-tab-${key}`}
            >
              <Text style={[styles.tabText, selected && styles.tabTextSelected]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>}

      <Searchbar
        role="searchbox"
        accessibilityLabel={view === "archived" ? "Search archived chats" : "Search chats"}
        maxLength={500}
        placeholder={view === "archived" ? "Search archived chats" : "Search chats"}
        value={query}
        onChangeText={setQuery}
        style={styles.search}
      />

      {notice ? (
        <View accessibilityRole="summary" style={styles.notice}>
          <Text style={styles.flex}>{notice.text}</Text>
          {notice.undo ? (
            <NativeButton
              accessibilityLabel={`Undo archive of ${notice.undo.title}`}
              disabled={busy}
              onPress={() => {
                const undo = notice.undo!;
                void unarchive(undo.id, undo.title, true);
              }}
            >
              Undo
            </NativeButton>
          ) : null}
          <NativeButton
            accessibilityLabel="Dismiss message"
            mode="text"
            disabled={busy}
            onPress={() => setNotice(null)}
          >
            OK
          </NativeButton>
        </View>
      ) : null}

      {error ? (
        <View style={{ gap: 8 }}>
          <ErrorNotice message={error} />
          <NativeButton
            accessibilityLabel="Reload chat history"
            mode="outlined"
            disabled={busy}
            onPress={() => void reload()}
          >
            Reload chats
          </NativeButton>
        </View>
      ) : null}

      {loaded && !error && rows.length === 0 ? (
        <Text style={styles.empty}>{emptyText}</Text>
      ) : null}

      <View style={styles.list}>
        {rows.map((conversation) => {
          const title = historyDisplayTitle(conversation);
          const current = conversation.id === props.currentConversationId;
          const archived = conversation.archivedAt !== null;
          const expanded = row.kind !== "idle" && row.id === conversation.id;
          const confirming = row.kind === "confirm-delete" && row.id === conversation.id;
          const toggle = () => {
            dispatch({ type: "toggle-actions", id: conversation.id });
            if (!expanded) say(`Actions for ${title}`);
          };
          const onAction = (event: AccessibilityActionEvent) => {
            switch (event.nativeEvent.actionName) {
              case "activate":
                props.onOpenConversation(conversation.id);
                break;
              case "archive":
                void (archived ? unarchive(conversation.id, title) : archive(conversation));
                break;
              case "delete":
                dispatch({ type: "request-delete", id: conversation.id });
                say(deleteConfirmationText({ title, current, working: !!props.working }));
                break;
            }
          };
          return (
            <View key={conversation.id} style={[styles.rowCard, current && styles.rowCurrent]}>
              <View style={styles.rowMain}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={historyRowLabel(conversation, { current, now: now() })}
                  accessibilityHint="Opens this chat"
                  accessibilityActions={[
                    { name: "activate" },
                    { name: "archive", label: archived ? "Move back to Recent" : "Archive" },
                    { name: "delete", label: "Delete" },
                  ]}
                  onAccessibilityAction={onAction}
                  disabled={busy}
                  onPress={() => props.onOpenConversation(conversation.id)}
                  onLongPress={toggle}
                  style={({ pressed }) => [styles.rowOpen, pressed && styles.pressed]}
                  testID={`history-open-${conversation.id}`}
                >
                  <View style={styles.rowHeading}>
                    <Text numberOfLines={1} style={styles.rowTitle}>
                      {title}
                    </Text>
                    <Text style={styles.rowDate}>
                      {formatHistoryDate(historyRowDate(conversation), now())}
                    </Text>
                  </View>
                  {current ? <Text style={styles.currentTag}>Open now</Text> : null}
                  <Text numberOfLines={2} style={conversation.preview ? styles.preview : styles.previewEmpty}>
                    {conversation.preview ?? "No messages yet"}
                  </Text>
                </Pressable>
                {phone ? (
                  <IconButton
                    icon={expanded ? "chevron-up" : "dots-horizontal"}
                    accessibilityLabel={`More actions for ${title}`}
                    accessibilityState={{ expanded }}
                    disabled={busy}
                    onPress={toggle}
                    style={styles.phoneMore}
                    testID={`history-more-${conversation.id}`}
                  />
                ) : <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`More actions for ${title}`}
                  accessibilityState={{ expanded }}
                  disabled={busy}
                  hitSlop={4}
                  onPress={toggle}
                  style={[styles.bevel, styles.more]}
                  testID={`history-more-${conversation.id}`}
                >
                  <Text style={styles.moreText}>{expanded ? "▴" : "⋯"}</Text>
                </Pressable>}
              </View>

              {expanded && !confirming ? (
                <View style={styles.actions}>
                  {archived ? (
                    <NativeButton
                      accessibilityLabel={`Move ${title} back to Recent`}
                      disabled={busy}
                      onPress={() => void unarchive(conversation.id, title)}
                    >
                      Move to Recent
                    </NativeButton>
                  ) : (
                    <NativeButton
                      accessibilityLabel={`Archive ${title}`}
                      disabled={busy}
                      onPress={() => void archive(conversation)}
                    >
                      Archive
                    </NativeButton>
                  )}
                  <NativeButton
                    accessibilityLabel={`Delete ${title}`}
                    disabled={busy}
                    textColor={theme.colors.error}
                    onPress={() => {
                      dispatch({ type: "request-delete", id: conversation.id });
                      say(deleteConfirmationText({ title, current, working: !!props.working }));
                    }}
                  >
                    Delete…
                  </NativeButton>
                </View>
              ) : null}

              {confirming ? (
                <View style={styles.confirm}>
                  <Text>
                    {deleteConfirmationText({ title, current, working: !!props.working })}
                  </Text>
                  {!archived ? (
                    <Text style={styles.hint}>Only want it out of the way? Archive keeps it.</Text>
                  ) : null}
                  <View style={[styles.actions, styles.confirmActions]}>
                    <NativeButton
                      accessibilityLabel="Keep this chat"
                      disabled={busy}
                      onPress={() => dispatch({ type: "dismiss" })}
                    >
                      Keep
                    </NativeButton>
                    {!archived ? (
                      <NativeButton
                        accessibilityLabel={`Archive ${title} instead`}
                        disabled={busy}
                        onPress={() => void archive(conversation)}
                      >
                        Archive instead
                      </NativeButton>
                    ) : null}
                    <NativeButton
                      accessibilityLabel={`Delete ${title} for good`}
                      disabled={busy}
                      mode="contained"
                      buttonColor={theme.colors.error}
                      textColor={theme.colors.onError}
                      onPress={() => void remove(conversation)}
                    >
                      {busy ? "Deleting…" : "Delete for good"}
                    </NativeButton>
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}
      </View>

      {props.onOpenLibrary ? (
        <NativeButton
          accessibilityLabel="Organize chats into folders in Library"
          mode="text"
          onPress={props.onOpenLibrary}
        >
          Organize folders in Library
        </NativeButton>
      ) : null}
    </ScrollView>
  );
}

const createStyles = (theme: MD3Theme, phone: boolean) =>
  StyleSheet.create({
    content: { padding: phone ? 20 : 12, gap: phone ? 16 : 10, paddingBottom: 32 },
    flex: { flex: 1 },
    titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    bevel: {
      borderWidth: 2,
      borderTopColor: theme.dark ? "#68737f" : "#ffffff",
      borderLeftColor: theme.dark ? "#68737f" : "#ffffff",
      borderRightColor: "#5c6672",
      borderBottomColor: "#5c6672",
      backgroundColor: theme.colors.surface,
    },
    tabs: { flexDirection: "row", gap: 6 },
    tab: {
      flex: 1,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 10,
    },
    tabSelected: {
      backgroundColor: theme.colors.secondaryContainer,
      borderTopColor: "#5c6672",
      borderLeftColor: "#5c6672",
      borderRightColor: theme.dark ? "#68737f" : "#ffffff",
      borderBottomColor: theme.dark ? "#68737f" : "#ffffff",
    },
    tabText: { color: theme.colors.onSurface, fontWeight: "600" },
    tabTextSelected: { color: theme.colors.onSecondaryContainer },
    search: { borderRadius: phone ? 18 : 0 },
    notice: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 8,
      padding: 10,
      borderWidth: 1,
      borderColor: theme.colors.outline,
      backgroundColor: theme.colors.secondaryContainer,
      borderRadius: phone ? 16 : 0,
    },
    empty: { opacity: 0.72, paddingVertical: 12 },
    list: { gap: 8 },
    rowCard: {
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surface,
      borderRadius: phone ? 18 : 0,
      overflow: "hidden",
    },
    rowCurrent: phone ? {
      borderColor: theme.colors.primary,
    } : { borderLeftWidth: 4, borderLeftColor: theme.colors.primary },
    rowMain: { flexDirection: "row", alignItems: "stretch" },
    rowOpen: { flex: 1, minHeight: phone ? 88 : 56, paddingHorizontal: phone ? 16 : 12, paddingVertical: phone ? 14 : 8, gap: phone ? 4 : 2 },
    pressed: { backgroundColor: theme.colors.surfaceVariant },
    rowHeading: { flexDirection: "row", alignItems: "baseline", gap: 8 },
    rowTitle: { flex: 1, fontWeight: "700", fontSize: 16, color: theme.colors.onSurface },
    rowDate: { fontSize: 12, color: theme.colors.onSurfaceVariant },
    currentTag: { fontSize: 12, fontWeight: "700", color: theme.colors.primary },
    preview: { color: theme.colors.onSurfaceVariant },
    previewEmpty: { color: theme.colors.onSurfaceVariant, fontStyle: "italic" },
    more: {
      width: 48,
      minHeight: 48,
      alignSelf: "center",
      alignItems: "center",
      justifyContent: "center",
      margin: 4,
    },
    moreText: { fontSize: 20, fontWeight: "700", color: theme.colors.onSurface },
    phoneMore: { width: 44, height: 44, margin: 8, alignSelf: "center" },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 12, paddingBottom: 10 },
    confirm: {
      gap: 8,
      paddingTop: 10,
      borderTopWidth: 1,
      borderTopColor: theme.colors.outlineVariant,
      paddingHorizontal: 12,
    },
    confirmActions: { paddingHorizontal: 0 },
    hint: { fontSize: 13, color: theme.colors.onSurfaceVariant },
  });
