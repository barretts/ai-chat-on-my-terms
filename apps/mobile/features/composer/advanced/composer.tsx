import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Dialog, Portal, useTheme, type MD3Theme } from "react-native-paper";
import {
  NativeButton,
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";
import {
  DEFAULT_COMPOSER_PREFERENCES,
  makeComposerPayload,
  resolveComposerPreferences,
  sendWasAccepted,
} from "./index";
import type {
  ComposerAttachment,
  ComposerMode,
  ComposerPreferenceStore,
  ComposerPreferences,
  ComposerSendIntent,
} from "./index";

export interface ComposerStarter {
  id: string;
  title: string;
  prompt: string;
}

export interface ComposerTool {
  id: string;
  label: string;
}

export interface AdvancedComposerProps {
  onSend: ComposerSendIntent;
  preferences?: ComposerPreferenceStore;
  starters?: readonly ComposerStarter[];
  tools?: readonly ComposerTool[];
  onPickAttachment?: () => Promise<ComposerAttachment | null>;
  onRemoveAttachment?: (attachment: ComposerAttachment) => Promise<void> | void;
  searchUnavailableReason?: string;
  onDictate?: () => Promise<string | null>;
  onStop?: () => void | Promise<void>;
  isWorking?: boolean;
  errorMessage?: string;
  /** Unsent text to restore when returning to a conversation. */
  initialDraft?: string;
  /** Called with the current unsent text so the host can keep it per conversation. */
  onDraftChange?: (draft: string) => void;
}

export function AdvancedComposer({
  onSend,
  preferences,
  starters = [],
  tools = [],
  onPickAttachment,
  onRemoveAttachment,
  searchUnavailableReason,
  onDictate,
  onStop,
  isWorking = false,
  errorMessage,
  initialDraft = "",
  onDraftChange,
}: AdvancedComposerProps) {
  const theme = useTheme();
  const layout = useWorkspaceLayout();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  const [prefs, setPrefs] = useState<ComposerPreferences>(
    DEFAULT_COMPOSER_PREFERENCES,
  );
  const [preferencesLoaded, setPreferencesLoaded] = useState(!preferences);
  const [draft, setDraft] = useState(initialDraft);
  const draftListener = useRef(onDraftChange);
  draftListener.current = onDraftChange;
  useEffect(() => {
    draftListener.current?.(draft);
  }, [draft]);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [searchEnabled, setSearchEnabled] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [removingAttachment, setRemovingAttachment] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const busy = sending || isWorking || removingAttachment;

  useEffect(() => {
    let active = true;
    setPreferencesLoaded(!preferences);
    void preferences
      ?.load()
      .then((stored) => {
        if (active) setPrefs(resolveComposerPreferences(stored));
      })
      .catch(() => {
        // Defaults keep the composer usable when preference storage is unavailable.
      })
      .finally(() => {
        if (active) setPreferencesLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [preferences]);

  const updatePreferences = useCallback(
    (update: Partial<ComposerPreferences>) => {
      const next = { ...prefs, ...update };
      setPrefs(next);
      void preferences?.save(next).catch(() => {
        setSendError("Composer preference could not be saved.");
      });
    },
    [prefs, preferences],
  );

  const send = useCallback(
    async (overrideText?: string) => {
      const payload = makeComposerPayload(
        overrideText ?? draft,
        attachments,
        searchEnabled,
        selectedTools,
      );
      if (!payload || busy) return false;
      Keyboard.dismiss();
      setSending(true);
      setSendError("");
      try {
        const result = await onSend(payload);
        if (!sendWasAccepted(result)) {
          setSendError("Message was not accepted.");
          return false;
        }
        setDraft((current) =>
          current === (overrideText ?? draft) ? "" : current,
        );
        setAttachments((current) =>
          current.filter(
            (item) => !payload.attachments.some((sent) => sent.id === item.id),
          ),
        );
        return true;
      } catch (error) {
        setSendError(
          error instanceof Error ? error.message : "Message could not be sent.",
        );
        return false;
      } finally {
        setSending(false);
      }
    },
    [attachments, busy, draft, onSend, searchEnabled, selectedTools],
  );

  const addAttachment = useCallback(async () => {
    if (!onPickAttachment || busy) return;
    const selected = await onPickAttachment();
    if (selected) {
      setAttachments((current) =>
        current.some((item) => item.id === selected.id)
          ? current
          : [...current, selected],
      );
    }
  }, [busy, onPickAttachment]);

  const dictate = useCallback(async () => {
    if (!onDictate || busy) return;
    const text = await onDictate();
    if (text) setDraft((current) => (current ? `${current} ${text}` : text));
  }, [busy, onDictate]);

  const selectMode = (mode: ComposerMode) => updatePreferences({ mode });
  const sendStarter = (prompt: string) => {
    setDraft(prompt);
    void send(prompt);
  };

  return (
    <View style={[styles.container, prefs.mode === "shine" && styles.shine]}>
      <Portal>
        <Dialog
          visible={optionsOpen}
          onDismiss={() => setOptionsOpen(false)}
          style={{
            borderRadius: 0,
            borderWidth: 2,
            borderColor: theme.colors.outline,
            backgroundColor: theme.colors.surface,
            maxWidth: 480,
            width: "90%",
            alignSelf: "center",
          }}
        >
          <Dialog.Title
            style={{
              color: "white",
              backgroundColor: "#59328b",
              margin: 0,
              padding: 14,
              fontSize: 18,
            }}
          >
            Writing options
          </Dialog.Title>
          <Dialog.Content style={{ paddingTop: 14 }}>
            <View style={styles.toolbar}>
              <View style={styles.segment} accessibilityLabel="Composer mode">
                <ModeButton
                  label="Shine"
                  selected={prefs.mode === "shine"}
                  disabled={!preferencesLoaded}
                  onPress={() => selectMode("shine")}
                />
                <ModeButton
                  label="Compact"
                  selected={prefs.mode === "compact"}
                  disabled={!preferencesLoaded}
                  onPress={() => selectMode("compact")}
                />
              </View>
              <Pressable
                accessibilityRole="switch"
                accessibilityState={{ checked: prefs.starterSuggestions }}
                aria-checked={prefs.starterSuggestions}
                disabled={!preferencesLoaded}
                onPress={() =>
                  updatePreferences({
                    starterSuggestions: !prefs.starterSuggestions,
                  })
                }
                testID="composer-starters-toggle"
                style={styles.optionToggle}
              >
                <Text style={styles.actionText}>
                  {prefs.starterSuggestions ? "Starters on" : "Starters off"}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="switch"
                accessibilityState={{ checked: prefs.returnSends }}
                aria-checked={prefs.returnSends}
                disabled={!preferencesLoaded}
                onPress={() =>
                  updatePreferences({ returnSends: !prefs.returnSends })
                }
                testID="composer-return-toggle"
                style={styles.optionToggle}
              >
                <Text style={styles.actionText}>
                  {prefs.returnSends ? "Return sends" : "Return adds line"}
                </Text>
              </Pressable>
            </View>
          </Dialog.Content>
          <Dialog.Actions>
            <NativeButton
              accessibilityLabel="Done with writing options"
              onPress={() => setOptionsOpen(false)}
            >
              Done
            </NativeButton>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      {prefs.starterSuggestions && starters.length > 0 && !layout.compact ? (
        <View style={styles.chips}>
          {starters.map((starter) => (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              key={starter.id}
              onPress={() => sendStarter(starter.prompt)}
              style={styles.chip}
              testID={`composer-starter-${starter.id}`}
            >
              <Text style={styles.chipText}>{starter.title}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {attachments.length > 0 ? (
        <View style={styles.chips}>
          {attachments.map((attachment) => (
            <Pressable
              accessibilityLabel={`Remove ${attachment.name}`}
              accessibilityRole="button"
              disabled={busy}
              key={attachment.id}
              onPress={() =>
                void (async () => {
                  setRemovingAttachment(true);
                  try {
                    await onRemoveAttachment?.(attachment);
                    setAttachments((current) =>
                      current.filter((item) => item.id !== attachment.id),
                    );
                  } catch {
                    setSendError(
                      "The attachment could not be removed. Try again.",
                    );
                  } finally {
                    setRemovingAttachment(false);
                  }
                })()
              }
              style={styles.chip}
            >
              <Text style={styles.chipText}>{attachment.name} ×</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={styles.chips}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Writing options"
          accessibilityState={{ expanded: optionsOpen }}
          onPress={() => {
            Keyboard.dismiss();
            setOptionsOpen(!optionsOpen);
          }}
          style={styles.chip}
        >
          <Text style={styles.chipText}>Options {optionsOpen ? "▴" : "▾"}</Text>
        </Pressable>
        {onPickAttachment ? (
          <ActionChip
            label="Attach"
            disabled={busy}
            onPress={() => void addAttachment()}
          />
        ) : null}
        {onDictate ? (
          <ActionChip
            label="Dictate"
            disabled={busy}
            onPress={() => void dictate()}
          />
        ) : null}
        {!searchUnavailableReason ? (
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: searchEnabled }}
            aria-checked={searchEnabled}
            disabled={Boolean(searchUnavailableReason) || busy}
            onPress={() => setSearchEnabled((value) => !value)}
            style={[styles.chip, searchEnabled && styles.selectedChip]}
            testID="composer-search-chip"
          >
            <Text style={searchEnabled ? styles.selectedText : styles.chipText}>
              Search
            </Text>
          </Pressable>
        ) : null}
        {tools.map((tool) => {
          const selected = selectedTools.includes(tool.id);
          return (
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: selected }}
              aria-checked={selected}
              key={tool.id}
              onPress={() =>
                setSelectedTools((current) =>
                  selected
                    ? current.filter((id) => id !== tool.id)
                    : [...current, tool.id],
                )
              }
              style={[styles.chip, selected && styles.selectedChip]}
              testID={`composer-tool-${tool.id}`}
            >
              <Text style={selected ? styles.selectedText : styles.chipText}>
                {tool.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {errorMessage || sendError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {errorMessage || sendError}
        </Text>
      ) : null}
      <View style={styles.inputRow}>
        <TextInput
          accessibilityLabel="Message"
          // React Native Web uses blurOnSubmit; native uses the explicit submission behavior.
          blurOnSubmit={prefs.returnSends}
          submitBehavior={
            Platform.OS === "web"
              ? undefined
              : prefs.returnSends
                ? "submit"
                : "newline"
          }
          editable={!isWorking}
          multiline
          onChangeText={setDraft}
          onSubmitEditing={() => {
            if (prefs.returnSends) void send();
          }}
          placeholder="Message"
          placeholderTextColor={theme.colors.onSurfaceVariant}
          selectionColor={theme.colors.primary}
          returnKeyType={prefs.returnSends ? "send" : "default"}
          style={[
            styles.input,
            prefs.mode === "compact" && styles.compactInput,
          ]}
          testID="advanced-composer-input"
          value={draft}
        />
        {isWorking && onStop ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop response"
            onPress={() => void onStop()}
            style={styles.sendButton}
            testID="advanced-composer-stop"
          >
            <Text style={styles.sendText}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityState={{
              disabled: busy || (!draft.trim() && attachments.length === 0),
              busy: sending,
            }}
            disabled={busy || (!draft.trim() && attachments.length === 0)}
            onPress={() => void send()}
            style={[styles.sendButton, busy && styles.disabled]}
            testID="advanced-composer-send"
          >
            <Text style={styles.sendText}>{sending ? "Sending…" : "Send"}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function ModeButton({
  label,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      aria-checked={selected}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.modeButton,
        selected && styles.selectedChip,
        disabled && styles.disabled,
      ]}
    >
      <Text style={selected ? styles.selectedText : styles.chipText}>
        {label}
      </Text>
    </Pressable>
  );
}

function ActionChip({
  label,
  disabled = false,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.chip, disabled && styles.disabled]}
    >
      <Text style={styles.chipText}>{label}</Text>
    </Pressable>
  );
}

const createStyles = (colors: MD3Theme["colors"]) =>
  StyleSheet.create({
    container: {
      paddingHorizontal: 12,
      paddingTop: 8,
      paddingBottom: 6,
      gap: 6,
      borderTopWidth: 2,
      borderTopColor: colors.outline,
      backgroundColor: colors.surface,
    },
    shine: {
      backgroundColor: colors.elevation.level1,
    },
    toolbar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flexWrap: "wrap",
    },
    segment: {
      flexDirection: "row",
      gap: 2,
      padding: 3,
      borderRadius: 0,
      backgroundColor: colors.surfaceVariant,
    },
    modeButton: {
      borderRadius: 0,
      minHeight: 40,
      justifyContent: "center",
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    actionText: { color: colors.onSurfaceVariant, fontSize: 12 },
    optionToggle: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: 10,
      borderWidth: 1,
      borderColor: colors.outline,
    },
    chipText: { color: colors.onSurface },
    selectedText: { color: colors.onSecondaryContainer },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    chip: {
      borderWidth: 1,
      borderColor: colors.outline,
      borderRadius: 0,
      minHeight: 40,
      justifyContent: "center",
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    selectedChip: {
      backgroundColor: colors.secondaryContainer,
      borderColor: colors.secondary,
    },
    inputRow: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 8,
      borderWidth: 1,
      borderColor: colors.outline,
      backgroundColor: colors.surface,
      borderRadius: 0,
      padding: 6,
    },
    input: {
      flex: 1,
      minHeight: 42,
      maxHeight: 128,
      paddingHorizontal: 8,
      paddingVertical: 9,
      color: colors.onSurface,
      fontSize: 16,
    },
    compactInput: {
      minHeight: 36,
      maxHeight: 88,
      paddingVertical: 5,
      fontSize: 15,
    },
    sendButton: {
      minHeight: 44,
      justifyContent: "center",
      borderRadius: 0,
      backgroundColor: colors.primary,
      paddingHorizontal: 14,
    },
    sendText: { color: colors.onPrimary, fontWeight: "600" },
    disabled: { opacity: 0.45 },
    error: { color: colors.error, paddingHorizontal: 8 },
  });
