import { useState, useSyncExternalStore } from "react";
import { Platform, ScrollView, View } from "react-native";
import { Button, Switch, Text, useTheme } from "react-native-paper";
import { nativeArchiveFiles } from "../../composition/chat/archives/native";
import { writeClipboardMarkdown } from "../../platform/clipboard";
import { useDiagnostics } from "./context";
import { ErrorNotice } from "./error-notice";
import { describeError } from "./errors";
import { traceLog } from "./trace-log";
import { strToU8 } from "fflate";

export function DiagnosticsScreen() {
  const theme = useTheme();
  const diagnostics = useDiagnostics();
  const snapshot = useSyncExternalStore(
    traceLog.subscribe,
    traceLog.getSnapshot,
  );
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const action = async (
    operation: string,
    work: () => Promise<void>,
    completed: string,
  ) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      setMessage(completed);
    } catch (cause) {
      setError(
        describeError(cause, {
          operation,
          recovery:
            "Retry this action. You can still select and copy the visible log text.",
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 16, gap: 16 }}
    >
      <Text variant="titleLarge">Troubleshooting</Text>
      <Text style={{ fontSize: 16, lineHeight: 24 }}>
        Turn on recording, reproduce the problem, then share the trace log. It
        stays on this device and includes operation times, server origins, HTTP
        status codes, and failures. API keys, headers, chat messages, and
        response content are excluded.
      </Text>
      {error || snapshot.storageError || diagnostics?.storageError ? (
        <ErrorNotice
          message={
            error || snapshot.storageError || diagnostics?.storageError || ""
          }
        />
      ) : null}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          minHeight: 48,
        }}
      >
        <Text variant="titleMedium">Record trace log</Text>
        <Switch
          accessibilityLabel="Record trace log"
          value={snapshot.enabled}
          disabled={busy || !snapshot.ready}
          onValueChange={(enabled) =>
            void action(
              "Change trace recording",
              () => traceLog.setEnabled(enabled),
              enabled
                ? "Trace recording is on. Reproduce the problem now."
                : "Trace recording is off. Existing entries remain until cleared.",
            )
          }
        />
      </View>
      {!snapshot.ready ? (
        <Button
          disabled={busy}
          mode="outlined"
          onPress={() =>
            void action(
              "Open diagnostic storage",
              () =>
                diagnostics?.retryStorage() ??
                Promise.reject(new Error("Diagnostic storage is unavailable.")),
              "Diagnostic storage is ready.",
            )
          }
        >
          Retry diagnostic storage
        </Button>
      ) : null}
      <Text>
        {snapshot.entries.length} of 250 recent events kept. The recording
        preference and log survive app restarts.
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          mode="contained"
          disabled={busy || !snapshot.entries.length}
          onPress={() =>
            void action(
              "Export trace log",
              async () => {
                await traceLog.flush();
                const text = traceLog.export();
                if (Platform.OS === "web") {
                  const url = URL.createObjectURL(
                    new Blob([text], { type: "application/json" }),
                  );
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = "locallab-trace.json";
                  link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                } else {
                  await nativeArchiveFiles.share({
                    name: "locallab-trace.json",
                    mimeType: "application/json",
                    bytes: strToU8(text),
                  });
                }
              },
              "Trace log export opened.",
            )
          }
        >
          Export log
        </Button>
        <Button
          mode="outlined"
          disabled={busy || !snapshot.entries.length}
          onPress={() =>
            void action(
              "Copy trace log",
              () => writeClipboardMarkdown(traceLog.export()),
              "Trace log copied.",
            )
          }
        >
          Copy log
        </Button>
        <Button
          disabled={busy || !snapshot.entries.length}
          onPress={() =>
            void action(
              "Clear trace log",
              () => traceLog.clear(),
              "Trace log cleared.",
            )
          }
        >
          Clear log
        </Button>
      </View>
      {message ? <Text accessibilityLiveRegion="polite">{message}</Text> : null}
      {snapshot.entries.length ? (
        [...snapshot.entries].reverse().map((entry, index) => (
          <View
            key={`${entry.time}-${index}`}
            style={{
              padding: 12,
              gap: 6,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.outlineVariant,
            }}
          >
            <Text selectable style={{ fontWeight: "600" }}>
              {entry.operation} · {entry.phase}
            </Text>
            <Text selectable>{entry.time}</Text>
            <Text selectable style={{ fontSize: 14, lineHeight: 21 }}>
              {Object.entries(entry.detail)
                .map(([key, value]) => `${key}: ${value}`)
                .join("\n") || "No additional metadata."}
            </Text>
          </View>
        ))
      ) : (
        <Text>
          No recorded events. Enable recording, then repeat the action that
          failed.
        </Text>
      )}
    </ScrollView>
  );
}
