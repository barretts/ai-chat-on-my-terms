import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Platform,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  Button,
  Badge,
  Chip,
  Dialog,
  IconButton,
  Portal,
  Switch,
  useTheme,
  type MD3Theme,
} from "react-native-paper";
import type { ReactNode } from "react";
import { PhoneSheet } from "../../themes/phone-sheet";
import { ErrorNotice } from "../../diagnostics/error-notice";
import { describeError } from "../../diagnostics/errors";
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
  description?: string;
}

export interface AdvancedComposerProps {
  onSend: ComposerSendIntent;
  onSendError?: (message: string) => void;
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
  sendUnavailableReason?: string;
  /** Unsent text to restore when returning to a conversation. */
  initialDraft?: string;
  /** Called with the current unsent text so the host can keep it per conversation. */
  onDraftChange?: (draft: string) => void;
  toolsCollapsed?: boolean;
  onToolsCollapsedChange?: (collapsed: boolean) => void;
  onOpenWebSettings?: () => void;
}

export function AdvancedComposer({
  onSend,
  onSendError,
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
  sendUnavailableReason,
  initialDraft = "",
  onDraftChange,
  toolsCollapsed = false,
  onToolsCollapsedChange,
  onOpenWebSettings,
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
  const [phoneToolsOpen, setPhoneToolsOpen] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [phoneInputHeight, setPhoneInputHeight] = useState(46);
  const phoneInputRef = useRef<TextInput>(null);
  useLayoutEffect(() => {
    if (!layout.phone) return;
    if (Platform.OS === "web") {
      const input = phoneInputRef.current as unknown as {
        style?: { height: string };
        scrollHeight?: number;
      } | null;
      if (!input?.style) return;
      input.style.height = "auto";
      const height = Math.min(112, Math.max(46, input.scrollHeight ?? 46));
      input.style.height = `${height}px`;
      setPhoneInputHeight(height);
    } else if (!draft) {
      setPhoneInputHeight(46);
    }
  }, [draft, layout.phone, layout.width, layout.fontScale]);
  const busy = sending || isWorking || removingAttachment;

  useEffect(() => {
    let active = true;
    setPreferencesLoaded(!preferences);
    void preferences
      ?.load()
      .then((stored) => {
        if (active) setPrefs(resolveComposerPreferences(stored));
      })
      .catch((cause) => {
        if (active)
          setSendError(
            describeError(cause, {
              operation: "Load writing preferences",
              recovery:
                "Default writing options are active. Reopen Writing options to retry saving preferences.",
            }),
          );
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
      void preferences?.save(next).catch((cause) => {
        setSendError(
          describeError(cause, {
            operation: "Save writing preference",
            recovery:
              "Choose the option again to retry. It may reset after reopening the app.",
          }),
        );
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
      if (!payload || busy || sendUnavailableReason) return false;
      Keyboard.dismiss();
      setSending(true);
      setSendError("");
      try {
        const result = await onSend(payload);
        if (!sendWasAccepted(result)) {
          if (!onSendError)
            setSendError(
              "The response failed. Your draft is preserved; review the error and retry.",
            );
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
        const message = describeError(error, {
          operation: "Send message",
          recovery:
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "context-full"
              ? "Adjust the persona or Chat settings, then retry. Your draft is preserved."
              : "Check the selected connection or phone model, then retry. Your draft is preserved.",
        });
        if (onSendError) onSendError(message);
        else setSendError(message);
        return false;
      } finally {
        setSending(false);
      }
    },
    [
      attachments,
      busy,
      draft,
      onSend,
      onSendError,
      searchEnabled,
      selectedTools,
      sendUnavailableReason,
    ],
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
    <View
      style={[
        styles.container,
        prefs.mode === "shine" && styles.shine,
        layout.phone && {
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderTopWidth: 0,
          backgroundColor: theme.colors.background,
        },
      ]}
    >
      <Portal>
        <Dialog
          visible={optionsOpen}
          onDismiss={() => setOptionsOpen(false)}
          style={
            layout.phone
              ? { maxHeight: "85%" }
              : {
                  borderRadius: 0,
                  borderWidth: 2,
                  borderColor: theme.colors.outline,
                  backgroundColor: theme.colors.surface,
                  maxWidth: 480,
                  width: "90%",
                  alignSelf: "center",
                }
          }
        >
          <Dialog.Title
            style={
              layout.phone
                ? undefined
                : {
                    color: "white",
                    backgroundColor: "#59328b",
                    margin: 0,
                    padding: 14,
                    fontSize: 18,
                  }
            }
          >
            Writing options
          </Dialog.Title>
          <Dialog.Content style={{ paddingTop: 14 }}>
            {!searchUnavailableReason ? (
              <Text style={[styles.actionText, { marginBottom: 12 }]}>
                Web search sends this message to your selected search service.
                Page reading sends public links to Jina Reader. Both need
                internet; your model API key is never shared.
              </Text>
            ) : null}
            {layout.phone ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  minHeight: 44,
                  gap: 12,
                }}
              >
                <Text style={{ color: theme.colors.onSurface, fontSize: 16 }}>
                  Return sends message
                </Text>
                <Switch
                  accessibilityLabel="Return sends message"
                  value={prefs.returnSends}
                  disabled={!preferencesLoaded}
                  onValueChange={(value) =>
                    updatePreferences({ returnSends: value })
                  }
                />
              </View>
            ) : (
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
            )}
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

      {!toolsCollapsed &&
      prefs.starterSuggestions &&
      starters.length > 0 &&
      !layout.phone &&
      !layout.compact ? (
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
                  } catch (cause) {
                    setSendError(
                      describeError(cause, {
                        operation: "Remove draft attachment",
                        recovery:
                          "Tap the attachment again to retry removal. It remains attached until removal succeeds.",
                      }),
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

      <ComposerToolsPanel
        phone={layout.phone}
        visible={layout.phone ? phoneToolsOpen : !toolsCollapsed}
        onClose={() => setPhoneToolsOpen(false)}
      >
        <Chip
          accessibilityRole="button"
          accessibilityLabel="Writing options"
          accessibilityState={{ expanded: optionsOpen }}
          onPress={() => {
            Keyboard.dismiss();
            setPhoneToolsOpen(false);
            setOptionsOpen(!optionsOpen);
          }}
          style={layout.phone ? { minHeight: 44 } : styles.chip}
          icon="cog-outline"
        >
          {layout.phone ? "Writing options" : "Options"}
        </Chip>
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
          <ToolToggle
            phone={layout.phone}
            label="Web search"
            description="Find fresh information for this reply"
            selected={searchEnabled}
            disabled={busy}
            onPress={() => setSearchEnabled((value) => !value)}
            testID="composer-search-chip"
          />
        ) : null}
        {tools.map((tool) => {
          const selected = selectedTools.includes(tool.id);
          return (
            <ToolToggle
              phone={layout.phone}
              label={tool.label}
              {...(tool.description ? { description: tool.description } : {})}
              selected={selected}
              disabled={busy}
              key={tool.id}
              onPress={() =>
                setSelectedTools((current) =>
                  selected
                    ? current.filter((id) => id !== tool.id)
                    : [...current, tool.id],
                )
              }
              testID={`composer-tool-${tool.id}`}
            />
          );
        })}
        {onOpenWebSettings ? (
          <Button
            icon="web"
            accessibilityLabel="Web research settings"
            onPress={() => {
              setPhoneToolsOpen(false);
              onOpenWebSettings();
            }}
          >
            Web settings
          </Button>
        ) : null}
      </ComposerToolsPanel>

      {errorMessage || sendError ? (
        <ErrorNotice message={errorMessage || sendError} />
      ) : null}
      {layout.phone && sendUnavailableReason && draft.trim() ? (
        <Text
          style={{
            color: theme.colors.onSurfaceVariant,
            fontSize: 14,
            lineHeight: 20,
            paddingHorizontal: 8,
          }}
        >
          {sendUnavailableReason}
        </Text>
      ) : null}
      <View
        style={[
          styles.inputRow,
          layout.phone && {
            padding: 4,
            borderWidth: 1,
            borderColor: inputFocused
              ? theme.colors.primary
              : theme.colors.outlineVariant,
            borderRadius: 28,
            backgroundColor: theme.colors.surface,
            alignItems: "flex-end",
            gap: 4,
          },
        ]}
      >
        {layout.phone ? (
          <View>
            <IconButton
              icon="plus"
              accessibilityLabel="Show message tools"
              onPress={() => {
                Keyboard.dismiss();
                setPhoneToolsOpen(true);
              }}
              style={{ margin: 0, width: 44, height: 44 }}
            />
            {searchEnabled || selectedTools.length ? (
              <Badge
                size={18}
                accessibilityLabel={`${Number(searchEnabled) + selectedTools.length} message tools selected`}
                style={{
                  position: "absolute",
                  right: 1,
                  top: 1,
                  backgroundColor: theme.colors.primary,
                  color: theme.colors.onPrimary,
                }}
              >
                {Number(searchEnabled) + selectedTools.length}
              </Badge>
            ) : null}
          </View>
        ) : onToolsCollapsedChange ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              toolsCollapsed ? "Show message tools" : "Hide message tools"
            }
            accessibilityState={{ expanded: !toolsCollapsed }}
            onPress={() => onToolsCollapsedChange(!toolsCollapsed)}
            style={{
              minWidth: 44,
              minHeight: 44,
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Text style={{ color: theme.colors.primary, fontWeight: "700" }}>
              {toolsCollapsed ? "+" : "−"}
              {toolsCollapsed && (searchEnabled || selectedTools.length > 0)
                ? ` ${Number(searchEnabled) + selectedTools.length}`
                : ""}
            </Text>
          </Pressable>
        ) : null}
        {layout.phone ? (
          <TextInput
            ref={phoneInputRef}
            numberOfLines={Platform.OS === "web" ? 1 : undefined}
            multiline
            placeholder="Message"
            placeholderTextColor={theme.colors.onSurfaceVariant}
            selectionColor={theme.colors.primary}
            accessibilityLabel="Message"
            testID="advanced-composer-input"
            value={draft}
            onChangeText={setDraft}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            onContentSizeChange={(event) =>
              setPhoneInputHeight(
                Math.min(
                  112,
                  Math.max(46, event.nativeEvent.contentSize.height),
                ),
              )
            }
            editable={!isWorking}
            blurOnSubmit={prefs.returnSends}
            submitBehavior={prefs.returnSends ? "submit" : "newline"}
            returnKeyType={prefs.returnSends ? "send" : "default"}
            onSubmitEditing={() => {
              if (prefs.returnSends) void send();
            }}
            style={{
              flex: 1,
              minHeight: 46,
              maxHeight: 112,
              height: phoneInputHeight,
              paddingHorizontal: 4,
              paddingVertical: 11,
              color: theme.colors.onSurface,
              fontSize: 17,
              lineHeight: 24,
              fontFamily: theme.fonts.bodyLarge.fontFamily,
              letterSpacing: 0,
              textAlignVertical: "top",
              ...(Platform.OS === "web" ? { outlineWidth: 0 } : {}),
            }}
          />
        ) : (
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
        )}
        {layout.phone ? (
          <IconButton
            icon={isWorking && onStop ? "stop" : "arrow-up"}
            mode="contained"
            containerColor={theme.colors.primary}
            iconColor={theme.colors.onPrimary}
            style={{ borderRadius: 24, width: 44, height: 44, margin: 0 }}
            accessibilityLabel={
              isWorking && onStop ? "Stop response" : "Send message"
            }
            testID={
              isWorking && onStop
                ? "advanced-composer-stop"
                : "advanced-composer-send"
            }
            disabled={
              !(isWorking && onStop) &&
              (Boolean(sendUnavailableReason) ||
                busy ||
                (!draft.trim() && attachments.length === 0))
            }
            onPress={() => {
              if (isWorking && onStop) void onStop();
              else void send();
            }}
          />
        ) : isWorking && onStop ? (
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

function ToolToggle({
  phone,
  label,
  selected,
  disabled,
  onPress,
  testID,
  description,
}: {
  phone: boolean;
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
  testID: string;
  description?: string;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  if (phone)
    return (
      <View
        style={{
          width: "100%",
          minHeight: 48,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <View style={{ flex: 1, paddingRight: 12, gap: 4 }}>
          <Text style={{ color: theme.colors.onSurface, fontSize: 16 }}>
            {label}
          </Text>
          {description ? (
            <Text
              style={{
                color: theme.colors.onSurfaceVariant,
                fontSize: 13,
                lineHeight: 18,
              }}
            >
              {description}
            </Text>
          ) : null}
        </View>
        <Switch
          accessibilityLabel={label}
          value={selected}
          disabled={disabled}
          onValueChange={onPress}
          testID={testID}
        />
      </View>
    );
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, disabled }}
      aria-checked={selected}
      disabled={disabled}
      onPress={onPress}
      style={[styles.chip, selected && styles.selectedChip]}
      testID={testID}
    >
      <Text style={selected ? styles.selectedText : styles.chipText}>
        {label}
      </Text>
    </Pressable>
  );
}

function ComposerToolsPanel({
  phone,
  visible,
  onClose,
  children,
}: {
  phone: boolean;
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!phone)
    return visible ? (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ flexDirection: "row", gap: 6 }}
        style={{ flexGrow: 0 }}
      >
        {children}
      </ScrollView>
    ) : null;
  return (
    <PhoneSheet
      testID="message-tools"
      title="Message tools"
      visible={visible}
      onClose={onClose}
      closeLabel="Close message tools"
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {children}
      </View>
    </PhoneSheet>
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
  const { phone } = useWorkspaceLayout();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  if (phone)
    return (
      <Chip
        style={{ minHeight: 44 }}
        disabled={disabled}
        onPress={onPress}
        icon={label === "Attach" ? "paperclip" : "microphone"}
      >
        {label}
      </Chip>
    );
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
    chips: { flexDirection: "row", gap: 6 },
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
