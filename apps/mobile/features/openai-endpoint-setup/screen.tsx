import { useEffect, useState } from "react";
import { Platform, ScrollView, StyleSheet } from "react-native";
import { Text } from "react-native-paper";
import type { SecretStore } from "@locallab/security-secrets";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
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
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const defaults = newOpenAISetupDefaults(props.connectionId);
    setEndpoint(defaults.endpointUrl);
    setModel(defaults.modelId);
    setSavedKey(false);
    setMessage("");
    void repository
      .get(props.connectionId)
      .then((setup) => {
        if (!active || !setup) return;
        setEndpoint(setup.endpointUrl);
        setModel(setup.modelId);
        setSavedKey(true);
      })
      .catch(() => {
        if (active) setMessage("Saved endpoint setup could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [props.connectionId, props.database]);

  const save = async () => {
    setBusy(true);
    setMessage("");
    try {
      await saveOpenAIEndpointSetup({
        connectionId: props.connectionId,
        endpointUrl: endpoint,
        modelId: model,
        apiKey: key,
        repository,
        secrets: props.secrets,
      });
      setKey("");
      setSavedKey(true);
      setMessage(
        Platform.OS === "web"
          ? "Endpoint saved. The API key lasts for this browser tab."
          : "OpenAI endpoint saved securely on this device.",
      );
      props.onSaved?.(props.connectionId);
    } catch {
      setMessage(
        "Could not save setup. Check the HTTPS endpoint, model ID, and secure API key.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.page}
    >
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
        {message ? <Text accessibilityRole="alert">{message}</Text> : null}
      </NativeSurface>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20 },
  card: { padding: 16, gap: 12 },
});
