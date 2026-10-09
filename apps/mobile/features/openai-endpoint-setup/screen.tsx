import { useEffect, useRef, useState } from "react";
import { Keyboard, Platform, ScrollView, StyleSheet } from "react-native";
import { Text } from "react-native-paper";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { describeError } from "../diagnostics/errors";
import { ErrorNotice } from "../diagnostics/error-notice";
import {
  NativeButton,
  NativeInput,
  NativeSurface,
} from "@locallab/ui-native-primitives";
import {
  newOpenAISetupDefaults,
  saveOpenAIEndpointSetup,
  SQLiteOpenAIEndpointSetupRepository,
} from "./index";

/** A mountable compact BYOK surface. It has no account or onboarding dependency. */
export function OpenAIEndpointSetupScreen(props: {
  connectionId: string;
  database: SQLiteDatabasePort;
  secrets: SecretStore;
  onSaved?: (connectionId: string) => void;
}) {
  const repository = new SQLiteOpenAIEndpointSetupRepository(props.database);
  const [endpoint, setEndpoint] = useState(
    newOpenAISetupDefaults(props.connectionId).endpointUrl,
  );
  const [model, setModel] = useState(
    newOpenAISetupDefaults(props.connectionId).modelId,
  );
  const [key, setKey] = useState("");
  const [savedKey, setSavedKey] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const scroll = useRef<ScrollView>(null);
  const pendingCleanup = useRef(new Set<SecretRef>());
  useEffect(() => {
    if (!error) return;
    Keyboard.dismiss();
    requestAnimationFrame(() =>
      scroll.current?.scrollTo({ y: 0, animated: true }),
    );
  }, [error]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const defaults = newOpenAISetupDefaults(props.connectionId);
    setEndpoint(defaults.endpointUrl);
    setModel(defaults.modelId);
    setSavedKey(false);
    setMessage("");
    setError("");
    void repository
      .get(props.connectionId)
      .then(async (setup) => {
        if (!active || !setup) return;
        setEndpoint(setup.endpointUrl);
        setModel(setup.modelId);
        await props.secrets.resolveHeaders(new URL(setup.endpointUrl).origin, [
          setup.apiKeyRef,
        ]);
        if (active) setSavedKey(true);
      })
      .catch((cause) => {
        if (active)
          setError(
            describeError(cause, {
              operation: "Load saved OpenAI endpoint setup",
              recovery:
                "Reopen this page and try again. If the saved key is unavailable, enter it again.",
            }),
          );
      });
    return () => {
      active = false;
    };
  }, [props.connectionId, props.database, props.secrets]);

  const save = async () => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await saveOpenAIEndpointSetup({
        connectionId: props.connectionId,
        endpointUrl: endpoint,
        modelId: model,
        apiKey: key,
        repository,
        secrets: props.secrets,
        onCleanupFailure: (cause, ref, committed) => {
          pendingCleanup.current.add(ref);
          const message = describeError(cause, {
            operation: committed
              ? "Remove replaced OpenAI API key"
              : "Remove unsaved OpenAI API key",
            recovery:
              (committed
                ? "The endpoint was saved. "
                : "The endpoint was not saved. ") +
              "Use Retry secure cleanup to remove the pending key.",
          });
          setError((current) =>
            current ? `${current}\n\n${message}` : message,
          );
        },
      });
      setKey("");
      setSavedKey(true);
      setMessage(
        Platform.OS === "web"
          ? "Endpoint saved. The API key lasts for this browser tab."
          : "OpenAI endpoint saved securely on this device.",
      );
      if (!pendingCleanup.current.size) props.onSaved?.(props.connectionId);
    } catch (cause) {
      const message = describeError(cause, {
        operation: "Save OpenAI endpoint and model",
        recovery:
          "Check the HTTPS endpoint, model ID and API key, then save again.",
      });
      setError((current) => (current ? `${current}\n\n${message}` : message));
    } finally {
      setBusy(false);
    }
  };
  const retryCleanup = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      for (const ref of pendingCleanup.current) {
        try {
          await props.secrets.remove(ref);
          pendingCleanup.current.delete(ref);
        } catch (cause) {
          const message = describeError(cause, {
            operation: "Retry secure OpenAI-key cleanup",
            recovery:
              "Try secure cleanup again and inspect the trace log if secure storage remains unavailable.",
          });
          setError((current) =>
            current ? `${current}\n\n${message}` : message,
          );
        }
      }
      if (!pendingCleanup.current.size)
        setMessage("Pending secure keys removed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      ref={scroll}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.page}
    >
      {error ? <ErrorNotice message={error} /> : null}
      {pendingCleanup.current.size ? (
        <NativeButton
          accessibilityLabel="Retry secure cleanup"
          disabled={busy}
          onPress={() => void retryCleanup()}
        >
          Retry secure cleanup
        </NativeButton>
      ) : null}
      <NativeSurface
        accessibilityLabel="OpenAI endpoint setup"
        style={styles.card}
      >
        <Text accessibilityRole="header" variant="titleLarge">
          OpenAI API
        </Text>
        <Text>
          {Platform.OS === "web"
            ? "Connect with your API key. It stays in this tab's memory and is cleared when the page reloads."
            : "Connect with your API key. The key stays in device secure storage."}
        </Text>
        <NativeInput
          accessibilityLabel="Responses endpoint URL"
          label="Responses endpoint URL"
          value={endpoint}
          onChangeText={setEndpoint}
          autoCapitalize="none"
          keyboardType="url"
          placeholder="https://api.openai.com/v1/responses"
        />
        <NativeInput
          accessibilityLabel="OpenAI model ID"
          label="Model ID"
          value={model}
          onChangeText={setModel}
          autoCapitalize="none"
          placeholder="gpt-4.1-mini"
        />
        <NativeInput
          accessibilityLabel="OpenAI API key"
          label={savedKey ? "Replace API key (optional)" : "API key"}
          value={key}
          onChangeText={setKey}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <NativeButton
          accessibilityLabel="Save OpenAI endpoint and model"
          disabled={busy || !model.trim() || (!savedKey && !key.trim())}
          onPress={() => void save()}
        >
          {busy ? "Saving…" : "Save endpoint"}
        </NativeButton>
        {message ? (
          <Text accessibilityLiveRegion="polite">{message}</Text>
        ) : null}
      </NativeSurface>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20 },
  card: { padding: 16, gap: 12 },
});
