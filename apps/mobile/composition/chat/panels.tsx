import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import {
  Button,
  Searchbar,
  SegmentedButtons,
  Text,
  useTheme,
} from "react-native-paper";
import type { CapabilityMap } from "@locallab/contracts/ports";
import { ErrorNotice } from "../../features/diagnostics/error-notice";
import { describeError } from "../../features/diagnostics/errors";
import type { ContextPolicy } from "@locallab/context";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { SQLiteConversationLibrary } from "@locallab/conversation-library";
import { LibraryScreen } from "../../features/library/screen";
import type { LibraryFeatureProps } from "../../features/library";
import { ChatSettingsScreen } from "../../features/chat-settings/screen";
import type { ChatSettingsStore } from "../../features/chat-settings";
import { SQLiteChatSettingsStore } from "./settings-store";
import {
  resolveSearchSource,
  searchLocalChat,
  searchResultSnippet,
  searchSemanticChat,
} from "./panels/search";
import type {
  ChatSearchResult,
  ChatSearchSource,
  ChatSemanticQueryPort,
} from "./panels/search";

export type ChatPanel = "library" | "settings" | "search";
export type { ChatSearchSource, ChatSemanticQueryPort } from "./panels/search";

export interface ChatPanelsProps {
  panel: ChatPanel;
  /** Already initialized shared database. The caller owns and closes it. */
  db: SQLiteDatabasePort;
  conversationId: string;
  modelId?: string;
  personaId?: string;
  personaEnabled?: boolean;
  capabilities: CapabilityMap;
  serverContextWindow?: number;
  serverMaxOutputTokens?: number;
  serverContextStatus?: "checking" | "available" | "unavailable";
  createId: () => string;
  library?: LibraryFeatureProps["library"];
  settingsStore?: ChatSettingsStore;
  onOpenConversation: (
    conversationId: string,
    source?: ChatSearchSource,
  ) => Promise<void> | void;
  onClose?: () => void;
  hideBackButton?: boolean;
  onSelectCover?: LibraryFeatureProps["onSelectCover"];
  onContextReload?: () => Promise<void> | void;
  onCompact?: (policy: ContextPolicy) => Promise<void> | void;
  onRetry?: () => Promise<void> | void;
  retryUnavailableReason?: string;
  summaryUnavailableReason?: string;
  compactActionLabel?: string;
  onPendingSettingsWrites?: (completion: Promise<void>) => void;
  contextProgress?: string;
  contextPolicy?: ContextPolicy;
  /** Notify the host after a durable save so it can apply new settings. */
  onSettingsChanged?: (kind: "parameters" | "appearance") => void;
  semanticSearch?: ChatSemanticQueryPort;
  /** Change this after transcript edits to discard stale displayed search hits. */
  refreshKey?: string | number;
}

/** Library, settings and search use the same connection as the chat engine. */
export function ChatPanels(props: ChatPanelsProps) {
  const theme = useTheme();
  const [error, setError] = useState("");
  const library = useMemo(
    () => props.library ?? new SQLiteConversationLibrary(props.db),
    [props.library, props.db],
  );
  const settingsStore = useMemo<ChatSettingsStore>(() => {
    const store =
      props.settingsStore ??
      new SQLiteChatSettingsStore(props.db, props.conversationId);
    return {
      loadPresets: (identity) => store.loadPresets(identity),
      loadAppearance: (conversationId) => store.loadAppearance(conversationId),
      async savePreset(scope, values, identity) {
        await store.savePreset(scope, values, identity);
        props.onSettingsChanged?.("parameters");
      },
      async saveAppearance(conversationId, appearance) {
        await store.saveAppearance(conversationId, appearance);
        props.onSettingsChanged?.("appearance");
      },
    };
  }, [
    props.settingsStore,
    props.db,
    props.conversationId,
    props.onSettingsChanged,
  ]);
  const settingsCapabilities = useMemo<CapabilityMap>(
    () => ({
      ...props.capabilities,
      // Binding selection belongs to the host's actual provider/model registry.
      "chat.provider": "no",
      "chat.model": "no",
    }),
    [props.capabilities],
  );
  useEffect(() => setError(""), [props.panel, props.conversationId]);

  const openConversation = async (
    conversationId: string,
    source?: ChatSearchSource,
  ) => {
    setError("");
    try {
      await props.onOpenConversation(conversationId, source);
    } catch (cause) {
      setError(
        describeError(cause, {
          operation: "Open saved conversation",
          recovery:
            "Choose the chat again. Check available storage space if this keeps failing.",
        }),
      );
    }
  };

  return (
    <View style={[styles.host, { backgroundColor: theme.colors.background }]}>
      {props.onClose && !props.hideBackButton ? (
        <View style={styles.topBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to conversation"
            onPress={props.onClose}
            style={styles.button}
          >
            <Text>Back to chat</Text>
          </Pressable>
        </View>
      ) : null}
      {error ? <ErrorNotice message={error} /> : null}
      {props.panel === "library" ? (
        <LibraryScreen
          key={String(props.refreshKey ?? "library")}
          library={library}
          createId={props.createId}
          onOpenConversation={openConversation}
          {...(props.onSelectCover
            ? { onSelectCover: props.onSelectCover }
            : {})}
        />
      ) : props.panel === "settings" ? (
        <ChatSettingsScreen
          key={`${props.conversationId}:${props.modelId ?? ""}:${props.personaId ?? ""}`}
          conversationId={props.conversationId}
          store={settingsStore}
          capabilities={settingsCapabilities}
          {...(props.serverContextWindow
            ? { serverContextWindow: props.serverContextWindow }
            : {})}
          {...(props.serverMaxOutputTokens
            ? { serverMaxOutputTokens: props.serverMaxOutputTokens }
            : {})}
          {...(props.serverContextStatus
            ? { serverContextStatus: props.serverContextStatus }
            : {})}
          personaEnabled={!!props.personaId && (props.personaEnabled ?? true)}
          {...(props.modelId ? { modelId: props.modelId } : {})}
          {...(props.personaId ? { personaId: props.personaId } : {})}
          {...(props.onContextReload
            ? { onContextReload: props.onContextReload }
            : {})}
          {...(props.onCompact ? { onCompact: props.onCompact } : {})}
          {...(props.onRetry ? { onRetry: props.onRetry } : {})}
          {...(props.retryUnavailableReason
            ? { retryUnavailableReason: props.retryUnavailableReason }
            : {})}
          {...(props.summaryUnavailableReason
            ? { summaryUnavailableReason: props.summaryUnavailableReason }
            : {})}
          {...(props.compactActionLabel
            ? { compactActionLabel: props.compactActionLabel }
            : {})}
          {...(props.onPendingSettingsWrites
            ? { onPendingWrites: props.onPendingSettingsWrites }
            : {})}
          {...(props.contextProgress
            ? { contextProgress: props.contextProgress }
            : {})}
          {...(props.contextPolicy
            ? { contextPolicy: props.contextPolicy }
            : {})}
        />
      ) : (
        <ChatSearchPanel
          db={props.db}
          conversationId={props.conversationId}
          onOpenConversation={openConversation}
          {...(props.semanticSearch
            ? { semanticSearch: props.semanticSearch }
            : {})}
          {...(props.refreshKey !== undefined
            ? { refreshKey: props.refreshKey }
            : {})}
        />
      )}
    </View>
  );
}

export interface ChatSearchPanelProps {
  db: SQLiteDatabasePort;
  conversationId: string;
  onOpenConversation: (
    conversationId: string,
    source?: ChatSearchSource,
  ) => Promise<void> | void;
  semanticSearch?: ChatSemanticQueryPort;
  refreshKey?: string | number;
}

export function ChatSearchPanel(props: ChatSearchPanelProps) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"local" | "semantic">("local");
  const [currentChatOnly, setCurrentChatOnly] = useState(false);
  const [results, setResults] = useState<ChatSearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let canceled = false;
    setResults([]);
    setError("");
    if (!query.trim()) {
      setBusy(false);
      return () => controller.abort();
    }
    setBusy(true);
    const timer = setTimeout(() => {
      const options = {
        ...(currentChatOnly ? { conversationId: props.conversationId } : {}),
        signal: controller.signal,
      };
      const run =
        mode === "semantic"
          ? props.semanticSearch
            ? searchSemanticChat(props.db, props.semanticSearch, query, options)
            : Promise.reject(new Error("Semantic search unavailable"))
          : searchLocalChat(props.db, query, options);
      void run
        .then((found) => {
          if (!canceled) setResults(found);
        })
        .catch((cause) => {
          if (!canceled)
            setError(
              describeError(cause, {
                operation: "Search saved chats",
                recovery:
                  "Tap Retry search. For semantic search, check that the embedding model is installed.",
              }),
            );
        })
        .finally(() => {
          if (!canceled) setBusy(false);
        });
    }, 250);
    return () => {
      canceled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    props.db,
    props.conversationId,
    props.semanticSearch,
    props.refreshKey,
    query,
    mode,
    currentChatOnly,
    retryKey,
  ]);

  useEffect(() => {
    if (!props.semanticSearch && mode === "semantic") setMode("local");
  }, [props.semanticSearch, mode]);

  const openResult = async (result: ChatSearchResult) => {
    setOpening(true);
    setError("");
    try {
      if (result.source) {
        const current = await resolveSearchSource(
          props.db,
          result.source,
          result.text,
        );
        if (!current) {
          if (live.current) {
            setError(
              "This result changed. Search again to find its current text.",
            );
            setResults((previous) =>
              previous.filter((item) => item !== result),
            );
          }
          return;
        }
      } else {
        const exists = await props.db.getFirstAsync<{ id: string }>(
          "SELECT id FROM conversations WHERE id=?",
          result.conversationId,
        );
        if (!exists) {
          if (live.current)
            setError("This conversation is no longer available.");
          return;
        }
      }
      await props.onOpenConversation(result.conversationId, result.source);
    } catch (cause) {
      if (live.current)
        setError(
          describeError(cause, {
            operation: "Open search result",
            recovery: "Retry opening the result, or find the chat in Library.",
          }),
        );
    } finally {
      if (live.current) setOpening(false);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={styles.search}
      keyboardShouldPersistTaps="handled"
    >
      <Text accessibilityRole="header" variant="headlineSmall">
        Search conversations
      </Text>
      <Searchbar
        role="searchbox"
        accessibilityLabel="Search saved conversations"
        placeholder="Find titles and message text"
        value={query}
        maxLength={500}
        onChangeText={setQuery}
      />
      {props.semanticSearch ? (
        <View style={styles.row}>
          <SearchChoice
            label="Text"
            selected={mode === "local"}
            onPress={() => setMode("local")}
          />
          <SearchChoice
            label="Semantic"
            selected={mode === "semantic"}
            onPress={() => {
              setCurrentChatOnly(false);
              setMode("semantic");
            }}
          />
        </View>
      ) : null}
      <SegmentedButtons
        value={currentChatOnly ? "current" : "all"}
        onValueChange={(value) => setCurrentChatOnly(value === "current")}
        buttons={[
          { value: "all", label: "All chats", style: { minHeight: 44 } },
          {
            value: "current",
            label: "This chat",
            disabled: mode === "semantic",
            style: { minHeight: 44 },
          },
        ]}
      />
      {mode === "semantic" ? (
        <Text variant="bodySmall">Semantic search covers all saved chats.</Text>
      ) : null}
      {busy ? (
        <View style={styles.row}>
          <ActivityIndicator />
          <Text accessibilityLiveRegion="polite">Searching saved text…</Text>
        </View>
      ) : null}
      {error ? (
        <View style={{ gap: 12 }}>
          <ErrorNotice message={error} />
          <Pressable
            accessibilityRole="button"
            onPress={() => setRetryKey((key) => key + 1)}
            style={styles.button}
          >
            <Text>Retry search</Text>
          </Pressable>
        </View>
      ) : null}
      {!busy && !error ? (
        <Text accessibilityLiveRegion="polite" variant="bodySmall">
          {!query.trim()
            ? "Enter a word or phrase to search your saved conversations."
            : results.length
              ? `${results.length} results${results.length === 30 ? " · first 30 shown" : ""}`
              : "No saved titles or messages match this search."}
        </Text>
      ) : null}
      {results.map((result, index) => (
        <Pressable
          key={`${result.conversationId}:${result.source?.messageId ?? "title"}:${result.source?.variantId ?? ""}:${index}`}
          accessibilityRole="button"
          accessibilityLabel={`Open ${result.title}${result.role === "title" ? "" : `, ${result.role} message`}`}
          disabled={opening}
          onPress={() => void openResult(result)}
          style={[styles.result, opening && styles.disabled]}
        >
          <Text variant="titleMedium">{result.title}</Text>
          <Text variant="labelSmall">
            {result.role === "title"
              ? "Title match"
              : `${result.role === "user" ? "You" : "Assistant"} · message ${(result.sequence ?? 0) + 1}`}
            {result.mode !== "local"
              ? ` · ${result.mode === "fts" ? "Indexed text" : "Semantic"}`
              : ""}
          </Text>
          <Text numberOfLines={4}>
            {searchResultSnippet(result.text, query)}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function SearchChoice(props: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      mode={props.selected ? "contained-tonal" : "outlined"}
      accessibilityState={{
        selected: props.selected,
        disabled: props.disabled ?? false,
      }}
      disabled={props.disabled ?? false}
      onPress={props.onPress}
      contentStyle={{ minHeight: 44 }}
    >
      {props.label}
    </Button>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  topBar: { paddingHorizontal: 16, paddingTop: 8, alignItems: "flex-start" },
  search: { padding: 16, gap: 12, paddingBottom: 32 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  button: {
    borderWidth: 1,
    borderColor: "#aaa79f",
    borderRadius: 16,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  selected: { backgroundColor: "#20201e", borderColor: "#20201e" },
  selectedText: { color: "white", fontWeight: "600" },
  disabled: { opacity: 0.45 },
  result: {
    borderWidth: 1,
    borderColor: "#e3e2dc",
    borderRadius: 12,
    backgroundColor: "white",
    padding: 14,
    gap: 7,
  },
  error: {
    color: "#8b302b",
    paddingHorizontal: 16,
    paddingVertical: 6,
    flexShrink: 1,
  },
});
