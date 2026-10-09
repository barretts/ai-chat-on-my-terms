import { memo, useMemo } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
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
  /** Phone messages use more generous reading typography. */
  phoneLayout?: boolean;
  /** A surrounding message action row can own the copy control. */
  showCopyAction?: boolean;
}

function Inline({
  nodes,
  style,
  phoneLayout = false,
}: {
  nodes: InlineNode[];
  style?: object;
  phoneLayout?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(
    () =>
      createStyles(theme.colors, phoneLayout, theme.fonts.bodyLarge.fontFamily),
    [theme.colors, phoneLayout, theme.fonts.bodyLarge.fontFamily],
  );
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
  phoneLayout = false,
  showCopyAction = true,
}: RichMarkdownProps) {
  const theme = useTheme();
  const styles = useMemo(
    () =>
      createStyles(theme.colors, phoneLayout, theme.fonts.bodyLarge.fontFamily),
    [theme.colors, phoneLayout, theme.fonts.bodyLarge.fontFamily],
  );
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  return (
    <View
      testID={testID}
      accessible={Boolean(
        accessibilityLabel && (!onCopyMarkdown || !showCopyAction),
      )}
      accessibilityLabel={accessibilityLabel}
    >
      {blocks.map((block, index) => {
        const blockSpacing =
          phoneLayout &&
          block.type !== "heading" &&
          index > 0 &&
          blocks[index - 1]?.type !== "heading"
            ? styles.blockSpacing
            : undefined;
        if (block.type === "code")
          return (
            <View key={`code${index}`} style={[styles.codeBlock, blockSpacing]}>
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
              style={[styles.mathBlock, blockSpacing]}
            >
              <Text selectable style={styles.mathText}>
                {block.value}
              </Text>
            </View>
          );
        if (block.type === "list")
          return (
            <View key={`list${index}`} style={[styles.list, blockSpacing]}>
              {block.items.map((item, itemIndex) => (
                <View key={itemIndex} style={styles.listItem}>
                  <Text style={[styles.body, phoneLayout && styles.listMarker]}>
                    {block.ordered ? `${itemIndex + (block.start ?? 1)}.` : "•"}
                  </Text>
                  <Inline
                    nodes={item}
                    phoneLayout={phoneLayout}
                    {...(phoneLayout ? { style: styles.listContent } : {})}
                  />
                </View>
              ))}
            </View>
          );
        if (block.type === "quote")
          return (
            <View key={`quote${index}`} style={[styles.quote, blockSpacing]}>
              <Inline nodes={block.value} phoneLayout={phoneLayout} />
            </View>
          );
        return (
          <View
            key={`block${index}`}
            style={[
              block.type === "heading" ? styles.heading : blockSpacing,
              phoneLayout &&
                block.type === "heading" &&
                index === 0 && { marginTop: 0 },
            ]}
          >
            <Inline
              nodes={block.value}
              phoneLayout={phoneLayout}
              {...(block.type === "heading"
                ? {
                    style: {
                      fontSize: Math.max(
                        phoneLayout ? 18 : 16,
                        26 - (block.level ?? 1) * 2,
                      ),
                      ...(phoneLayout
                        ? {
                            lineHeight: Math.max(
                              25,
                              32 - (block.level ?? 1) * 2,
                            ),
                          }
                        : {}),
                      fontWeight: phoneLayout ? "600" : "700",
                    },
                  }
                : {})}
            />
          </View>
        );
      })}
      {onCopyMarkdown && showCopyAction ? (
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

const codeFont =
  Platform.OS === "ios"
    ? "Menlo"
    : Platform.OS === "web"
      ? "ui-monospace, SFMono-Regular, Consolas, monospace"
      : "monospace";
const createStyles = (
  colors: MD3Theme["colors"],
  phoneLayout = false,
  fontFamily = "System",
) =>
  StyleSheet.create({
    body: {
      color: colors.onSurface,
      fontSize: phoneLayout ? 17 : 16,
      lineHeight: phoneLayout ? 25 : 23,
      ...(phoneLayout
        ? { fontFamily, fontWeight: "400" as const, letterSpacing: 0 }
        : {}),
    },
    blockSpacing: { marginTop: 12 },
    bold: { fontWeight: phoneLayout ? "600" : "700" },
    italic: { fontStyle: "italic" },
    inlineCode: {
      fontFamily: phoneLayout ? codeFont : "monospace",
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
      fontFamily: phoneLayout ? codeFont : "monospace",
      fontSize: phoneLayout ? 14 : 13,
      lineHeight: phoneLayout ? 21 : 19,
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
    list: { gap: phoneLayout ? 6 : 4 },
    listItem: { flexDirection: "row", gap: 8 },
    listMarker: { minWidth: 20, flexShrink: 0 },
    listContent: { flex: 1, minWidth: 0 },
    heading: phoneLayout
      ? { marginTop: 20, marginBottom: 8 }
      : { marginVertical: 2 },
    copy: {
      alignSelf: "flex-end",
      paddingHorizontal: 12,
      minWidth: 44,
      minHeight: 44,
      justifyContent: "center",
    },
    copyLabel: { color: colors.primary, fontSize: 14 },
  });
