import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  List,
  ProgressBar,
  Switch,
  Text,
  useTheme,
} from "react-native-paper";
import {
  NativeButton,
  NativeDropdown,
  NativeInput,
  NativeSurface,
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";
import {
  effectiveVoiceControls,
  VOICE_ENGINE_CAPABILITIES,
  VOICE_ENGINE_IDS,
  VOICE_LISTENING_LIMITS,
  type ImportedTranscription,
  type PersonaVoice,
  type PersonaVoicePatchInput,
  type VoiceEngineId,
  type VoicePreferences,
} from "./index";

const TEST_SENTENCE =
  "Hello. This is how your selected voice will read replies aloud.";

const VOICE_PITCH_OPTIONS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2];

export interface VoiceStudioPersona {
  readonly id: string;
  readonly name: string;
  readonly voice: PersonaVoice;
}

export interface VoiceStudioConnectionOption {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}

export interface VoiceSettingsPanelProps {
  prefs: VoicePreferences;
  onPrefsChange(update: Partial<VoicePreferences>): void;
  voices: readonly { id: string; name: string }[];
  locales: readonly string[];
  personas: readonly VoiceStudioPersona[];
  cloudConnections: readonly VoiceStudioConnectionOption[];
  onBinding(personaId: string, patch: PersonaVoicePatchInput): void;
  imports: readonly ImportedTranscription[];
  whisper: {
    phase: string;
    progress: number | null;
    message: string;
    installed: boolean;
  };
  busy: boolean;
  playingId: string | null;
  error: string;
  notice: string;
  onImport(): void;
  onPlay(item: ImportedTranscription): void;
  onStopPlayback(): void;
  onRemove(item: ImportedTranscription): void;
  onTestVoice(): void;
}

function engineLabel(engine: VoiceEngineId): string {
  return VOICE_ENGINE_CAPABILITIES[engine].label;
}

function secondsField(ms: number): string {
  return (ms / 1000).toFixed(1).replace(/\.0$/, "");
}

/**
 * Voice settings surface (VO-05, VO-06, VO-15, VO-16): read-aloud engine,
 * language, rate/pitch, listening controls, file transcription imports with
 * a retained player, and per-Persona voice bindings. All state lives in the
 * chat screen; this component only renders and reports edits.
 */
export function VoiceSettingsPanel(props: VoiceSettingsPanelProps) {
  const theme = useTheme();
  const { phone } = useWorkspaceLayout();
  const { prefs, onPrefsChange } = props;
  const capabilities = VOICE_ENGINE_CAPABILITIES[prefs.engine];
  const controls = effectiveVoiceControls(prefs);
  const [silenceDraft, setSilenceDraft] = useState<string | null>(null);
  const [listeningDraft, setListeningDraft] = useState<string | null>(null);
  const [voiceDraft, setVoiceDraft] = useState<{
    personaId: string;
    text: string;
  } | null>(null);
  const commitListening = (
    draft: string | null,
    key: "silenceTimeoutMs" | "maxListeningMs",
    reset: (value: string | null) => void,
  ): void => {
    reset(null);
    if (draft === null) return;
    const limit = VOICE_LISTENING_LIMITS[key];
    const seconds = Number(draft.replace(",", "."));
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const ms = Math.min(
      limit.max,
      Math.max(limit.min, Math.round(seconds * 1000)),
    );
    if (ms === prefs[key]) return;
    onPrefsChange(
      key === "silenceTimeoutMs"
        ? { silenceTimeoutMs: ms }
        : { maxListeningMs: ms },
    );
  };
  const silenceValue =
    silenceDraft ?? secondsField(prefs.silenceTimeoutMs);
  const listeningValue =
    listeningDraft ?? secondsField(prefs.maxListeningMs);
  const listeningBusy =
    props.whisper.phase === "downloading" ||
    props.whisper.phase === "loading" ||
    props.whisper.phase === "transcribing";
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={[
        styles.content,
        phone ? styles.phoneContent : styles.desktopContent,
      ]}
    >
      <Text accessibilityRole="header" variant="headlineSmall">
        Voice settings
      </Text>
      {props.error ? (
        <Text
          testID="voice-settings-error"
          accessibilityLiveRegion="polite"
          variant="bodySmall"
          style={{ color: theme.colors.error }}
        >
          {props.error}
        </Text>
      ) : null}
      {props.notice ? (
        <Text
          testID="voice-settings-notice"
          accessibilityLiveRegion="polite"
          variant="bodySmall"
          style={{ color: theme.colors.primary }}
        >
          {props.notice}
        </Text>
      ) : null}

      <NativeSurface
        accessibilityLabel="Read aloud settings"
        style={styles.card}
      >
        <Text accessibilityRole="header" variant="titleMedium">
          Reading replies aloud
        </Text>
        <View style={styles.switchRow}>
          <Switch
            value={prefs.autoRead}
            onValueChange={(autoRead) => onPrefsChange({ autoRead })}
            accessibilityLabel="Automatically read assistant replies aloud"
          />
          <Text variant="bodyMedium">Read new replies aloud</Text>
        </View>
        <NativeDropdown
          label="Voice engine"
          value={prefs.engine}
          options={VOICE_ENGINE_IDS.map((engine) => ({
            value: engine,
            label: engineLabel(engine),
            detail:
              engine === "elevenlabs" || engine === "xai"
                ? "Needs a saved API connection on the Persona below"
                : engine === "system"
                  ? "The voice installed with your phone"
                  : "The offline voice packs from Voices",
          }))}
          disabled={props.busy}
          onChange={(engine) => onPrefsChange({ engine: engine as VoiceEngineId })}
        />
        {capabilities.rate ? (
          <NativeDropdown
            label="Speech rate"
            value={String(controls.rate ?? 1)}
            options={capabilities.rates.map((rate) => ({
              value: String(rate),
              label: `${rate}×${rate === 1 ? " · Natural" : rate < 1 ? " · Unhurried" : " · Brisk"}`,
            }))}
            disabled={props.busy}
            onChange={(rate) => onPrefsChange({ rate: Number(rate) })}
          />
        ) : null}
        {capabilities.pitch && controls.pitch !== undefined ? (
          <NativeDropdown
            label="Pitch"
            value={String(controls.pitch)}
            options={VOICE_PITCH_OPTIONS.map((pitch) => ({
              value: String(pitch),
              label: `${pitch.toFixed(2)}×${pitch === 1 ? " · Natural" : pitch < 1 ? " · Lower" : " · Higher"}`,
            }))}
            disabled={props.busy}
            onChange={(pitch) => onPrefsChange({ pitch: Number(pitch) })}
          />
        ) : null}
        <NativeDropdown
          label="Spoken language"
          value={prefs.locale || "auto"}
          options={[
            { value: "auto", label: "Auto (match the reply)" },
            ...props.locales.map((locale) => ({
              value: locale,
              label: locale,
            })),
          ]}
          disabled={props.busy}
          onChange={(locale) =>
            onPrefsChange({ locale: locale === "auto" ? "" : locale })
          }
        />
        <NativeInput
          label="Test phrase"
          accessibilityLabel="Test phrase for the selected voice"
          value={TEST_SENTENCE}
          onChangeText={() => {}}
          editable={false}
          multiline
          style={styles.input}
        />
        <NativeButton
          mode="contained"
          icon="volume-high"
          disabled={props.busy}
          accessibilityLabel="Play a test voice sample"
          testID="voice-test-button"
          onPress={props.onTestVoice}
        >
          Test voice
        </NativeButton>
      </NativeSurface>

      <NativeSurface
        accessibilityLabel="Listening settings"
        style={styles.card}
      >
        <Text accessibilityRole="header" variant="titleMedium">
          Dictation limits
        </Text>
        <NativeInput
          label="Pause before auto-send (seconds)"
          accessibilityLabel="Pause of silence before dictation stops"
          value={silenceValue}
          keyboardType="decimal-pad"
          onChangeText={setSilenceDraft}
          onBlur={() =>
            commitListening(silenceDraft, "silenceTimeoutMs", setSilenceDraft)
          }
          onSubmitEditing={() =>
            commitListening(silenceDraft, "silenceTimeoutMs", setSilenceDraft)
          }
          returnKeyType="done"
          style={styles.input}
        />
        <Text variant="bodySmall">
          Silence that ends dictation early. Device speech recognition applies
          this while listening.
        </Text>
        <NativeInput
          label="Maximum listening (seconds)"
          accessibilityLabel="Maximum listening duration"
          value={listeningValue}
          keyboardType="decimal-pad"
          onChangeText={setListeningDraft}
          onBlur={() =>
            commitListening(
              listeningDraft,
              "maxListeningMs",
              setListeningDraft,
            )
          }
          onSubmitEditing={() =>
            commitListening(
              listeningDraft,
              "maxListeningMs",
              setListeningDraft,
            )
          }
          returnKeyType="done"
          style={styles.input}
        />
        <Text variant="bodySmall">
          Listening stops on its own after this long (
          {VOICE_LISTENING_LIMITS.maxListeningMs.min / 1000}-
          {VOICE_LISTENING_LIMITS.maxListeningMs.max / 1000} seconds).
        </Text>
      </NativeSurface>

      <NativeSurface
        accessibilityLabel="Transcribed audio files"
        style={styles.card}
      >
        <Text accessibilityRole="header" variant="titleMedium">
          Transcribe an audio file
        </Text>
        <Text variant="bodySmall">
          {props.whisper.installed
            ? "Pick a recording and Whisper turns it into text on this device. The audio stays playable here afterwards."
            : "Download a Whisper model in Voices to transcribe files."}
        </Text>
        {listeningBusy ? (
          <View testID="voice-import-progress">
            {props.whisper.progress !== null ? (
              <ProgressBar
                progress={Math.min(1, Math.max(0, props.whisper.progress))}
              />
            ) : null}
            <Text variant="bodySmall">{props.whisper.message}</Text>
          </View>
        ) : null}
        <NativeButton
          mode="outlined"
          icon="file-document-outline"
          disabled={props.busy || listeningBusy}
          accessibilityLabel="Choose an audio file to transcribe"
          testID="voice-import-file"
          onPress={props.onImport}
        >
          Import audio
        </NativeButton>
        {props.imports.length === 0 ? (
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            No imported recordings yet.
          </Text>
        ) : null}
        {props.imports.map((item) => (
          <List.Item
            key={item.id}
            testID={`voice-import-row-${item.id}`}
            title={item.name}
            titleNumberOfLines={1}
            description={
              item.text
                ? `${item.text.slice(0, 140)}${item.text.length > 140 ? "…" : ""}`
                : "Transcription failed; the audio is still playable."
            }
            descriptionNumberOfLines={2}
            right={() => (
              <View style={styles.rowActions}>
                <NativeButton
                  compact
                  mode={props.playingId === item.id ? "text" : "outlined"}
                  icon={props.playingId === item.id ? "stop" : "play"}
                  accessibilityLabel={
                    props.playingId === item.id
                      ? `Stop playing ${item.name}`
                      : `Play ${item.name}`
                  }
                  testID={
                    props.playingId === item.id
                      ? `voice-stop-${item.id}`
                      : `voice-play-${item.id}`
                  }
                  onPress={() =>
                    props.playingId === item.id
                      ? props.onStopPlayback()
                      : props.onPlay(item)
                  }
                >
                  {props.playingId === item.id ? "Stop" : "Play"}
                </NativeButton>
                <NativeButton
                  compact
                  mode="text"
                  icon="trash-can-outline"
                  disabled={props.busy}
                  accessibilityLabel={`Delete ${item.name}`}
                  testID={`voice-delete-${item.id}`}
                  onPress={() => props.onRemove(item)}
                >
                  Delete
                </NativeButton>
              </View>
            )}
          />
        ))}
      </NativeSurface>

      <NativeSurface
        accessibilityLabel="Persona voice bindings"
        style={styles.card}
      >
        <Text accessibilityRole="header" variant="titleMedium">
          Per-Persona voices
        </Text>
        <Text variant="bodySmall">
          A Persona can use its own engine, voice and API connection. With
          nothing chosen here, it follows the settings above.
        </Text>
        {props.personas.length === 0 ? (
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Add a Persona to bind a dedicated voice to it.
          </Text>
        ) : null}
        {props.personas.map((persona) => {
          const cloud =
            persona.voice.engine === "elevenlabs" ||
            persona.voice.engine === "xai";
          return (
            <View
              key={persona.id}
              testID={`voice-persona-${persona.id}`}
              style={styles.personaBlock}
            >
              <Text variant="titleSmall">{persona.name}</Text>
              <Text variant="bodySmall">
                {persona.voice.engine
                  ? `${engineLabel(persona.voice.engine)}${persona.voice.voiceId ? ` · ${persona.voice.voiceId}` : ""}`
                  : `Following the app default (${engineLabel(prefs.engine)})`}
              </Text>
              <NativeDropdown
                label="Engine"
                value={persona.voice.engine ?? "default"}
                options={[
                  {
                    value: "default",
                    label: "App default",
                    detail: engineLabel(prefs.engine),
                  },
                  ...VOICE_ENGINE_IDS.map((engine) => ({
                    value: engine,
                    label: engineLabel(engine),
                  })),
                ]}
                disabled={props.busy}
                onChange={(engine) =>
                  props.onBinding(persona.id, {
                    engine:
                      engine === "default" ? null : (engine as VoiceEngineId),
                    ...(engine === "default"
                      ? { connectionId: null, voiceId: null }
                      : {}),
                  })
                }
              />
              {cloud ? (
                <NativeDropdown
                  label="API connection"
                  value={persona.voice.connectionId ?? "choose"}
                  options={[
                    {
                      value: "choose",
                      label: "Choose a saved connection…",
                      detail: "Connections saved with an API key",
                    },
                    ...props.cloudConnections
                      .filter(
                        (connection) =>
                          connection.kind === persona.voice.engine,
                      )
                      .map((connection) => ({
                        value: connection.id,
                        label: connection.name,
                      })),
                  ]}
                  disabled={props.busy}
                  onChange={(connectionId) => {
                    if (connectionId === "choose") return;
                    props.onBinding(persona.id, { connectionId });
                  }}
                />
              ) : null}
              <NativeInput
                label="Voice identifier"
                accessibilityLabel={`Voice identifier for ${persona.name}`}
                value={
                  voiceDraft?.personaId === persona.id
                    ? voiceDraft.text
                    : (persona.voice.voiceId ?? "")
                }
                placeholder={
                  cloud ? "Provider voice id" : "Leave empty for the default"
                }
                onChangeText={(text) =>
                  setVoiceDraft({ personaId: persona.id, text })
                }
                onBlur={() => {
                  if (voiceDraft?.personaId !== persona.id) return;
                  setVoiceDraft(null);
                  if (voiceDraft.text !== (persona.voice.voiceId ?? ""))
                    props.onBinding(persona.id, { voiceId: voiceDraft.text });
                }}
                style={styles.input}
              />
            </View>
          );
        })}
      </NativeSurface>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { gap: 16, paddingBottom: 48 },
  phoneContent: { paddingHorizontal: 16, paddingTop: 12 },
  desktopContent: { paddingHorizontal: 24, paddingTop: 16, maxWidth: 720 },
  card: { gap: 12, padding: 16 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: { marginBottom: 0 },
  rowActions: { flexDirection: "row", alignItems: "center", gap: 4 },
  personaBlock: { gap: 8 },
});
