import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSupport } from "./provider";
import { PublicSupportLinks } from "./public-links";

export function SupportSection() {
  const support = useSupport();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!support.available)
    return (
      <View style={styles.row} testID="support-unavailable">
        <PublicSupportLinks />
        <Text style={styles.title}>Support</Text>
        <Text style={styles.muted}>
          No support service is configured; feature requests stay on this
          device.
        </Text>
      </View>
    );

  async function submit() {
    if (title.trim() === "" || body.trim() === "") {
      setMessage("Add a title and a description first.");
      return;
    }
    const diagnostics = includeDiagnostics
      ? support.redactedDiagnostics()
      : null;
    if (includeDiagnostics && diagnostics === null) {
      setMessage("Diagnostics are not available on this device build.");
      return;
    }
    const ok = await support.submitRequest({
      kind: "feature-request",
      title: title.trim(),
      body: body.trim(),
      ...(diagnostics === null ? {} : { diagnostics }),
    });
    if (ok) {
      setTitle("");
      setBody("");
      setMessage("Posted. Thanks!");
    }
  }

  return (
    <View style={styles.row} testID="support-section">
      <PublicSupportLinks />
      <Text style={styles.title}>Support board</Text>
      {support.update !== null && !support.update.upToDate ? (
        <Text testID="support-update-available">
          Update available: {support.update.latest}
        </Text>
      ) : null}
      {support.requests.map((request) => (
        <View key={request.id} style={styles.product}>
          <Text testID={`support-request-${request.id}`}>
            {request.unreadReplies !== undefined && request.unreadReplies > 0
              ? "● "
              : ""}
            {request.title} — {request.votes} vote
            {request.votes === 1 ? "" : "s"}
          </Text>
          <View style={styles.actions}>
            <Pressable
              testID={`support-vote-${request.id}`}
              onPress={() => void support.vote(request.id, !request.myVote)}
            >
              <Text>{request.myVote ? "unvote" : "vote"}</Text>
            </Pressable>
            <Pressable
              testID={`support-open-${request.id}`}
              onPress={() => void support.markRead(request.id)}
            >
              <Text>mark read</Text>
            </Pressable>
          </View>
        </View>
      ))}
      <Text style={styles.title}>New feature request</Text>
      <TextInput
        testID="support-title"
        placeholder="Title"
        value={title}
        onChangeText={setTitle}
      />
      <TextInput
        testID="support-body"
        placeholder="Describe what you need (no chat content is sent unless you paste it)"
        value={body}
        onChangeText={setBody}
        multiline
      />
      <Pressable
        testID="support-diagnostics-toggle"
        onPress={() => setIncludeDiagnostics((current) => !current)}
      >
        <Text>
          {includeDiagnostics ? "[x]" : "[ ]"} include redacted diagnostics
          (counts/versions only — never chat text)
        </Text>
      </Pressable>
      <Pressable
        testID="support-submit"
        disabled={support.busy}
        onPress={() => void submit()}
      >
        <Text>Submit</Text>
      </Pressable>
      <Text style={styles.title}>Changelog</Text>
      {support.changelog.map((entry) => (
        <Text key={entry.version} testID={`support-changelog-${entry.version}`}>
          {entry.version} — {entry.notes}
        </Text>
      ))}
      {confirmDelete ? (
        <View style={styles.actions} testID="support-delete-confirm">
          <Text>Delete account and all support metadata?</Text>
          <Pressable
            testID="support-delete-yes"
            onPress={() =>
              void support
                .deleteAccount()
                .then((ok) =>
                  setMessage(ok ? "Account deleted." : "Delete failed."),
                )
            }
          >
            <Text>Yes, delete</Text>
          </Pressable>
          <Pressable
            testID="support-delete-no"
            onPress={() => setConfirmDelete(false)}
          >
            <Text>Cancel</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          testID="support-delete-account"
          onPress={() => setConfirmDelete(true)}
        >
          <Text>Delete account (support metadata)</Text>
        </Pressable>
      )}
      {(message ?? support.error) !== null ? (
        <Text style={styles.error}>{message ?? support.error}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: 8, paddingVertical: 12 },
  title: { fontWeight: "600" },
  product: { gap: 4 },
  actions: { flexDirection: "row", gap: 12 },
  muted: { opacity: 0.6 },
  error: { color: "#b00020" },
});
