import { useEffect, useState, useSyncExternalStore } from "react";
import { Linking, Platform, ScrollView, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import {
  NativeButton,
  NativeInput,
  NativeSurface,
  NativeDropdown,
  NativeActivity,
} from "@locallab/ui-native-primitives";
import {
  mobileSpeech,
  speechModels,
  speechVoices,
} from "../../platform/speech";

export interface SpeechPanelProps {
  onClose?: () => void;
  initialText?: string;
}

export function SpeechPanel({
  onClose,
  initialText = "Hello. This voice is generated locally on your device. Your words stay private.",
}: SpeechPanelProps) {
  const theme = useTheme();
  const state = useSyncExternalStore(
    mobileSpeech.subscribe,
    mobileSpeech.snapshot,
    mobileSpeech.snapshot,
  );
  const [text, setText] = useState(initialText);
  const busy = !["idle", "error"].includes(state.phase);
  const voice = speechVoices.find((item) => item.id === state.selectedVoiceId)!;
  const installed = state.installedModelIds.includes(voice.modelId);
  useEffect(() => {
    void mobileSpeech.refresh().catch(() => undefined);
    return () => {
      void mobileSpeech.stop();
    };
  }, []);
  const perform = (work: () => Promise<void>) => {
    void work().catch(() => undefined);
  };
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}
    >
      <Text variant="headlineSmall">Voice studio</Text>
      <Text>
        Neural speech runs on this device. Download a model once; your text is
        never sent to a speech service.
      </Text>
      <NativeDropdown
        label="Offline voice"
        value={state.selectedVoiceId}
        options={speechVoices.map((item) => ({
          value: item.id,
          label: item.name,
          detail: `${item.description} · ${state.installedModelIds.includes(item.modelId) ? "Ready offline" : "Download voice pack to use"}`,
        }))}
        disabled={busy}
        onChange={(id) => perform(() => mobileSpeech.selectVoice(id))}
      />
      <NativeDropdown
        label="Voice speed"
        value={String(state.rate)}
        options={[0.75, 1, 1.15, 1.3, 1.5].map((rate) => ({
          value: String(rate),
          label: `${rate}×${rate === 1 ? " · Natural" : rate < 1 ? " · Unhurried" : " · Brisk"}`,
        }))}
        disabled={busy}
        onChange={(rate) => perform(() => mobileSpeech.setRate(Number(rate)))}
      />
      <NativeInput
        label="Text to read aloud"
        accessibilityLabel="Text to read aloud"
        value={text}
        onChangeText={setText}
        multiline
      />
      <View style={styles.row}>
        <NativeButton
          accessibilityLabel="Read aloud using selected offline voice"
          disabled={busy || !installed || !text.trim()}
          onPress={() => perform(() => mobileSpeech.speak(text))}
        >
          Read aloud
        </NativeButton>
        <NativeButton
          accessibilityLabel="Stop offline speech"
          disabled={!busy && !state.audioUri}
          onPress={() => perform(() => mobileSpeech.stop())}
        >
          Stop
        </NativeButton>
        {onClose && (
          <NativeButton
            accessibilityLabel="Back to chat from offline voices"
            onPress={onClose}
          >
            Back to chat
          </NativeButton>
        )}
      </View>
      {!installed && (
        <View style={{ gap: 8 }}>
          <Text>
            Download{" "}
            {speechModels.find((item) => item.id === voice.modelId)!.name} to
            use {voice.name}.
          </Text>
          <NativeButton
            accessibilityLabel="Download selected voice pack"
            disabled={busy}
            onPress={() => perform(() => mobileSpeech.install(voice.modelId))}
          >
            Get {voice.name}'s voice pack
          </NativeButton>
        </View>
      )}
      {busy ? (
        <NativeActivity
          label={
            state.phase === "downloading"
              ? "Downloading your voice pack"
              : state.phase === "loading"
                ? "Preparing your voice"
                : state.phase === "generating"
                  ? "Your voice is getting ready"
                  : "Reading aloud"
          }
        />
      ) : null}
      <Text
        accessibilityRole="alert"
        style={{
          color:
            state.phase === "error"
              ? theme.colors.error
              : theme.colors.onSurface,
        }}
      >
        {state.message}
        {state.progress === null ? "" : ` ${Math.round(state.progress * 100)}%`}
      </Text>
      {speechModels.map((model) => (
        <NativeSurface
          key={model.id}
          accessibilityLabel={`${model.name} offline speech model`}
          style={styles.card}
        >
          <Text variant="titleMedium">{model.name}</Text>
          <Text>
            {model.sizeLabel} · {model.license}
          </Text>
          {speechVoices
            .filter((item) => item.modelId === model.id)
            .map((item) => (
              <View key={item.id} style={styles.voice}>
                <NativeButton
                  accessibilityLabel={`Select ${item.name} offline voice`}
                  disabled={busy}
                  onPress={() =>
                    perform(() => mobileSpeech.selectVoice(item.id))
                  }
                >{`${state.selectedVoiceId === item.id ? "Selected: " : ""}${item.name}`}</NativeButton>
                <Text>{item.description}</Text>
              </View>
            ))}
          <View style={styles.row}>
            <NativeButton
              accessibilityLabel={`Download ${model.name} speech model`}
              disabled={
                busy ||
                (Platform.OS !== "web" &&
                  state.installedModelIds.includes(model.id))
              }
              onPress={() => perform(() => mobileSpeech.install(model.id))}
            >
              {state.installedModelIds.includes(model.id)
                ? Platform.OS === "web"
                  ? "Check download"
                  : "Downloaded"
                : "Download model"}
            </NativeButton>
            {state.installedModelIds.includes(model.id) && (
              <NativeButton
                accessibilityLabel={`Remove ${model.name} speech model`}
                disabled={busy}
                onPress={() => perform(() => mobileSpeech.remove(model.id))}
              >
                Remove download
              </NativeButton>
            )}
            <NativeButton
              accessibilityLabel={`${model.name} voice licence`}
              onPress={() => {
                void Linking.openURL(model.licenseUrl);
              }}
            >
              Voice licence
            </NativeButton>
          </View>
        </NativeSurface>
      ))}
      <Text>
        Keep this panel open while downloading or reading. Browser downloads
        stay in this browser profile; native downloads stay in the app.
      </Text>
      {mobileSpeech.repairRuntime ? (
        <NativeButton
          accessibilityLabel="Repair offline voices"
          disabled={busy}
          onPress={() => perform(() => mobileSpeech.repairRuntime!())}
        >
          Repair offline voices
        </NativeButton>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14 },
  card: { padding: 14, gap: 10 },
  voice: { gap: 4 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
