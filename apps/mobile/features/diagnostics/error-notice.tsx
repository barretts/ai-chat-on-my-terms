import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { Button, Text, useTheme } from "react-native-paper";
import { writeClipboardMarkdown } from "../../platform/clipboard";
import { sanitizeDiagnosticText } from "./sanitization";
import { useDiagnostics } from "./context";

/** Full selectable error text; no ellipsis, disappearing toast or collapsed details. */
export function ErrorNotice({
  message,
  maxTextHeight,
}: {
  message: string;
  maxTextHeight?: number;
}) {
  const theme = useTheme();
  const diagnostics = useDiagnostics();
  const [copyStatus, setCopyStatus] = useState("");
  const [overflow, setOverflow] = useState(false);
  const detailsScroll = useRef<ScrollView>(null);
  const safeMessage = sanitizeDiagnosticText(message);
  useEffect(() => {
    detailsScroll.current?.scrollTo({ y: 0, animated: false });
    setCopyStatus("");
  }, [safeMessage]);
  const details = (
    <Text
      onLayout={(event) =>
        setOverflow(
          Boolean(
            maxTextHeight && event.nativeEvent.layout.height > maxTextHeight,
          ),
        )
      }
      selectable
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      style={{
        color: theme.colors.onErrorContainer,
        fontSize: 16,
        lineHeight: 24,
        flexShrink: 0,
      }}
    >
      {safeMessage}
    </Text>
  );
  return (
    <View
      style={{
        flexShrink: 0,
        width: "100%",
        gap: 8,
        padding: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.errorContainer,
        borderWidth: 1,
        borderColor: theme.colors.error,
      }}
    >
      {maxTextHeight ? (
        <ScrollView
          ref={detailsScroll}
          accessibilityLabel="Error details"
          style={{ maxHeight: maxTextHeight }}
          keyboardShouldPersistTaps="handled"
        >
          {details}
        </ScrollView>
      ) : (
        details
      )}
      {overflow ? (
        <Text
          style={{
            color: theme.colors.onErrorContainer,
            fontSize: 13,
            lineHeight: 18,
          }}
        >
          Scroll for full details. Copy error includes the entire message.
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          compact
          contentStyle={{ minHeight: 44 }}
          mode="text"
          textColor={theme.colors.onErrorContainer}
          onPress={() => {
            void writeClipboardMarkdown(safeMessage)
              .then(() => setCopyStatus("Error copied."))
              .catch((cause: unknown) =>
                setCopyStatus(
                  `Copy error failed. ${sanitizeDiagnosticText(cause instanceof Error ? cause.message : String(cause))} Select the text to copy it manually.`,
                ),
              );
          }}
        >
          Copy error
        </Button>
        {diagnostics ? (
          <Button
            compact
            contentStyle={{ minHeight: 44 }}
            mode="text"
            textColor={theme.colors.onErrorContainer}
            onPress={diagnostics.openTrace}
          >
            Trace log
          </Button>
        ) : null}
      </View>
      {copyStatus ? (
        <Text
          selectable
          accessibilityLiveRegion="polite"
          style={{ color: theme.colors.onErrorContainer }}
        >
          {copyStatus}
        </Text>
      ) : null}
    </View>
  );
}
