import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from "react-native";
import { Text, useTheme, type MD3Theme } from "react-native-paper";
import { NativeButton } from "@locallab/ui-native-primitives";
import { useAppTheme } from "../themes/provider";
import type { CapabilityMap } from "@locallab/contracts/ports";
import type { ContextPolicy } from "@locallab/context";
import {
  EMPTY_PRESETS,
  PARAMETER_CONTROLS,
  resetModelToGlobal,
  resetScopeValue,
  resolveSettings,
  scopeChangeNeedsContextReload,
  updateScopeValue,
} from "./index";
import type {
  ChatAppearance,
  ChatSettingsStore,
  SettingsPresets,
  SettingsScope,
} from "./index";

const SCOPES: readonly { id: SettingsScope; label: string }[] = [
  { id: "global", label: "Global" },
  { id: "model", label: "Model" },
  { id: "persona", label: "Persona" },
  { id: "chat", label: "This chat" },
];

export interface ChatSettingsScreenProps {
  conversationId: string;
  modelId?: string;
  personaId?: string;
  store: ChatSettingsStore;
  capabilities: CapabilityMap;
  personaEnabled?: boolean;
  onContextReload?: () => Promise<void> | void;
  onCompact?: (policy: ContextPolicy) => Promise<void> | void;
  onRetry?: () => Promise<void> | void;
  retryUnavailableReason?: string;
  /** Lets the host await the latest durable edit before dispatching a request. */
  onPendingWrites?: (completion: Promise<void>) => void;
  contextPolicy?: ContextPolicy;
  summaryUnavailableReason?: string;
  compactActionLabel?: string;
  contextProgress?: string;
}

export function ChatSettingsScreen(props: ChatSettingsScreenProps) {
  const paperTheme = useTheme();
  const styles = useMemo(() => createStyles(paperTheme), [paperTheme]);
  const { themePreference, setThemePreference } = useAppTheme();
  const [presets, setPresets] = useState<SettingsPresets>(EMPTY_PRESETS);
  const [appearance, setAppearance] = useState<ChatAppearance>({});
  const [scope, setScope] = useState<SettingsScope>("chat");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [contextPolicy, setContextPolicy] = useState<ContextPolicy>(
    props.contextPolicy ?? "roll",
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const presetsRef = useRef<SettingsPresets>(EMPTY_PRESETS);
  const appearanceRef = useRef<ChatAppearance>({});
  const editVersion = useRef(0);
  const pendingWrites = useRef(0);
  const writes = useRef(Promise.resolve());
  const mounted = useRef(true);
  const numericCommits = useRef(new Map<string, () => void>());
  const commitNumericInputs = () => {
    for (const commit of numericCommits.current.values()) commit();
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (props.contextPolicy !== undefined)
      setContextPolicy(props.contextPolicy);
  }, [props.contextPolicy]);
  const identity = useMemo(
    () => ({
      ...(props.modelId ? { modelId: props.modelId } : {}),
      ...(props.personaId ? { personaId: props.personaId } : {}),
    }),
    [props.modelId, props.personaId],
  );
  useEffect(() => {
    let live = true;
    const version = editVersion.current;
    void Promise.all([
      props.store.loadPresets(identity),
      props.store.loadAppearance(props.conversationId),
    ])
      .then(([saved, style]) => {
        if (!live || version !== editVersion.current || pendingWrites.current)
          return;
        const next = { ...EMPTY_PRESETS, ...saved };
        presetsRef.current = next;
        appearanceRef.current = style;
        setPresets(next);
        setAppearance(style);
      })
      .catch(() => {
        if (live) setMessage("Saved chat settings could not be loaded.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [props.store, props.conversationId, identity]);

  const resolved = useMemo(
    () =>
      resolveSettings({
        presets,
        personaEnabled: props.personaEnabled ?? true,
        capabilities: props.capabilities,
      }),
    [presets, props.personaEnabled, props.capabilities],
  );
  const displayed = useMemo(() => {
    const selected = SCOPES.findIndex((item) => item.id === scope);
    const visiblePresets = { ...presets };
    SCOPES.forEach((item, index) => {
      if (index > selected) visiblePresets[item.id] = EMPTY_PRESETS[item.id];
    });
    return resolveSettings({
      presets: visiblePresets,
      personaEnabled: scope === "persona" || (props.personaEnabled ?? true),
      capabilities: props.capabilities,
    });
  }, [presets, scope, props.personaEnabled, props.capabilities]);

  const enqueueWrite = (work: () => Promise<void>) => {
    pendingWrites.current += 1;
    setSaving(true);
    const completion = writes.current.then(work).finally(() => {
      pendingWrites.current -= 1;
      if (mounted.current && !pendingWrites.current) setSaving(false);
    });
    writes.current = completion.catch(() => undefined);
    props.onPendingWrites?.(writes.current);
  };

  const persistPresets = useCallback(
    async (next: SettingsPresets) => {
      const previous = presetsRef.current;
      const before = resolveSettings({
        presets: previous,
        personaEnabled: props.personaEnabled ?? true,
        capabilities: props.capabilities,
      }).effective;
      const after = resolveSettings({
        presets: next,
        personaEnabled: props.personaEnabled ?? true,
        capabilities: props.capabilities,
      }).effective;
      presetsRef.current = next;
      const version = ++editVersion.current;
      setPresets(next);
      setMessage("");
      enqueueWrite(async () => {
        try {
          await props.store.savePreset(
            scope,
            next[scope].explicitlySet,
            identity,
          );
          if (
            mounted.current &&
            version === editVersion.current &&
            scopeChangeNeedsContextReload(before, after)
          ) {
            setMessage(
              "Context settings changed. Reload model context to apply them.",
            );
          }
        } catch {
          if (mounted.current && version === editVersion.current) {
            presetsRef.current = previous;
            setPresets(previous);
            setMessage("Setting could not be saved.");
          }
        }
      });
    },
    [
      presets,
      props.capabilities,
      props.personaEnabled,
      props.store,
      identity,
      scope,
    ],
  );

  const setValue = (key: string, value: unknown) => {
    void persistPresets(
      updateScopeValue(presetsRef.current, scope, key, value),
    );
  };
  const resetValue = (key: string) => {
    numericCommits.current.get(`${scope}:${key}`)?.();
    void persistPresets(resetScopeValue(presetsRef.current, scope, key));
  };
  const runAction = async (
    action: () => Promise<void> | void,
    fallback: string,
  ) => {
    setBusy(true);
    setMessage("");
    try {
      commitNumericInputs();
      await writes.current;
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : fallback);
    } finally {
      setBusy(false);
    }
  };
  const saveAppearance = async (next: ChatAppearance) => {
    const previous = appearanceRef.current;
    appearanceRef.current = next;
    const version = ++editVersion.current;
    setAppearance(next);
    enqueueWrite(async () => {
      try {
        await props.store.saveAppearance(props.conversationId, next);
      } catch {
        if (mounted.current && version === editVersion.current) {
          appearanceRef.current = previous;
          setAppearance(previous);
          setMessage("Chat appearance could not be saved.");
        }
      }
    });
  };

  const resetModel = async () => {
    commitNumericInputs();
    const result = resetModelToGlobal(presetsRef.current);
    await persistPresets(result.presets);
  };

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[
        styles.page,
        { backgroundColor: paperTheme.colors.background },
      ]}
    >
      <Text accessibilityRole="header" style={styles.title}>
        Chat and model settings
      </Text>
      <Text style={styles.description}>
        Choose which settings apply here. Chat overrides take priority over
        Persona, Model, and Global values.
      </Text>
      <Text accessibilityLiveRegion="polite" style={styles.saveStatus}>
        {loading
          ? "Loading saved settings..."
          : saving
            ? "Saving settings..."
            : "Changes saved"}
      </Text>
      <Text accessibilityRole="header" style={styles.section}>
        App theme
      </Text>
      <View style={styles.row}>
        {(["system", "light", "dark"] as const).map((value) => (
          <NativeButton
            key={value}
            accessibilityLabel={`Use ${value} app theme`}
            accessibilityState={{ selected: themePreference === value }}
            mode={themePreference === value ? "contained" : "outlined"}
            onPress={() =>
              void setThemePreference(value).catch(() =>
                setMessage("The app theme could not be saved. Try again."),
              )
            }
          >
            {value[0]!.toUpperCase() + value.slice(1)}
          </NativeButton>
        ))}
      </View>
      <View style={styles.row}>
        {SCOPES.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="tab"
            aria-selected={scope === item.id}
            accessibilityState={{
              selected: scope === item.id,
              disabled:
                item.id === "model"
                  ? !props.modelId
                  : item.id === "persona"
                    ? !props.personaId || props.personaEnabled === false
                    : false,
            }}
            disabled={
              item.id === "model"
                ? !props.modelId
                : item.id === "persona"
                  ? !props.personaId || props.personaEnabled === false
                  : false
            }
            onPress={() => {
              commitNumericInputs();
              setScope(item.id);
            }}
            style={[styles.scope, scope === item.id && styles.selected]}
          >
            <Text
              style={[
                styles.scopeText,
                scope === item.id && styles.selectedText,
              ]}
            >
              {item.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {props.personaEnabled === false ? (
        <Text style={styles.hint}>
          Default uses global and model settings. Select a custom Persona to
          edit Persona settings.
        </Text>
      ) : null}
      {scope === "model" && (
        <Pressable
          accessibilityRole="button"
          onPress={() => void resetModel()}
          disabled={!props.modelId || busy}
          style={styles.secondary}
        >
          <Text>Use Global params</Text>
        </Pressable>
      )}
      {PARAMETER_CONTROLS.map((control) => {
        const decision =
          resolved.capabilities[control.capability] ??
          resolved.capabilities[control.key];
        if (decision && !decision.visible) return null;
        const enabled =
          !loading &&
          !(scope === "persona" && props.personaEnabled === false) &&
          (decision?.enabled ?? false);
        const value = displayed.effective[control.key];
        const origin = displayed.origins[control.key];
        const active = Object.prototype.hasOwnProperty.call(
          presets[scope].explicitlySet,
          control.key,
        );
        return (
          <View key={control.key} style={styles.card}>
            <View style={styles.heading}>
              <Text style={styles.label}>{control.label}</Text>
              <Text style={styles.origin}>
                {origin
                  ? `From ${SCOPES.find((item) => item.id === origin)?.label}`
                  : "Default"}
              </Text>
            </View>
            {!decision || decision.value !== "yes" ? (
              <Text style={styles.hint}>
                {decision?.explanation ??
                  "Support is not confirmed for this model; saved values will not be sent."}
              </Text>
            ) : null}
            {control.kind === "boolean" ? (
              <View style={styles.row}>
                <Text style={styles.valueText}>
                  {typeof value === "boolean"
                    ? value
                      ? "On"
                      : "Off"
                    : "Use inherited value"}
                </Text>
                <Switch
                  accessibilityLabel={control.label}
                  value={typeof value === "boolean" ? value : false}
                  disabled={!enabled}
                  onValueChange={(next) => setValue(control.key, next)}
                />
              </View>
            ) : null}
            {control.kind === "number" ? (
              <NumericSettingInput
                key={`${scope}:${control.key}`}
                label={control.label}
                enabled={enabled}
                value={value}
                minimum={control.min ?? 0}
                maximum={control.max ?? Number.MAX_SAFE_INTEGER}
                registerCommit={(commit) => {
                  const key = `${scope}:${control.key}`;
                  numericCommits.current.set(key, commit);
                  return () => {
                    if (numericCommits.current.get(key) === commit)
                      numericCommits.current.delete(key);
                  };
                }}
                onCommit={(next) =>
                  next === undefined
                    ? resetValue(control.key)
                    : setValue(control.key, next)
                }
                onInvalid={() =>
                  setMessage(`Enter a number for ${control.label}.`)
                }
                style={[styles.input, !enabled && styles.disabled]}
              />
            ) : null}
            {control.kind === "text" ? (
              <TextInput
                accessibilityLabel={control.label}
                multiline={control.key === "systemPrompt"}
                editable={enabled}
                value={typeof value === "string" ? value : ""}
                onChangeText={(text) => setValue(control.key, text)}
                style={[
                  styles.input,
                  control.key === "systemPrompt" && styles.promptInput,
                ]}
              />
            ) : null}
            {control.kind === "choice" ? (
              <View style={styles.row}>
                {control.choices?.map((choice) => (
                  <Pressable
                    key={choice}
                    accessibilityRole="button"
                    accessibilityLabel={`${control.label}: ${choice}${value === choice ? ", selected" : ""}`}
                    accessibilityState={{ selected: value === choice }}
                    disabled={!enabled}
                    onPress={() => setValue(control.key, choice)}
                    style={[
                      styles.choice,
                      value === choice && styles.selected,
                      !enabled && styles.disabled,
                    ]}
                  >
                    <Text
                      style={value === choice ? styles.selectedText : undefined}
                    >
                      {choice}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${control.label}: Reset this value`}
              disabled={loading || !active}
              onPress={() => resetValue(control.key)}
            >
              <Text style={[styles.reset, !active && styles.disabled]}>
                Reset this value
              </Text>
            </Pressable>
          </View>
        );
      })}

      <Text accessibilityRole="header" style={styles.section}>
        Chat appearance
      </Text>
      <View style={styles.card}>
        {appearance.avatar ? (
          <View
            accessibilityLabel={`Chat avatar initials preview ${appearance.avatar}`}
            style={styles.avatar}
          >
            <Text style={styles.avatarText}>
              {appearance.avatar.slice(0, 2).toUpperCase()}
            </Text>
          </View>
        ) : null}
        <Text style={styles.label}>Background color</Text>
        <View style={styles.row}>
          {["#FAF9F6", "#EAF2F0", "#F4EAE3", "#EAEFFA"].map((color) => (
            <Pressable
              key={color}
              accessibilityRole="button"
              accessibilityLabel={`Background ${color}`}
              accessibilityState={{ selected: appearance.background === color }}
              disabled={loading}
              onPress={() =>
                void saveAppearance({
                  ...appearanceRef.current,
                  background: color,
                })
              }
              style={[
                styles.swatch,
                { backgroundColor: color },
                appearance.background === color && styles.swatchSelected,
              ]}
            />
          ))}
        </View>
        <TextInput
          accessibilityLabel="Chat avatar initials"
          placeholder="Up to 2 initials"
          maxLength={2}
          value={appearance.avatar ?? ""}
          editable={!loading}
          onChangeText={(avatar) => {
            const next = { ...appearanceRef.current };
            if (avatar) next.avatar = avatar;
            else delete next.avatar;
            void saveAppearance(next);
          }}
          style={styles.input}
        />
      </View>

      <Text accessibilityRole="header" style={styles.section}>
        Context recovery
      </Text>
      <View style={styles.card}>
        <Text style={styles.hint}>
          Compaction creates a request projection; saved transcript history is
          retained.
        </Text>
        <View style={styles.row}>
          {(["roll", "cut-middle", "summarize"] as const).map((policy) => (
            <Pressable
              key={policy}
              accessibilityRole="button"
              aria-pressed={contextPolicy === policy}
              accessibilityState={{ selected: contextPolicy === policy }}
              disabled={
                busy ||
                (policy === "summarize" && !!props.summaryUnavailableReason)
              }
              onPress={() => setContextPolicy(policy)}
              style={[
                styles.choice,
                contextPolicy === policy && styles.selected,
              ]}
            >
              <Text
                style={
                  contextPolicy === policy ? styles.selectedText : undefined
                }
              >
                {policy === "cut-middle"
                  ? "Cut middle"
                  : policy[0]!.toUpperCase() + policy.slice(1)}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            disabled={busy || !props.onCompact}
            onPress={() =>
              void runAction(
                () => props.onCompact?.(contextPolicy),
                "Could not compact context.",
              )
            }
            style={styles.secondary}
          >
            <Text>{props.compactActionLabel ?? "Compact and retry"}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy || !props.onContextReload}
            onPress={() =>
              void runAction(
                () => props.onContextReload?.(),
                "Could not reload context.",
              )
            }
            style={styles.secondary}
          >
            <Text>Reload context</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy || !props.onRetry || !!props.retryUnavailableReason}
            onPress={() =>
              void runAction(() => props.onRetry?.(), "Retry failed.")
            }
            style={styles.secondary}
          >
            <Text>Retry request</Text>
          </Pressable>
        </View>
        {props.summaryUnavailableReason ? (
          <Text style={styles.hint}>{props.summaryUnavailableReason}</Text>
        ) : null}
        {props.retryUnavailableReason ? (
          <Text style={styles.hint}>{props.retryUnavailableReason}</Text>
        ) : null}
        {props.contextProgress ? (
          <Text accessibilityLiveRegion="polite" style={styles.hint}>
            {props.contextProgress}
          </Text>
        ) : null}
      </View>
      {message ? (
        <Text accessibilityLiveRegion="polite" style={styles.message}>
          {message}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function NumericSettingInput(props: {
  label: string;
  enabled: boolean;
  value: unknown;
  minimum: number;
  maximum: number;
  onCommit: (value: number | undefined) => void;
  onInvalid: () => void;
  registerCommit: (commit: () => void) => () => void;
  style: React.ComponentProps<typeof TextInput>["style"];
}) {
  const valueText =
    props.value === undefined || props.value === null
      ? ""
      : String(props.value);
  const [text, setText] = useState(valueText);
  const focused = useRef(false);
  const dirty = useRef(false);
  const commit = useRef(() => {});
  commit.current = () => {
    focused.current = false;
    if (!dirty.current) return;
    dirty.current = false;
    if (!text.trim()) {
      props.onCommit(undefined);
      return;
    }
    const value = Number(text);
    if (!Number.isFinite(value)) {
      props.onInvalid();
      return;
    }
    const bounded = Math.min(props.maximum, Math.max(props.minimum, value));
    setText(String(bounded));
    props.onCommit(bounded);
  };
  // Native press targets can keep the keyboard focused until this field unmounts.
  useEffect(() => () => commit.current(), []);
  useEffect(() => props.registerCommit(() => commit.current()), []);
  useEffect(() => {
    if (!focused.current) setText(valueText);
  }, [valueText]);
  return (
    <TextInput
      accessibilityLabel={props.label}
      keyboardType="decimal-pad"
      editable={props.enabled}
      value={text}
      placeholder="Inherited"
      onFocus={() => {
        focused.current = true;
      }}
      onChangeText={(next) => {
        dirty.current = true;
        setText(next);
      }}
      onBlur={() => commit.current()}
      style={props.style}
    />
  );
}

function createStyles(theme: MD3Theme) {
  return StyleSheet.create({
    page: { padding: 18, gap: 12, backgroundColor: theme.colors.background },
    title: { fontSize: 23, fontWeight: "700", color: theme.colors.onSurface },
    description: {
      fontSize: 14,
      lineHeight: 20,
      color: theme.colors.onSurfaceVariant,
    },
    saveStatus: {
      minHeight: 22,
      lineHeight: 20,
      fontSize: 12,
      color: theme.colors.onSurfaceVariant,
    },
    section: {
      marginTop: 14,
      fontSize: 18,
      fontWeight: "700",
      color: theme.colors.onSurface,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 8,
    },
    scope: {
      paddingVertical: 9,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: theme.colors.outline,
      borderRadius: 18,
    },
    scopeText: { color: theme.colors.onSurface },
    selected: {
      backgroundColor: theme.colors.primary,
      borderColor: theme.colors.primary,
    },
    selectedText: { color: theme.colors.onPrimary },
    card: {
      padding: 13,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surface,
      gap: 9,
    },
    heading: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 8,
    },
    label: { fontSize: 15, fontWeight: "600", color: theme.colors.onSurface },
    origin: { fontSize: 12, color: theme.colors.onSurfaceVariant },
    hint: {
      fontSize: 12,
      lineHeight: 17,
      color: theme.colors.onSurfaceVariant,
    },
    valueText: { flex: 1, color: theme.colors.onSurface },
    input: {
      borderWidth: 1,
      borderColor: theme.colors.outline,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      color: theme.colors.onSurface,
      backgroundColor: theme.colors.surface,
    },
    promptInput: { minHeight: 96, textAlignVertical: "top" },
    disabled: { opacity: 0.5 },
    choice: {
      borderWidth: 1,
      borderColor: theme.colors.outline,
      borderRadius: 16,
      paddingHorizontal: 10,
      paddingVertical: 7,
    },
    reset: { color: theme.colors.primary, paddingVertical: 3 },
    secondary: {
      borderWidth: 1,
      borderColor: theme.colors.outline,
      borderRadius: 9,
      paddingHorizontal: 11,
      paddingVertical: 9,
    },
    swatch: {
      width: 34,
      height: 34,
      borderRadius: 17,
      borderWidth: 1,
      borderColor: "#bbb",
    },
    swatchSelected: { borderWidth: 3, borderColor: theme.colors.primary },
    avatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: theme.colors.primaryContainer,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarText: { fontWeight: "700", color: theme.colors.onPrimaryContainer },
    message: {
      color: theme.colors.onSecondaryContainer,
      padding: 9,
      backgroundColor: theme.colors.secondaryContainer,
      borderRadius: 8,
    },
  });
}
