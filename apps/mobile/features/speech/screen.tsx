import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Linking, Platform, ScrollView, StyleSheet, View } from "react-native";
import { Icon, List, ProgressBar, Switch, Text, useTheme } from "react-native-paper";
import {
  NativeButton,
  NativeInput,
  NativeSurface,
  NativeDropdown,
  NativeActivity,
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";
import {
  mobileSpeech,
  speechModels,
  speechVoices,
} from "../../platform/speech";
import { describeError } from "../diagnostics/errors";
import { ErrorNotice } from "../diagnostics/error-notice";
import { traceLog } from "../diagnostics/trace-log";

/** Voice Studio surface for system dictation; the chat screen owns the state. */
export interface SpeechDictationProps {
  statusText: string;
  locales: readonly string[];
  selectedLocale: string;
  autosend: boolean;
  onLocaleChange(locale: string): void;
  onAutosendChange(value: boolean): void;
}

export interface SpeechPanelProps {
  onClose?: () => void;
  initialText?: string;
  dictation?: SpeechDictationProps;
}

export function SpeechPanel({
  onClose,
  initialText = "Hello. This voice is generated locally on your device. Your words stay private.",
  dictation,
}: SpeechPanelProps) {
  const theme = useTheme();
  const { phone } = useWorkspaceLayout();
  const scroll = useRef<ScrollView>(null);
  const activeOperation = useRef("Prepare offline voices");
  const actionSequence = useRef(0);
  const mounted = useRef(true);
  const state = useSyncExternalStore(
    mobileSpeech.subscribe,
    mobileSpeech.snapshot,
    mobileSpeech.snapshot,
  );
  const [text, setText] = useState(initialText);
  const [actionError, setActionError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const busy = !["idle", "error"].includes(state.phase);
  const stateError = useMemo(() => state.phase === "error"
    ? `${activeOperation.current} failed.\n${state.message}\n${speechRecovery(activeOperation.current)}`
    : "", [state.phase, state.message]);
  const hasError = !!actionError || state.phase === "error";
  const feedbackMessage = actionError || stateError || actionNotice || state.message;
  const voice = speechVoices.find((item) => item.id === state.selectedVoiceId)!;
  const installed = state.installedModelIds.includes(voice.modelId);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void mobileSpeech.refresh().catch((error: unknown) => {
      const message = describeError(error, {
        operation: "Load downloaded offline voice packs",
        recovery: speechRecovery("Reload offline voice packs"),
      });
      if (active) setActionError(message);
    });
    return () => {
      active = false;
      mounted.current = false;
      if (!["idle", "error"].includes(mobileSpeech.snapshot().phase))
        traceLog.event(activeOperation.current, "cancelled");
      actionSequence.current++;
      void mobileSpeech.stop().catch((cause: unknown) => {
        describeError(cause, { operation: "Stop offline speech on exit", recovery: "Reopen Voices and try Stop again." });
      });
    };
  }, []);
  useEffect(() => {
    if (phone && hasError) scroll.current?.scrollTo({ y: 0, animated: true });
  }, [phone, hasError, feedbackMessage]);
  const perform = (operation: string, work: () => Promise<void>) => {
    if (busy) traceLog.event(activeOperation.current, "cancelled");
    const sequence = ++actionSequence.current;
    activeOperation.current = operation;
    setActionError("");
    setActionNotice("");
    traceLog.event(operation, "start");
    void work().then(() => {
      if (sequence === actionSequence.current && mobileSpeech.snapshot().phase !== "error")
        traceLog.event(operation, "complete");
    }).catch((error: unknown) => {
      const message = describeError(error, { operation, recovery: speechRecovery(operation) });
      if (mounted.current && sequence === actionSequence.current) setActionError(message);
    });
  };

  if (phone) {
    const selectedModel = speechModels.find(
      (item) => item.id === voice.modelId,
    )!;
    return (
      <ScrollView
        ref={scroll}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.phoneContent}
      >
        <View style={styles.phoneIntro}>
          <Text
            accessibilityRole="header"
            accessibilityLabel="Voice studio"
            variant="headlineMedium"
            style={styles.phoneHeading}
          >
            Find your voice
          </Text>
          <Text
            variant="bodyLarge"
            style={{ color: theme.colors.onSurfaceVariant }}
          >
            Choose a voice and listen offline. Your words stay on this device.
          </Text>
          {Platform.OS === "web" ? (
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              Voice packs stay in this browser. Download them separately in the
              iPhone app.
            </Text>
          ) : null}
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Keep LocalLab open while downloading or reading aloud.
          </Text>
        </View>

        {busy ||
        (feedbackMessage &&
          feedbackMessage !==
            "Download a voice model once, then read aloud locally.") ? (
          <NativeSurface
            accessibilityLabel="Offline voice status"
            style={[
              styles.phoneStatusCard,
              {
                backgroundColor: hasError
                  ? theme.colors.errorContainer
                  : theme.colors.surfaceVariant,
              },
            ]}
          >
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
            {hasError ? <ErrorNotice message={feedbackMessage} /> : <Text
              accessibilityLiveRegion="polite"
              style={{
                color: hasError
                  ? theme.colors.onErrorContainer
                  : theme.colors.onSurfaceVariant,
              }}
            >
              {feedbackMessage}
              {state.progress === null
                ? ""
                : ` ${Math.round(state.progress * 100)}%`}
            </Text>}
            {state.progress !== null ? (
              <ProgressBar
                progress={state.progress}
                color={theme.colors.primary}
                style={styles.phoneProgress}
              />
            ) : null}
            {hasError ? (
              <>
                <NativeButton
                  accessibilityLabel="Reload offline voice packs"
                  mode="outlined"
                  disabled={busy}
                  onPress={() => perform("Reload offline voice packs", async () => {
                    await mobileSpeech.stop();
                    await mobileSpeech.refresh();
                    setActionNotice("Voice packs checked. Download a pack or try Read aloud again.");
                  })}
                >
                  Reload voice packs
                </NativeButton>
                {installed && mobileSpeech.repairRuntime ? (
                  <NativeButton
                    accessibilityLabel="Repair offline voices"
                    disabled={busy}
                    onPress={() => perform("Repair offline voices", () => mobileSpeech.repairRuntime!())}
                  >
                    Repair offline voices
                  </NativeButton>
                ) : null}
              </>
            ) : null}
          </NativeSurface>
        ) : null}

        <NativeSurface
          accessibilityLabel="Offline voice studio"
          style={styles.phoneStudioCard}
        >
          <NativeDropdown
            label="Offline voice"
            value={state.selectedVoiceId}
            options={speechVoices.map((item) => ({
              value: item.id,
              label: item.name,
              detail: `${item.description} · ${state.installedModelIds.includes(item.modelId) ? "Ready offline" : "Download voice pack to use"}`,
            }))}
            disabled={busy}
            onChange={(id) => perform("Select an offline voice", () => mobileSpeech.selectVoice(id))}
          />
          <View style={styles.phoneReadyRow}>
            <Icon
              source={installed ? "check-circle-outline" : "download-outline"}
              size={18}
              color={theme.colors.primary}
            />
            <Text
              variant="bodyMedium"
              style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}
            >
              {installed
                ? `${voice.name} is ready offline`
                : `${selectedModel.sizeLabel} voice pack`}
            </Text>
          </View>
          <NativeDropdown
            label="Voice speed"
            value={String(state.rate)}
            options={[0.75, 1, 1.15, 1.3, 1.5].map((rate) => ({
              value: String(rate),
              label: `${rate}×${rate === 1 ? " · Natural" : rate < 1 ? " · Unhurried" : " · Brisk"}`,
            }))}
            disabled={busy}
            onChange={(rate) =>
              perform("Save offline voice speed", () => mobileSpeech.setRate(Number(rate)))
            }
          />
          <NativeInput
            label="Text to read aloud"
            accessibilityLabel="Text to read aloud"
            value={text}
            onChangeText={setText}
            multiline
            style={styles.phoneTextInput}
          />
          {installed ? (
            <NativeButton
              accessibilityLabel="Read aloud using selected offline voice"
              mode="contained"
              icon="volume-high"
              disabled={busy || !text.trim()}
              onPress={() => perform("Preview offline speech", () => mobileSpeech.speak(text))}
              contentStyle={styles.phonePrimaryContent}
            >
              Read aloud
            </NativeButton>
          ) : (
            <>
              <NativeButton
                accessibilityLabel="Download selected voice pack"
                mode="contained"
                icon="download-outline"
                disabled={busy}
                onPress={() =>
                  perform("Download and install an offline voice pack", () => mobileSpeech.install(voice.modelId))
                }
                contentStyle={styles.phonePrimaryContent}
              >
                Get {voice.name}'s voice pack
              </NativeButton>
              <Text
                variant="bodySmall"
                style={{ color: theme.colors.onSurfaceVariant }}
              >
                Download {selectedModel.name} once to read aloud with{" "}
                {voice.name}.
              </Text>
            </>
          )}
          {busy || state.audioUri ? (
            <NativeButton
              accessibilityLabel="Stop offline speech"
              mode="outlined"
              icon="stop"
              onPress={() => perform("Stop offline speech", () => mobileSpeech.stop())}
            >
              {state.phase === "downloading" ? "Cancel download" : "Stop"}
            </NativeButton>
          ) : null}
        </NativeSurface>

        <View style={styles.phoneIntro}>
          <Text accessibilityRole="header" variant="titleLarge">
            Offline voice packs
          </Text>
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.onSurfaceVariant }}
          >
            One download can include several voices.
          </Text>
        </View>
        {speechModels.map((model) => (
          <NativeSurface
            key={model.id}
            accessibilityLabel={`${model.name} offline speech model`}
            style={styles.phonePackCard}
          >
            <View style={styles.phonePackHeader}>
              <View style={styles.phonePackTitle}>
                <Text variant="titleMedium">{model.name}</Text>
                <Text
                  variant="bodyMedium"
                  style={{ color: theme.colors.onSurfaceVariant }}
                >
                  {model.sizeLabel}
                </Text>
              </View>
              {state.installedModelIds.includes(model.id) ? (
                <Icon
                  source="check-circle"
                  size={22}
                  color={theme.colors.primary}
                />
              ) : null}
            </View>
            <View style={styles.phoneVoiceList}>
              {speechVoices
                .filter((item) => item.modelId === model.id)
                .map((item) => (
                  <List.Item
                    key={item.id}
                    title={item.name}
                    description={item.description}
                    descriptionNumberOfLines={2}
                    accessibilityRole="button"
                    accessibilityLabel={`Select ${item.name} offline voice`}
                    accessibilityState={{
                      selected: state.selectedVoiceId === item.id,
                      disabled: busy,
                    }}
                    onPress={() => {
                      if (!busy)
                        perform("Select an offline voice", () => mobileSpeech.selectVoice(item.id));
                    }}
                    right={(iconProps) => (
                      <List.Icon
                        {...iconProps}
                        icon={
                          state.selectedVoiceId === item.id
                            ? "radiobox-marked"
                            : "radiobox-blank"
                        }
                        color={
                          state.selectedVoiceId === item.id
                            ? theme.colors.primary
                            : theme.colors.onSurfaceVariant
                        }
                      />
                    )}
                    style={styles.phoneVoiceRow}
                  />
                ))}
            </View>
            <NativeButton
              accessibilityLabel={`Download ${model.name} speech model`}
              mode="outlined"
              disabled={
                busy ||
                (Platform.OS !== "web" &&
                  state.installedModelIds.includes(model.id))
              }
              onPress={() => perform("Download and install an offline voice pack", () => mobileSpeech.install(model.id))}
            >
              {state.installedModelIds.includes(model.id)
                ? Platform.OS === "web"
                  ? "Check download"
                  : "Downloaded"
                : "Download model"}
            </NativeButton>
            <List.Accordion
              title="Details and licence"
              accessibilityLabel={`${model.name} details and licence`}
              style={styles.phoneDisclosure}
              titleStyle={styles.phoneDisclosureTitle}
              theme={{ colors: { background: theme.colors.surface } }}
            >
              <View style={styles.phoneDetails}>
                <Text variant="bodyMedium">{model.license}</Text>
                <NativeButton
                  accessibilityLabel={`${model.name} voice licence`}
                  onPress={() => {
                    perform("Open an offline voice licence", async () => { await Linking.openURL(model.licenseUrl); });
                  }}
                >
                  Voice licence
                </NativeButton>
                {state.installedModelIds.includes(model.id) ? (
                  <NativeButton
                    accessibilityLabel={`Remove ${model.name} speech model`}
                    textColor={theme.colors.error}
                    disabled={busy}
                    onPress={() => perform("Remove an offline voice pack", () => mobileSpeech.remove(model.id))}
                  >
                    Remove download
                  </NativeButton>
                ) : null}
              </View>
            </List.Accordion>
          </NativeSurface>
        ))}
        {dictation ? (
          <NativeSurface
            accessibilityLabel="Dictation settings"
            style={styles.phoneHelpCard}
          >
            <View style={styles.phonePackHeader}>
              <Text variant="titleMedium">Dictation</Text>
            </View>
            <Text variant="bodyMedium" testID="speech-dictation-status">
              {dictation.statusText}
            </Text>
            {dictation.locales.length > 0 ? (
              <NativeDropdown
                label="Recognition language"
                value={dictation.selectedLocale || "system"}
                options={[
                  { value: "system", label: "System default" },
                  ...dictation.locales.map((locale) => ({
                    value: locale,
                    label: locale,
                  })),
                ]}
                onChange={(value) =>
                  dictation.onLocaleChange(value === "system" ? "" : value)
                }
              />
            ) : null}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Switch
                value={dictation.autosend}
                onValueChange={dictation.onAutosendChange}
                accessibilityLabel="Send the dictated message automatically"
              />
              <Text variant="bodyMedium">Send after dictation</Text>
            </View>
            <Text variant="bodySmall">
              Dictation uses the iPhone system speech recognizer. Sending
              after dictation is off unless you turn it on here.
            </Text>
          </NativeSurface>
        ) : null}
        <NativeSurface
          accessibilityLabel="Offline voice help"
          style={styles.phoneHelpCard}
        >
          <List.Accordion
            title="Voice help"
            accessibilityLabel="Show offline voice help"
            style={styles.phoneDisclosure}
            theme={{ colors: { background: theme.colors.surface } }}
          >
            <View style={styles.phoneDetails}>
              <Text variant="bodyMedium">
                Keep LocalLab open while downloading or reading aloud.
              </Text>
              {mobileSpeech.repairRuntime ? (
                <NativeButton
                  accessibilityLabel="Repair offline voices"
                  disabled={busy}
                  onPress={() => perform("Repair offline voices", () => mobileSpeech.repairRuntime!())}
                >
                  Repair offline voices
                </NativeButton>
              ) : null}
            </View>
          </List.Accordion>
        </NativeSurface>
        {onClose ? (
          <NativeButton
            accessibilityLabel="Back to chat from offline voices"
            onPress={onClose}
          >
            Back to chat
          </NativeButton>
        ) : null}
      </ScrollView>
    );
  }

  return (
    <ScrollView
      ref={scroll}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}
    >
      <Text variant="headlineSmall">Voice studio</Text>
      <Text>
        Neural speech runs on this device. Download a model once; your text is
        never sent to a speech service.
      </Text>
      {hasError ? (
        <View style={{ gap: 8 }}>
          <ErrorNotice message={feedbackMessage} />
          <NativeButton disabled={busy} accessibilityLabel="Reload offline voice packs" onPress={() => perform("Reload offline voice packs", async () => {
            await mobileSpeech.stop();
            await mobileSpeech.refresh();
            setActionNotice("Voice packs checked. Download a pack or try Read aloud again.");
          })}>Reload voice packs</NativeButton>
        </View>
      ) : null}
      <NativeDropdown
        label="Offline voice"
        value={state.selectedVoiceId}
        options={speechVoices.map((item) => ({
          value: item.id,
          label: item.name,
          detail: `${item.description} · ${state.installedModelIds.includes(item.modelId) ? "Ready offline" : "Download voice pack to use"}`,
        }))}
        disabled={busy}
        onChange={(id) => perform("Select an offline voice", () => mobileSpeech.selectVoice(id))}
      />
      <NativeDropdown
        label="Voice speed"
        value={String(state.rate)}
        options={[0.75, 1, 1.15, 1.3, 1.5].map((rate) => ({
          value: String(rate),
          label: `${rate}×${rate === 1 ? " · Natural" : rate < 1 ? " · Unhurried" : " · Brisk"}`,
        }))}
        disabled={busy}
        onChange={(rate) => perform("Save offline voice speed", () => mobileSpeech.setRate(Number(rate)))}
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
          onPress={() => perform("Preview offline speech", () => mobileSpeech.speak(text))}
        >
          Read aloud
        </NativeButton>
        <NativeButton
          accessibilityLabel="Stop offline speech"
          disabled={!busy && !state.audioUri}
          onPress={() => perform("Stop offline speech", () => mobileSpeech.stop())}
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
            onPress={() => perform("Download and install an offline voice pack", () => mobileSpeech.install(voice.modelId))}
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
      {!hasError ? <Text
        style={{
          color:
            hasError
              ? theme.colors.error
              : theme.colors.onSurface,
        }}
      >
        {feedbackMessage}
        {state.progress === null ? "" : ` ${Math.round(state.progress * 100)}%`}
      </Text> : null}
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
                    perform("Select an offline voice", () => mobileSpeech.selectVoice(item.id))
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
              onPress={() => perform("Download and install an offline voice pack", () => mobileSpeech.install(model.id))}
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
                onPress={() => perform("Remove an offline voice pack", () => mobileSpeech.remove(model.id))}
              >
                Remove download
              </NativeButton>
            )}
            <NativeButton
              accessibilityLabel={`${model.name} voice licence`}
              onPress={() => {
                perform("Open an offline voice licence", async () => { await Linking.openURL(model.licenseUrl); });
              }}
            >
              Voice licence
            </NativeButton>
          </View>
        </NativeSurface>
      ))}
      {dictation ? (
        <NativeSurface
          accessibilityLabel="Dictation settings"
          style={styles.card}
        >
          <Text variant="titleMedium">Dictation</Text>
          <Text testID="speech-dictation-status">{dictation.statusText}</Text>
          {dictation.locales.length > 0 ? (
            <NativeDropdown
              label="Recognition language"
              value={dictation.selectedLocale || "system"}
              options={[
                { value: "system", label: "System default" },
                ...dictation.locales.map((locale) => ({
                  value: locale,
                  label: locale,
                })),
              ]}
              onChange={(value) =>
                dictation.onLocaleChange(value === "system" ? "" : value)
              }
            />
          ) : null}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Switch
              value={dictation.autosend}
              onValueChange={dictation.onAutosendChange}
              accessibilityLabel="Send the dictated message automatically"
            />
            <Text>Send after dictation</Text>
          </View>
        </NativeSurface>
      ) : null}
      <Text>
        Keep this panel open while downloading or reading. Browser downloads
        stay in this browser profile; native downloads stay in the app.
      </Text>
      {mobileSpeech.repairRuntime ? (
        <NativeButton
          accessibilityLabel="Repair offline voices"
          disabled={busy}
          onPress={() => perform("Repair offline voices", () => mobileSpeech.repairRuntime!())}
        >
          Repair offline voices
        </NativeButton>
      ) : null}
    </ScrollView>
  );
}

function speechRecovery(operation: string): string {
  if (operation === "Download and install an offline voice pack")
    return "Check your internet connection and free device storage. Keep Voices open, then try the download again.";
  if (operation === "Preview offline speech")
    return "Check that the voice pack is installed, then try Read aloud again. If it still fails, reload voice packs or use Repair offline voices when available.";
  if (operation === "Remove an offline voice pack")
    return "Reload voice packs to check whether the download remains, then try Remove download again if needed.";
  if (operation === "Open an offline voice licence")
    return "Check your internet connection, then try Voice licence again.";
  if (operation === "Stop offline speech")
    return "Try Stop again. Close and reopen Voices if playback continues.";
  if (operation === "Repair offline voices")
    return "Check your internet connection and free storage, then try Repair offline voices again.";
  return "Tap Reload voice packs to check local speech storage, then retry the voice action.";
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14 },
  card: { padding: 14, gap: 10 },
  voice: { gap: 4 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  phoneContent: { padding: 20, gap: 20, paddingBottom: 32 },
  phoneIntro: { gap: 8 },
  phoneHeading: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  phoneStudioCard: { padding: 20, gap: 16 },
  phoneReadyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  phoneTextInput: { minHeight: 128 },
  phonePrimaryContent: { minHeight: 52 },
  phoneStatusCard: { padding: 16, gap: 12 },
  phoneProgress: { borderRadius: 8, height: 5 },
  phonePackCard: { padding: 18, gap: 12 },
  phonePackHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  phonePackTitle: { flex: 1, gap: 4 },
  phoneVoiceList: { gap: 4 },
  phoneVoiceRow: { minHeight: 64, paddingHorizontal: 0 },
  phoneDisclosure: { backgroundColor: "transparent", padding: 0 },
  phoneDisclosureTitle: { fontSize: 14, fontWeight: "600" },
  phoneDetails: { paddingBottom: 8, gap: 12 },
  phoneHelpCard: { padding: 12 },
});
