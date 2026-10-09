import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ErrorNotice } from "../../diagnostics/error-notice";
import { describeError } from "../../diagnostics/errors";
import {
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import {
  Button,
  IconButton,
  useTheme,
  type MD3Theme,
} from "react-native-paper";
import {
  mergeTranscriptRows,
  assistantStatusLabel,
  type AssistantTranscriptMessage,
  type TranscriptRow,
  type UserTranscriptMessage,
} from "./index";
import { RichMarkdown } from "../rich/renderer";
import { markdownCopyPayload } from "../rich/markdown";
import {
  NativeActivity,
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";

export interface TranscriptProps {
  users: readonly UserTranscriptMessage[];
  assistants: readonly AssistantTranscriptMessage[];
  onStop?: () => void;
  /** Receives the exact source Markdown so the native clipboard adapter preserves formatting. */
  onCopyMarkdown?: (markdown: string, messageId: string) => void;
  onReadAloud?: (text: string, messageId: string) => void;
  /** A provenance link opens and highlights the exact original message. */
  focusMessageId?: string;
  /** The screen can provide a welcome state without changing scroll geometry. */
  emptyContent?: ReactNode;
  /** This run already has a complete error displayed by the chat screen. */
  displayedErrorRunId?: string;
}

function TranscriptRowView({
  item,
  onCopyMarkdown,
  onReadAloud,
  highlighted,
  errorDisplayed = false,
}: {
  item: TranscriptRow;
  onCopyMarkdown?: TranscriptProps["onCopyMarkdown"];
  onReadAloud?: TranscriptProps["onReadAloud"];
  highlighted?: boolean;
  errorDisplayed?: boolean;
}) {
  const theme = useTheme();
  const { phone } = useWorkspaceLayout();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  const [expandedReasoning, setExpandedReasoning] = useState<
    Record<number, boolean>
  >({});
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  if (item.role === "user") {
    const bubble = (
      <View
        testID={highlighted ? "source-message" : undefined}
        style={[
          styles.bubble,
          styles.userBubble,
          phone && {
            alignSelf: "stretch",
            maxWidth: "100%",
            borderRadius: 20,
            borderWidth: 0,
            padding: 14,
          },
          highlighted ? styles.sourceBubble : undefined,
        ]}
      >
        {highlighted ? (
          <Text accessibilityRole="header" style={styles.body}>
            Source message
          </Text>
        ) : null}
        <RichMarkdown
          markdown={item.text}
          accessibilityLabel={`Your message: ${item.text}`}
          phoneLayout={phone}
          showCopyAction={!phone}
          {...(onCopyMarkdown
            ? {
                onCopyMarkdown: (markdown: string) =>
                  onCopyMarkdown(markdown, item.id),
              }
            : {})}
        />
      </View>
    );
    return phone ? (
      <View
        style={[
          styles.phoneUserMessage,
          onCopyMarkdown ? styles.phoneUserMessageWithActions : undefined,
        ]}
      >
        {bubble}
        {onCopyMarkdown ? (
          <IconButton
            icon="content-copy"
            size={18}
            iconColor={theme.colors.onSurfaceVariant}
            accessibilityLabel="Copy Markdown"
            style={styles.phoneUserCopy}
            onPress={() =>
              onCopyMarkdown(markdownCopyPayload(item.text), item.id)
            }
          />
        ) : null}
      </View>
    ) : (
      bubble
    );
  }

  const responseText = item.parts
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
  const hasResponseText = responseText.trim().length > 0;
  const status = assistantStatusLabel(item);
  const activity = item.parts.filter(
    (part) => part.type === "tool-call" || part.type === "tool-result",
  );
  const sources = item.parts.filter((part) => part.type === "source");
  const hasFileActivity = activity.some(
    (part) => part.type === "tool-call" && part.name.startsWith("workspace_"),
  );
  const activityErrors = activity.flatMap((part) =>
    part.type === "tool-result" &&
    typeof part.output === "object" &&
    part.output &&
    "error" in part.output
      ? [
          typeof part.output.error === "string"
            ? part.output.error
            : describeError(part.output.error, {
                operation: "Use chat tool",
                recovery: "Review the details and retry your request.",
              }),
        ]
      : [],
  );
  return (
    <View
      testID={highlighted ? "source-message" : undefined}
      style={[
        styles.bubble,
        styles.assistantBubble,
        phone && {
          maxWidth: "100%",
          alignSelf: "stretch",
          borderWidth: 0,
          padding: 0,
          backgroundColor: "transparent",
        },
        highlighted ? styles.sourceBubble : undefined,
      ]}
    >
      {highlighted ? (
        <Text accessibilityRole="header" style={styles.body}>
          Source message
        </Text>
      ) : null}
      {activity.length ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            hasFileActivity
              ? activityExpanded
                ? "Hide file details"
                : "Show file details"
              : activityExpanded
                ? "Hide research details"
                : "Show research details"
          }
          accessibilityState={{ expanded: activityExpanded }}
          onPress={() => setActivityExpanded(!activityExpanded)}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text style={styles.detail}>
            {activityExpanded ? "−" : "+"}{" "}
            {hasFileActivity ? "File activity" : "Research activity"}
            {item.status === "running" ? " · working" : ""}
          </Text>
        </Pressable>
      ) : null}
      {!activityExpanded && !errorDisplayed && !item.error
        ? activityErrors.map((error, index) => (
            <ErrorNotice key={`error-${index}`} message={error} />
          ))
        : null}
      {item.parts
        .filter(
          (part) =>
            part.type !== "source" &&
            (activityExpanded ||
              (part.type !== "tool-call" && part.type !== "tool-result")),
        )
        .map((part, index) => {
          switch (part.type) {
            case "text":
              return (
                <RichMarkdown
                  key={`text-${index}`}
                  testID="assistant-response-text"
                  markdown={part.text}
                  accessibilityLabel={part.text}
                  phoneLayout={phone}
                  showCopyAction={!phone}
                  {...(onCopyMarkdown
                    ? {
                        onCopyMarkdown: (markdown: string) =>
                          onCopyMarkdown(markdown, item.id),
                      }
                    : {})}
                />
              );
            case "reasoning":
              return (
                <View key={`reasoning-${index}`} style={styles.reasoning}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      expandedReasoning[index]
                        ? "Hide model reasoning"
                        : "Show model reasoning"
                    }
                    accessibilityState={{
                      expanded: expandedReasoning[index] === true,
                    }}
                    onPress={() =>
                      setExpandedReasoning((current) => ({
                        ...current,
                        [index]: !current[index],
                      }))
                    }
                    style={{ minHeight: 44, justifyContent: "center" }}
                  >
                    <Text style={styles.reasoningLabel}>
                      {expandedReasoning[index] ? "▾" : "▸"} Model reasoning
                    </Text>
                  </Pressable>
                  {expandedReasoning[index] ? (
                    <RichMarkdown
                      markdown={part.text}
                      accessibilityLabel={`Reasoning: ${part.text}`}
                      phoneLayout={phone}
                      showCopyAction={!phone}
                      {...(onCopyMarkdown
                        ? {
                            onCopyMarkdown: (markdown: string) =>
                              onCopyMarkdown(markdown, item.id),
                          }
                        : {})}
                    />
                  ) : null}
                </View>
              );
            case "tool-call":
              return (
                <Text key={`tool-${part.invocationId}`} style={styles.detail}>
                  {part.name === "web_search"
                    ? "Searching the web"
                    : part.name === "web_fetch"
                      ? "Reading a web page"
                      : part.name === "workspace_write_file"
                        ? "Saving a chat file"
                        : part.name === "workspace_read_file"
                          ? "Reading a chat file"
                          : part.name === "workspace_list_files"
                            ? "Listing chat files"
                            : `Using ${part.name}`}
                </Text>
              );
            case "tool-result":
              return typeof part.output === "object" &&
                part.output &&
                "error" in part.output ? (
                <ErrorNotice
                  key={`result-${part.invocationId}`}
                  message={
                    typeof part.output.error === "string"
                      ? part.output.error
                      : describeError(part.output.error, {
                          operation: "Use chat tool",
                          recovery:
                            "Review the details and retry your request.",
                        })
                  }
                />
              ) : (
                <Text key={`result-${part.invocationId}`} style={styles.detail}>
                  {typeof part.output === "object" &&
                  part.output &&
                  "path" in part.output &&
                  typeof part.output.path === "string"
                    ? `File: ${part.output.path} · Open Files to preview or export`
                    : "Tool finished"}
                </Text>
              );
            case "source":
              return /^https?:\/\//i.test(part.url) ? (
                <Pressable
                  key={`source-${index}`}
                  accessibilityRole="link"
                  accessibilityLabel={`Open source: ${part.title || part.url}`}
                  onPress={() => {
                    void Linking.openURL(part.url).catch(() => {});
                  }}
                  style={{ minHeight: 44, justifyContent: "center" }}
                >
                  <Text
                    style={{ color: theme.colors.primary }}
                    numberOfLines={2}
                  >
                    {part.title || part.url}
                  </Text>
                  <Text style={styles.detail} numberOfLines={1}>
                    {part.url}
                  </Text>
                </Pressable>
              ) : null;
            case "media":
              return (
                <Text key={`media-${part.mediaId}`} style={styles.detail}>
                  {part.mediaType}
                </Text>
              );
          }
        })}
      {sources.length ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={sourcesExpanded ? "Hide sources" : "Show sources"}
          accessibilityState={{ expanded: sourcesExpanded }}
          onPress={() => setSourcesExpanded(!sourcesExpanded)}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text style={{ color: theme.colors.primary }}>
            {sourcesExpanded ? "−" : "+"} Sources ({sources.length})
          </Text>
        </Pressable>
      ) : null}
      {sourcesExpanded
        ? sources.map((part, index) =>
            /^https?:\/\//i.test(part.url) ? (
              <Pressable
                key={`source-${index}`}
                accessibilityRole="link"
                accessibilityLabel={`Open source: ${part.title || part.url}`}
                onPress={() => {
                  void Linking.openURL(part.url).catch(() => {});
                }}
                style={{ minHeight: 44, justifyContent: "center" }}
              >
                <Text style={{ color: theme.colors.primary }} numberOfLines={2}>
                  {part.title || part.url}
                </Text>
                <Text style={styles.detail} numberOfLines={1}>
                  {part.url}
                </Text>
              </Pressable>
            ) : null,
          )
        : null}
      {item.status === "failed" && item.error && !errorDisplayed ? (
        <ErrorNotice message={item.error.message} />
      ) : status ? (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole="text"
          style={styles.status}
        >
          {errorDisplayed && item.status === "failed"
            ? "Response failed. Your draft is preserved."
            : status}
        </Text>
      ) : null}
      {phone &&
      hasResponseText &&
      (onCopyMarkdown || (onReadAloud && item.status !== "running")) ? (
        <View style={styles.phoneMessageActions}>
          {onCopyMarkdown ? (
            <Button
              icon="content-copy"
              mode="text"
              compact
              textColor={theme.colors.onSurfaceVariant}
              contentStyle={{ minHeight: 44 }}
              accessibilityLabel="Copy Markdown"
              onPress={() =>
                onCopyMarkdown(markdownCopyPayload(responseText), item.id)
              }
            >
              Copy
            </Button>
          ) : null}
          {onReadAloud && item.status !== "running" ? (
            <Button
              icon="volume-high"
              mode="text"
              compact
              textColor={theme.colors.onSurfaceVariant}
              contentStyle={{ minHeight: 44 }}
              accessibilityLabel="Read response aloud"
              onPress={() => onReadAloud(responseText, item.id)}
            >
              Read aloud
            </Button>
          ) : null}
        </View>
      ) : null}
      {!phone && onReadAloud && item.status !== "running" && hasResponseText ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Read response aloud"
          onPress={() => onReadAloud(responseText, item.id)}
        >
          <Text style={{ color: theme.colors.primary }}>Read aloud</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Transcript({
  users,
  assistants,
  onStop,
  onCopyMarkdown,
  onReadAloud,
  focusMessageId,
  emptyContent,
  displayedErrorRunId,
}: TranscriptProps) {
  const theme = useTheme();
  const { phone } = useWorkspaceLayout();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  const list = useRef<FlatList<TranscriptRow>>(null);
  const followLatest = useRef(true);
  const geometry = useRef({ height: 0, viewport: 0, offset: 0 });
  const followFrame = useRef<number | undefined>(undefined);
  const pendingOffset = useRef<number | undefined>(undefined);
  const [showLatest, setShowLatest] = useState(false);
  const rows = mergeTranscriptRows(users, assistants);
  const focusedIndex = rows.findIndex((row) => row.id === focusMessageId);
  const focusAttempts = useRef(0);
  const focusRetry = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const updateLatest = useCallback(() => {
    const { height, viewport, offset } = geometry.current;
    setShowLatest(viewport > 0 && height - viewport - offset > 4);
  }, []);
  const cancelFollow = useCallback(() => {
    if (followFrame.current !== undefined)
      cancelAnimationFrame(followFrame.current);
    followFrame.current = undefined;
    pendingOffset.current = undefined;
  }, []);
  const scheduleFollow = useCallback(
    (animated = false) => {
      updateLatest();
      if (!followLatest.current || geometry.current.viewport <= 0) return;
      // Content measurement can precede FlatList's cell/layout bookkeeping.
      // Use its measured extent on the next frame instead of an estimated final cell.
      pendingOffset.current = Math.max(
        0,
        geometry.current.height - geometry.current.viewport,
      );
      if (followFrame.current !== undefined)
        cancelAnimationFrame(followFrame.current);
      followFrame.current = requestAnimationFrame(() => {
        followFrame.current = undefined;
        if (!followLatest.current) return;
        const offset = Math.max(
          0,
          geometry.current.height - geometry.current.viewport,
        );
        pendingOffset.current = offset;
        list.current?.scrollToOffset({ offset, animated });
        // Keep Latest available until an actual scroll confirms that it reached the end.
        updateLatest();
      });
    },
    [updateLatest],
  );
  useEffect(() => () => cancelFollow(), [cancelFollow]);
  useEffect(() => {
    focusAttempts.current = 0;
    if (focusMessageId) {
      if (focusedIndex >= 0) {
        followLatest.current = false;
        cancelFollow();
        list.current?.scrollToIndex({
          index: focusedIndex,
          animated: false,
          viewPosition: 0.5,
        });
      }
    } else {
      followLatest.current = true;
      scheduleFollow();
    }
    return () => clearTimeout(focusRetry.current);
  }, [focusMessageId, focusedIndex, cancelFollow, scheduleFollow]);
  const streaming = assistants.some((message) => message.status === "running");

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } =
        event.nativeEvent;
      const previousOffset = geometry.current.offset;
      const expectedOffset = pendingOffset.current;
      geometry.current = {
        height: contentSize.height,
        viewport: layoutMeasurement.height,
        offset: contentOffset.y,
      };
      const remaining =
        contentSize.height - layoutMeasurement.height - contentOffset.y;
      // A layout clamp or our requested movement is not a user leaving the end.
      if (
        contentOffset.y < previousOffset - 1 &&
        (expectedOffset === undefined ||
          Math.abs(contentOffset.y - expectedOffset) > 2)
      ) {
        followLatest.current = false;
        cancelFollow();
      } else if (remaining <= 4) {
        if (!focusMessageId || followLatest.current)
          followLatest.current = true;
        pendingOffset.current = undefined;
      }
      updateLatest();
    },
    [cancelFollow, focusMessageId, updateLatest],
  );

  const scrollLatest = useCallback(() => {
    followLatest.current = true;
    scheduleFollow(true);
  }, [scheduleFollow]);

  return (
    <View style={styles.container}>
      {streaming && !phone ? (
        <View style={styles.liveBar}>
          <NativeActivity label="Generating response" />
          {onStop ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop response"
              onPress={onStop}
              style={styles.stopButton}
            >
              <Text style={styles.stopText}>Stop</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <FlatList
        ref={list}
        testID="chat-transcript-scroll"
        style={styles.list}
        data={rows}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TranscriptRowView
            item={item}
            errorDisplayed={
              item.role === "assistant" && item.runId === displayedErrorRunId
            }
            onCopyMarkdown={onCopyMarkdown}
            onReadAloud={onReadAloud}
            highlighted={item.id === focusMessageId}
          />
        )}
        onScrollToIndexFailed={(info) => {
          if (!focusMessageId || focusAttempts.current++ >= 2) return;
          list.current?.scrollToOffset({
            offset: info.averageItemLength * info.index,
            animated: false,
          });
          focusRetry.current = setTimeout(
            () =>
              list.current?.scrollToIndex({
                index: info.index,
                animated: false,
                viewPosition: 0.5,
              }),
            100,
          );
        }}
        onScroll={onScroll}
        onScrollBeginDrag={() => {
          followLatest.current = false;
          cancelFollow();
        }}
        onLayout={(event) => {
          geometry.current.viewport = event.nativeEvent.layout.height;
          scheduleFollow();
        }}
        onContentSizeChange={(_width, height) => {
          geometry.current.height = height;
          scheduleFollow();
        }}
        scrollEventThrottle={16}
        contentContainerStyle={[
          styles.listContent,
          phone && { paddingHorizontal: 16, gap: 20 },
        ]}
        initialNumToRender={12}
        windowSize={7}
        ListEmptyComponent={
          <>
            {emptyContent ?? (
              <Text style={styles.empty}>
                Your conversation will appear here.
              </Text>
            )}
          </>
        }
      />
      {showLatest ? (
        phone ? (
          <IconButton
            icon="arrow-down"
            size={22}
            mode="outlined"
            iconColor={theme.colors.onSurfaceVariant}
            accessibilityLabel="Scroll to latest message"
            onPress={scrollLatest}
            style={[
              styles.phoneLatestButton,
              focusMessageId ? styles.sourceLatestButton : undefined,
            ]}
          />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Scroll to latest message"
            onPress={scrollLatest}
            style={[
              styles.latestButton,
              focusMessageId ? styles.sourceLatestButton : undefined,
            ]}
          >
            <Text style={styles.latestText}>Latest message ↓</Text>
          </Pressable>
        )
      ) : null}
    </View>
  );
}

const createStyles = (colors: MD3Theme["colors"]) =>
  StyleSheet.create({
    container: { flex: 1, minHeight: 0 },
    list: { flex: 1, minHeight: 0 },
    listContent: { flexGrow: 1, gap: 12, padding: 16 },
    bubble: {
      maxWidth: "92%",
      borderRadius: 0,
      padding: 14,
      gap: 8,
      borderWidth: 1,
      borderColor: colors.outlineVariant,
    },
    userBubble: {
      alignSelf: "flex-end",
      backgroundColor: colors.primaryContainer,
    },
    phoneUserMessage: { alignSelf: "flex-end", maxWidth: "92%", gap: 2 },
    // The copy action already supplies separation before the next reply.
    phoneUserMessageWithActions: { marginBottom: -12 },
    phoneUserCopy: {
      alignSelf: "flex-end",
      width: 44,
      height: 44,
      margin: 0,
    },
    phoneMessageActions: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 4,
    },
    sourceBubble: { borderWidth: 2, borderColor: colors.primary },
    assistantBubble: {
      alignSelf: "flex-start",
      backgroundColor: colors.elevation.level1,
    },
    body: { color: colors.onSurface, fontSize: 16, lineHeight: 23 },
    reasoning: {
      borderLeftWidth: 2,
      borderLeftColor: colors.outline,
      paddingLeft: 8,
    },
    reasoningLabel: {
      color: colors.onSurfaceVariant,
      fontSize: 11,
      textTransform: "uppercase",
    },
    detail: { color: colors.onSurfaceVariant, fontSize: 14 },
    status: { color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 },
    liveBar: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
    },
    liveText: { color: colors.onSurfaceVariant, fontSize: 14 },
    stopButton: { paddingHorizontal: 12, paddingVertical: 7 },
    stopText: { color: colors.error, fontWeight: "600" },
    latestButton: {
      position: "absolute",
      alignSelf: "center",
      bottom: 16,
      borderRadius: 18,
      paddingHorizontal: 14,
      paddingVertical: 9,
      backgroundColor: colors.primary,
    },
    latestText: { color: colors.onPrimary, fontSize: 14 },
    phoneLatestButton: {
      position: "absolute",
      alignSelf: "center",
      bottom: 12,
      width: 44,
      height: 44,
      margin: 0,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: colors.outlineVariant,
      backgroundColor: colors.surface,
    },
    sourceLatestButton: { position: "relative", bottom: 0, marginVertical: 8 },
    empty: {
      alignSelf: "center",
      color: colors.onSurfaceVariant,
      backgroundColor: colors.surface,
      padding: 12,
      borderRadius: 8,
      marginTop: 32,
    },
  });
