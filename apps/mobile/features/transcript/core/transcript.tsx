import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useTheme, type MD3Theme } from "react-native-paper";
import {
  mergeTranscriptRows,
  assistantStatusLabel,
  type AssistantTranscriptMessage,
  type TranscriptRow,
  type UserTranscriptMessage,
} from "./index";
import { RichMarkdown } from "../rich/renderer";
import { NativeActivity } from "@locallab/ui-native-primitives";

export interface TranscriptProps {
  users: readonly UserTranscriptMessage[];
  assistants: readonly AssistantTranscriptMessage[];
  onStop?: () => void;
  /** Receives the exact source Markdown so the native clipboard adapter preserves formatting. */
  onCopyMarkdown?: (markdown: string, messageId: string) => void;
  onReadAloud?: (text: string, messageId: string) => void;
  /** A provenance link opens and highlights the exact original message. */
  focusMessageId?: string;
}

function TranscriptRowView({
  item,
  onCopyMarkdown,
  onReadAloud,
  highlighted,
}: {
  item: TranscriptRow;
  onCopyMarkdown?: TranscriptProps["onCopyMarkdown"];
  onReadAloud?: TranscriptProps["onReadAloud"];
  highlighted?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  const [expandedReasoning, setExpandedReasoning] = useState<
    Record<number, boolean>
  >({});
  if (item.role === "user") {
    return (
      <View
        testID={highlighted ? "source-message" : undefined}
        style={[
          styles.bubble,
          styles.userBubble,
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
          {...(onCopyMarkdown
            ? {
                onCopyMarkdown: (markdown: string) =>
                  onCopyMarkdown(markdown, item.id),
              }
            : {})}
        />
      </View>
    );
  }

  const status = assistantStatusLabel(item);
  return (
    <View
      testID={highlighted ? "source-message" : undefined}
      style={[
        styles.bubble,
        styles.assistantBubble,
        highlighted ? styles.sourceBubble : undefined,
      ]}
    >
      {highlighted ? (
        <Text accessibilityRole="header" style={styles.body}>
          Source message
        </Text>
      ) : null}
      {item.parts.map((part, index) => {
        switch (part.type) {
          case "text":
            return (
              <RichMarkdown
                key={`text-${index}`}
                testID="assistant-response-text"
                markdown={part.text}
                accessibilityLabel={part.text}
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
                Using {part.name}
              </Text>
            );
          case "tool-result":
            return (
              <Text key={`result-${part.invocationId}`} style={styles.detail}>
                {`Tool ${part.invocationId} finished`}
              </Text>
            );
          case "source":
            return null;
          case "media":
            return (
              <Text key={`media-${part.mediaId}`} style={styles.detail}>
                {part.mediaType}
              </Text>
            );
        }
      })}
      {status ? (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole="text"
          style={styles.status}
        >
          {status}
        </Text>
      ) : null}
      {onReadAloud &&
      item.status !== "running" &&
      item.parts.some((part) => part.type === "text" && part.text.trim()) ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Read response aloud"
          onPress={() =>
            onReadAloud(
              item.parts
                .filter((part) => part.type === "text")
                .map((part) => (part.type === "text" ? part.text : ""))
                .join("\n"),
              item.id,
            )
          }
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
}: TranscriptProps) {
  const theme = useTheme();
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
      {streaming ? (
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
        contentContainerStyle={styles.listContent}
        initialNumToRender={12}
        windowSize={7}
        ListEmptyComponent={
          <Text style={styles.empty}>Your conversation will appear here.</Text>
        }
      />
      {showLatest ? (
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
