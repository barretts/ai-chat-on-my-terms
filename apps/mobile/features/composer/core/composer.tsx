import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { normalizeComposerDraft, submitComposerDraft } from "./index";
import type { ComposerSendIntent } from "./index";

export interface ComposerProps {
  onSend: ComposerSendIntent;
  isWorking?: boolean;
  onStop?: () => void | Promise<void>;
  placeholder?: string;
  errorMessage?: string;
}

export function Composer({
  onSend,
  isWorking = false,
  onStop,
  placeholder = "Message",
  errorMessage,
}: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const busy = sending || isWorking;
  const canSend = normalizeComposerDraft(draft).length > 0 && !busy;

  const send = useCallback(async () => {
    if (!canSend) return;
    setSending(true);
    setSendError("");
    try {
      const accepted = await submitComposerDraft(draft, onSend);
      if (accepted) setDraft((current) => (current === draft ? "" : current));
    } catch (error) {
      setSendError(
        error instanceof Error ? error.message : "Message could not be sent.",
      );
    } finally {
      setSending(false);
    }
  }, [canSend, draft, onSend]);

  const stop = useCallback(async () => {
    if (!isWorking || !onStop) return;
    try {
      await onStop();
    } catch (error) {
      setSendError(
        error instanceof Error
          ? error.message
          : "Response could not be stopped.",
      );
    }
  }, [isWorking, onStop]);

  return (
    <View style={styles.container}>
      {errorMessage || sendError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {errorMessage || sendError}
        </Text>
      ) : null}
      <View style={styles.row}>
        <TextInput
          accessibilityLabel="Message"
          blurOnSubmit
          editable={!isWorking}
          multiline
          onChangeText={setDraft}
          onSubmitEditing={() => void send()}
          placeholder={placeholder}
          returnKeyType="send"
          style={styles.input}
          testID="composer-input"
          value={draft}
        />
        {isWorking ? (
          <Pressable
            accessibilityLabel="Stop response"
            accessibilityRole="button"
            onPress={stop}
            style={styles.stopButton}
            testID="composer-stop"
          >
            <Text style={styles.stopText}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityLabel="Send message"
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSend, busy: sending }}
            disabled={!canSend}
            onPress={() => void send()}
            style={[styles.sendButton, !canSend && styles.disabledButton]}
            testID="composer-send"
          >
            <Text style={styles.sendText}>{sending ? "Sending…" : "Send"}</Text>
          </Pressable>
        )}
      </View>
      <Text accessibilityLiveRegion="polite" style={styles.status}>
        {sending ? "Sending message" : isWorking ? "Response in progress" : ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6 },
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    borderWidth: 1,
    borderColor: "#aaa79f",
    borderRadius: 20,
    padding: 8,
  },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 128,
    paddingHorizontal: 8,
    paddingVertical: 9,
    color: "#20201e",
    fontSize: 16,
  },
  sendButton: {
    minHeight: 42,
    justifyContent: "center",
    borderRadius: 16,
    backgroundColor: "#20201e",
    paddingHorizontal: 14,
  },
  disabledButton: { opacity: 0.45 },
  sendText: { color: "white", fontWeight: "600" },
  stopButton: {
    minHeight: 42,
    justifyContent: "center",
    borderRadius: 16,
    backgroundColor: "#f1e7e5",
    paddingHorizontal: 14,
  },
  stopText: { color: "#8b302b", fontWeight: "600" },
  error: { color: "#8b302b", paddingHorizontal: 8, paddingBottom: 6 },
  status: {
    minHeight: 16,
    paddingHorizontal: 8,
    color: "#5e5c56",
    fontSize: 12,
  },
});
