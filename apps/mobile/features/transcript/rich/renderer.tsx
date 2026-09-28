import { memo, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme, type MD3Theme } from "react-native-paper";
import {
  markdownCopyPayload,
  parseMarkdown,
  type InlineNode,
} from "./markdown";

export interface RichMarkdownProps {
  markdown: string;
  testID?: string;
  accessibilityLabel?: string;
  onCopyMarkdown?: (markdown: string) => void;
}

function Inline({ nodes, style }: { nodes: InlineNode[]; style?: object }) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  return (
    <Text style={[styles.body, style]}>
      {nodes.map((node, index) =>
        node.type === "math" ? (
          <Text
            key={`m${index}`}
            accessibilityLabel={`Math expression: ${node.value}`}
            style={styles.mathInline}
          >
            {node.value}
          </Text>
        ) : (
          <Text
            key={`t${index}`}
            style={[
              node.marks?.includes("bold") && styles.bold,
              node.marks?.includes("italic") && styles.italic,
              node.marks?.includes("code") && styles.inlineCode,
            ]}
          >
            {node.value}
          </Text>
        ),
      )}
    </Text>
  );
}

function highlightedCode(
  value: string,
  styles: ReturnType<typeof createStyles>,
  colors: MD3Theme["colors"],
  language?: string,
) {
  // Token coloring is deliberately a lightweight presentation aid, never execution.
  const pattern =
    /(\/\/[^\n]*|#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b(?:const|let|var|function|return|if|else|for|while|class|import|from|export|async|await|def|print|true|false|null|None)\b|\b\d+(?:\.\d+)?\b)/g;
  const result: Array<{ value: string; color?: string }> = [];
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > offset) result.push({ value: value.slice(offset, at) });
    const token = match[0];
    const color = /^(\/\/|#)/.test(token)
      ? colors.onSurfaceVariant
      : /^["']/.test(token)
        ? colors.secondary
        : /^\d/.test(token)
          ? colors.tertiary
          : colors.primary;
    result.push({ value: token, color });
    offset = at + token.length;
  }
  if (offset < value.length) result.push({ value: value.slice(offset) });
  return (
    <Text
      accessibilityLabel={`${language ? `${language} ` : ""}code: ${value}`}
      style={styles.codeText}
    >
      {result.map((token, index) => (
        <Text key={index} style={{ color: token.color ?? colors.onSurface }}>
          {token.value}
        </Text>
      ))}
    </Text>
  );
}

export const RichMarkdown = memo(function RichMarkdown({
  markdown,
  testID,
  accessibilityLabel,
  onCopyMarkdown,
}: RichMarkdownProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  return (
    <View
      testID={testID}
      accessible={Boolean(accessibilityLabel && !onCopyMarkdown)}
      accessibilityLabel={accessibilityLabel}
    >
      {blocks.map((block, index) => {
        if (block.type === "code")
          return (
            <View key={`code${index}`} style={styles.codeBlock}>
              {block.language ? (
                <Text style={styles.language}>{block.language}</Text>
              ) : null}
              {highlightedCode(
                block.value,
                styles,
                theme.colors,
                block.language,
              )}
            </View>
          );
        if (block.type === "math")
          return (
            <View
              key={`math${index}`}
              accessible
              accessibilityLabel={`Math expression: ${block.value}`}
              style={styles.mathBlock}
            >
              <Text selectable style={styles.mathText}>
                {block.value}
              </Text>
            </View>
          );
        if (block.type === "list")
          return (
            <View key={`list${index}`} style={styles.list}>
              {block.items.map((item, itemIndex) => (
                <View key={itemIndex} style={styles.listItem}>
                  <Text style={styles.body}>
                    {block.ordered ? `${itemIndex + (block.start ?? 1)}.` : "•"}
                  </Text>
                  <Inline nodes={item} />
                </View>
              ))}
            </View>
          );
        if (block.type === "quote")
          return (
            <View key={`quote${index}`} style={styles.quote}>
              <Inline nodes={block.value} />
            </View>
          );
        return (
          <View
            key={`block${index}`}
            style={block.type === "heading" ? styles.heading : undefined}
          >
            <Inline
              nodes={block.value}
              {...(block.type === "heading"
                ? {
                    style: {
                      fontSize: Math.max(16, 26 - (block.level ?? 1) * 2),
                      fontWeight: "700",
                    },
                  }
                : {})}
            />
          </View>
        );
      })}
      {onCopyMarkdown ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy Markdown"
          onPress={() => onCopyMarkdown(markdownCopyPayload(markdown))}
          style={styles.copy}
        >
          <Text style={styles.copyLabel}>Copy</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const createStyles = (colors: MD3Theme["colors"]) =>
  StyleSheet.create({
    body: { color: colors.onSurface, fontSize: 16, lineHeight: 23 },
    bold: { fontWeight: "700" },
    italic: { fontStyle: "italic" },
    inlineCode: {
      fontFamily: "monospace",
      backgroundColor: colors.surfaceVariant,
      color: colors.onSurfaceVariant,
    },
    mathInline: { fontFamily: "serif", color: colors.tertiary },
    mathBlock: {
      padding: 10,
      borderRadius: 8,
      backgroundColor: colors.tertiaryContainer,
    },
    mathText: {
      fontFamily: "serif",
      fontSize: 16,
      color: colors.onTertiaryContainer,
    },
    codeBlock: {
      backgroundColor: colors.elevation.level2,
      borderRadius: 8,
      padding: 10,
      gap: 4,
    },
    codeText: {
      color: colors.onSurface,
      fontFamily: "monospace",
      fontSize: 13,
      lineHeight: 19,
    },
    language: {
      color: colors.onSurfaceVariant,
      fontSize: 11,
      textTransform: "uppercase",
    },
    quote: {
      borderLeftWidth: 3,
      borderLeftColor: colors.outline,
      paddingLeft: 10,
    },
    list: { gap: 4 },
    listItem: { flexDirection: "row", gap: 8 },
    heading: { marginVertical: 2 },
    copy: { alignSelf: "flex-end", paddingHorizontal: 8, paddingVertical: 4 },
    copyLabel: { color: colors.primary, fontSize: 12 },
  });
