import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  Image,
  View,
} from "react-native";
import {
  List,
  SegmentedButtons,
  Switch as PaperSwitch,
  Text,
  TextInput as PaperTextInput,
  useTheme,
  type MD3Theme,
} from "react-native-paper";
import {
  NativeButton,
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";
import { useAppTheme } from "../themes/provider";
import { AppearanceBehaviorSection } from "../appearance-behavior/section";
import { AppLockSection } from "../app-lock/section";
import { BackupSection } from "../backup/section";
import { AccountSection } from "../account/section";
import { BillingSection } from "../billing/section";
import { CommunitySection } from "../community/section";
import { SupportSection } from "../support/section";
import { DevBenchSection } from "../group-bench/section";
import { AnalyticsSection } from "../diagnostics/analytics-section";
import { describeError } from "../diagnostics/errors";
import { ErrorNotice } from "../diagnostics/error-notice";
import { useDiagnostics } from "../diagnostics/context";
import type { CapabilityMap } from "@locallab/contracts/ports";
import type { ContextPolicy } from "@locallab/context";
import {
  catalogPublisherDefaults,
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
import type { PersonaAvatarPort } from "../personas";

const SCOPES: readonly { id: SettingsScope; label: string }[] = [
  { id: "global", label: "Global" },
  { id: "model", label: "Model" },
  { id: "persona", label: "Persona" },
  { id: "chat", label: "This chat" },
];
const RESPONSE_CONTROLS = new Set([
  "temperature",
  "max_output_tokens",
  "reasoning",
  "reasoning_effort",
  "reasoning_verbosity",
  "json_mode",
]);

export interface ChatSettingsScreenProps {
  conversationId: string;
  modelId?: string;
  /** Catalog id of the bound on-device model; enables publisher sampling defaults. */
  catalogModelId?: string;
  personaId?: string;
  store: ChatSettingsStore;
  capabilities: CapabilityMap;
  serverContextWindow?: number;
  serverMaxOutputTokens?: number;
  serverContextStatus?: "checking" | "available" | "unavailable";
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
  /** Managed photo port for the conversation avatar (GR-13). */
  avatarPort?: PersonaAvatarPort;
  /** Attachment owner key for the avatar, `chat-avatar:<conversationId>`. */
  avatarOwnerId?: string;
}

export function ChatSettingsScreen(props: ChatSettingsScreenProps) {
  const paperTheme = useTheme();
  const { phone } = useWorkspaceLayout();
  const diagnostics = useDiagnostics();
  const styles = useMemo(
    () => createStyles(paperTheme, phone),
    [paperTheme, phone],
  );
  const { themePreference, setThemePreference, openThemeEditor } =
    useAppTheme();
  const publisherDefaults = useMemo(
    () =>
      props.catalogModelId
        ? catalogPublisherDefaults(props.catalogModelId)
        : undefined,
    [props.catalogModelId],
  );
  const [presets, setPresets] = useState<SettingsPresets>(EMPTY_PRESETS);
  const [appearance, setAppearance] = useState<ChatAppearance>({});
  const [scope, setScope] = useState<SettingsScope>("chat");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const [hasSavedChanges, setHasSavedChanges] = useState(false);
  const [busy, setBusy] = useState(false);
  const [contextPolicy, setContextPolicy] = useState<ContextPolicy>(
    props.contextPolicy ?? "roll",
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const settingsUnavailable = loading || loadFailed;
  const visibleError = [loadError, error].filter(Boolean).join("\n\n");
  const scroll = useRef<ScrollView>(null);
  const presetsRef = useRef<SettingsPresets>(EMPTY_PRESETS);
  const appearanceRef = useRef<ChatAppearance>({});
  const [avatarUris, setAvatarUris] = useState<Record<string, string>>({});
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
  useEffect(() => {
    if (phone && visibleError)
      scroll.current?.scrollTo({ y: 0, animated: true });
  }, [phone, visibleError]);
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
    setLoading(true);
    setLoadFailed(false);
    setHasSavedChanges(false);
    setError("");
    setLoadError("");
    setMessage("");
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
        if (
          style.avatarAttachmentId &&
          props.avatarPort &&
          !avatarUris[style.avatarAttachmentId]
        ) {
          const attachmentId = style.avatarAttachmentId;
          void props.avatarPort
            .resolve(attachmentId)
            .then((uri) => {
              if (live && uri)
                setAvatarUris((current) => ({
                  ...current,
                  [attachmentId]: uri,
                }));
            })
            .catch(() => undefined);
        }
        setPresets(next);
        setAppearance(style);
      })
      .catch((cause) => {
        if (live) {
          setLoadFailed(true);
          setLoadError(
            describeError(cause, {
              operation: "Load saved chat settings and appearance",
              recovery:
                "Tap Retry loading settings before editing. Your saved values have not been replaced with defaults.",
            }),
          );
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [props.store, props.conversationId, identity, loadRevision]);

  const resolved = useMemo(
    () =>
      resolveSettings({
        presets,
        personaEnabled: props.personaEnabled ?? true,
        capabilities: props.capabilities,
        ...(props.serverContextWindow
          ? { serverContextWindow: props.serverContextWindow }
          : {}),
        ...(props.serverMaxOutputTokens
          ? { serverMaxOutputTokens: props.serverMaxOutputTokens }
          : {}),
        ...(publisherDefaults ? { publisherDefaults } : {}),
      }),
    [
      presets,
      props.personaEnabled,
      props.capabilities,
      props.serverContextWindow,
      props.serverMaxOutputTokens,
      publisherDefaults,
    ],
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
      ...(props.serverContextWindow
        ? { serverContextWindow: props.serverContextWindow }
        : {}),
      ...(props.serverMaxOutputTokens
        ? { serverMaxOutputTokens: props.serverMaxOutputTokens }
        : {}),
      ...(publisherDefaults ? { publisherDefaults } : {}),
    });
  }, [
    presets,
    scope,
    props.personaEnabled,
    props.capabilities,
    props.serverContextWindow,
    props.serverMaxOutputTokens,
    publisherDefaults,
  ]);

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
        ...(props.serverContextWindow
          ? { serverContextWindow: props.serverContextWindow }
          : {}),
        ...(props.serverMaxOutputTokens
          ? { serverMaxOutputTokens: props.serverMaxOutputTokens }
          : {}),
        ...(publisherDefaults ? { publisherDefaults } : {}),
      }).effective;
      const after = resolveSettings({
        presets: next,
        personaEnabled: props.personaEnabled ?? true,
        capabilities: props.capabilities,
        ...(props.serverContextWindow
          ? { serverContextWindow: props.serverContextWindow }
          : {}),
        ...(props.serverMaxOutputTokens
          ? { serverMaxOutputTokens: props.serverMaxOutputTokens }
          : {}),
        ...(publisherDefaults ? { publisherDefaults } : {}),
      }).effective;
      presetsRef.current = next;
      const version = ++editVersion.current;
      setPresets(next);
      setMessage("");
      setError("");
      enqueueWrite(async () => {
        try {
          await props.store.savePreset(
            scope,
            next[scope].explicitlySet,
            identity,
          );
          if (mounted.current) setHasSavedChanges(true);
          if (
            mounted.current &&
            version === editVersion.current &&
            scopeChangeNeedsContextReload(before, after)
          ) {
            setMessage(
              "Context settings changed. Reload model context to apply them.",
            );
          }
        } catch (cause) {
          if (mounted.current && version === editVersion.current) {
            presetsRef.current = previous;
            setPresets(previous);
            setError(
              describeError(cause, {
                operation: `Save ${SCOPES.find((item) => item.id === scope)?.label ?? scope} model settings`,
                recovery:
                  "The displayed value was restored. Try changing the setting again, or Retry loading settings to read saved values.",
              }),
            );
          }
        }
      });
    },
    [
      presets,
      props.capabilities,
      props.personaEnabled,
      props.serverContextWindow,
      props.serverMaxOutputTokens,
      publisherDefaults,
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
    operation: string,
    recovery: string,
  ) => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      commitNumericInputs();
      await writes.current;
      await action();
    } catch (error) {
      setError(describeError(error, { operation, recovery }));
    } finally {
      setBusy(false);
    }
  };
  const saveAppearance = async (next: ChatAppearance) => {
    const previous = appearanceRef.current;
    appearanceRef.current = next;
    const version = ++editVersion.current;
    setAppearance(next);
    setError("");
    setMessage("");
    enqueueWrite(async () => {
      try {
        await props.store.saveAppearance(props.conversationId, next);
        if (mounted.current) setHasSavedChanges(true);
      } catch (cause) {
        if (mounted.current && version === editVersion.current) {
          appearanceRef.current = previous;
          setAppearance(previous);
          setError(
            describeError(cause, {
              operation: "Save chat appearance",
              recovery:
                "The displayed appearance was restored. Try the appearance change again.",
            }),
          );
        }
      }
    });
  };
  const chooseAvatarPhoto = () =>
    void runAction(
      async () => {
        if (!props.avatarPort || !props.avatarOwnerId) return;
        const image = await props.avatarPort.pick(props.avatarOwnerId);
        if (!image) return;
        if (!mounted.current) {
          await props.avatarPort
            .release(image.attachmentId, props.avatarOwnerId)
            .catch(() => undefined);
          return;
        }
        const previous = appearanceRef.current.avatarAttachmentId;
        setAvatarUris((current) => ({
          ...current,
          [image.attachmentId]: image.uri,
        }));
        void saveAppearance({
          ...appearanceRef.current,
          avatarAttachmentId: image.attachmentId,
        });
        await writes.current;
        // Release only after the durable swap; a failed save keeps the old photo and drops the new pick.
        if (appearanceRef.current.avatarAttachmentId === image.attachmentId) {
          if (previous && previous !== image.attachmentId)
            await props.avatarPort
              .release(previous, props.avatarOwnerId)
              .catch(() => undefined);
        } else {
          await props.avatarPort
            .release(image.attachmentId, props.avatarOwnerId)
            .catch(() => undefined);
        }
      },
      "Choose a conversation avatar photo",
      "Pick another photo or remove the avatar. Your chat and settings are unchanged.",
    );
  const removeAvatarPhoto = () =>
    void runAction(
      async () => {
        if (!props.avatarPort || !props.avatarOwnerId) return;
        const previous = appearanceRef.current.avatarAttachmentId;
        if (!previous) return;
        const next = { ...appearanceRef.current };
        delete next.avatarAttachmentId;
        void saveAppearance(next);
        await writes.current;
        if (appearanceRef.current.avatarAttachmentId !== previous)
          await props.avatarPort
            .release(previous, props.avatarOwnerId)
            .catch(() => undefined);
      },
      "Remove the conversation avatar photo",
      "Choose a new avatar photo. Your chat and settings are unchanged.",
    );
  const changeTheme = (value: "system" | "light" | "dark") => {
    setError("");
    void setThemePreference(value).catch((cause) => {
      setError(
        describeError(cause, {
          operation: "Save the app theme",
          recovery:
            "Try selecting the theme again. Reopen Settings to check the saved preference.",
        }),
      );
    });
  };

  const resetModel = async () => {
    commitNumericInputs();
    const result = resetModelToGlobal(presetsRef.current);
    await persistPresets(result.presets);
  };

  const confirmedResponses = new Set(
    PARAMETER_CONTROLS.filter((control) => {
      const decision =
        resolved.capabilities[control.capability] ??
        resolved.capabilities[control.key];
      return (
        RESPONSE_CONTROLS.has(control.key) &&
        decision?.visible &&
        decision.value === "yes"
      );
    }).map((control) => control.key),
  );
  const parameterGroups = phone
    ? [
        {
          id: "instructions",
          title: "Model instructions",
          description: "Guide how your model responds",
          icon: "message-text-outline",
          controls: PARAMETER_CONTROLS.filter(
            (control) => control.key === "systemPrompt",
          ),
        },
        {
          id: "response",
          title: "Response settings",
          description: "Length, creativity, and reasoning",
          icon: "tune-variant",
          controls: PARAMETER_CONTROLS.filter((control) =>
            confirmedResponses.has(control.key),
          ),
        },
        {
          id: "advanced",
          title: "Advanced model controls",
          description: "Sampling, performance, and other options",
          icon: "cog-outline",
          controls: PARAMETER_CONTROLS.filter(
            (control) =>
              control.key !== "systemPrompt" &&
              !confirmedResponses.has(control.key),
          ),
        },
      ].filter((group) =>
        group.controls.some((control) => {
          const decision =
            resolved.capabilities[control.capability] ??
            resolved.capabilities[control.key];
          return !decision || decision.visible;
        }),
      )
    : [
        {
          id: "all",
          title: "Model settings",
          description: "",
          icon: "tune-variant",
          controls: PARAMETER_CONTROLS,
        },
      ];
  const SwitchControl = phone ? PaperSwitch : Switch;

  return (
    <ScrollView
      ref={scroll}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[
        styles.page,
        { backgroundColor: paperTheme.colors.background },
      ]}
    >
      {!phone ? (
        <Text accessibilityRole="header" style={styles.title}>
          Chat and model settings
        </Text>
      ) : null}
      <Text style={styles.description}>
        {phone
          ? "Make this chat your own. Changes save automatically."
          : "Choose which settings apply here. Chat overrides take priority over Persona, Model, and Global values."}
      </Text>
      {visibleError ? (
        <View style={{ gap: 8 }}>
          <ErrorNotice message={visibleError} />
          <NativeButton
            accessibilityLabel="Retry loading settings"
            mode="outlined"
            disabled={loading || saving || busy}
            onPress={() => setLoadRevision((value) => value + 1)}
          >
            Retry loading settings
          </NativeButton>
        </View>
      ) : null}
      {!visibleError && (!phone || !message || loading || saving) ? (
        <Text accessibilityLiveRegion="polite" style={styles.saveStatus}>
          {loading
            ? "Loading saved settings..."
            : saving
              ? "Saving settings..."
              : hasSavedChanges
                ? "Changes saved"
                : "Settings loaded"}
        </Text>
      ) : null}
      {message ? (
        <Text accessibilityLiveRegion="polite" style={styles.message}>
          {message}
        </Text>
      ) : null}
      {phone && props.contextProgress ? (
        <Text accessibilityLiveRegion="polite" style={styles.hint}>
          {props.contextProgress}
        </Text>
      ) : null}
      <Text accessibilityRole="header" style={styles.section}>
        App theme
      </Text>
      {phone ? (
        <SegmentedButtons
          value={themePreference}
          onValueChange={(value) =>
            changeTheme(value as "system" | "light" | "dark")
          }
          buttons={(["system", "light", "dark"] as const).map((value) => ({
            value,
            label: value[0]!.toUpperCase() + value.slice(1),
            accessibilityLabel: `Use ${value} app theme`,
            style: { minHeight: 44 },
            labelStyle: { letterSpacing: 0 },
          }))}
          style={styles.themeControl}
        />
      ) : (
        <View style={styles.row}>
          {(["system", "light", "dark"] as const).map((value) => (
            <NativeButton
              key={value}
              accessibilityLabel={`Use ${value} app theme`}
              accessibilityState={{ selected: themePreference === value }}
              mode={themePreference === value ? "contained" : "outlined"}
              onPress={() => changeTheme(value)}
            >
              {value[0]!.toUpperCase() + value.slice(1)}
            </NativeButton>
          ))}
        </View>
      )}
      <View style={styles.row}>
        <NativeButton
          mode="outlined"
          accessibilityLabel="Open the theme editor"
          onPress={() => openThemeEditor()}
        >
          Customize theme…
        </NativeButton>
      </View>
      <AppearanceBehaviorSection />
      <AppLockSection />
      <BackupSection />
      <AccountSection />
      <BillingSection />
      <CommunitySection />
      <SupportSection />
      <AnalyticsSection />
      {process.env.EXPO_PUBLIC_DEV_BENCH === "1" ? <DevBenchSection /> : null}
      <SettingsSection
        phone={phone}
        title="Settings scope"
        description={`${SCOPES.find((item) => item.id === scope)?.label ?? "This chat"} · choose where edits apply`}
        icon="layers-outline"
      >
        {phone ? (
          <Text style={styles.hint}>
            Chat values override Persona, Model, and Global defaults.
          </Text>
        ) : null}
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
            disabled={!props.modelId || busy || settingsUnavailable}
            style={styles.secondary}
          >
            <Text>Use Global params</Text>
          </Pressable>
        )}
      </SettingsSection>
      {parameterGroups.map((group) => (
        <SettingsSection
          key={group.id}
          phone={phone}
          title={group.title}
          description={group.description}
          icon={group.icon}
        >
          {group.controls.map((control) => {
            const decision =
              resolved.capabilities[control.capability] ??
              resolved.capabilities[control.key];
            if (decision && !decision.visible) return null;
            const enabled =
              !settingsUnavailable &&
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
                    {origin === "server"
                      ? "From server"
                      : origin
                        ? `From ${SCOPES.find((item) => item.id === origin)?.label}`
                        : "Default"}
                  </Text>
                </View>
                {control.key === "contextWindow" &&
                props.serverContextStatus ? (
                  <Text accessibilityLiveRegion="polite" style={styles.hint}>
                    {props.serverContextStatus === "checking"
                      ? "Checking the server context limit..."
                      : props.serverContextWindow
                        ? `Server context: ${props.serverContextWindow.toLocaleString("en-US")} tokens. Used automatically unless you set Context window.`
                        : "The server context limit is unavailable. The automatic fallback is 4,096 tokens; set Context window to match your server."}
                  </Text>
                ) : null}
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
                    <SwitchControl
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
                    phone={phone}
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
                      setError(
                        describeError(
                          new Error(
                            `The value for ${control.label} is not a valid number.`,
                          ),
                          {
                            operation: `Edit ${control.label}`,
                            recovery:
                              "Enter a number in this field, or clear it to use the inherited value.",
                          },
                        ),
                      )
                    }
                    style={[
                      phone ? styles.paperInput : styles.input,
                      !phone && !enabled && styles.disabled,
                    ]}
                  />
                ) : null}
                {control.kind === "text" ? (
                  phone ? (
                    <PaperTextInput
                      mode="outlined"
                      accessibilityLabel={control.label}
                      multiline={control.key === "systemPrompt"}
                      numberOfLines={control.key === "systemPrompt" ? 3 : 1}
                      disabled={!enabled}
                      value={typeof value === "string" ? value : ""}
                      placeholder={
                        control.key === "systemPrompt"
                          ? "Optional instructions"
                          : "Use inherited value"
                      }
                      onChangeText={(text) => setValue(control.key, text)}
                      outlineStyle={{ borderRadius: 12 }}
                      style={[
                        styles.paperInput,
                        control.key === "systemPrompt" && styles.promptInput,
                      ]}
                    />
                  ) : (
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
                  )
                ) : null}
                {control.kind === "choice" ? (
                  <View style={styles.row}>
                    {control.choices?.map((choice) =>
                      phone ? (
                        <NativeButton
                          key={choice}
                          accessibilityLabel={`${control.label}: ${choice}${value === choice ? ", selected" : ""}`}
                          accessibilityState={{ selected: value === choice }}
                          disabled={!enabled}
                          mode={
                            value === choice ? "contained-tonal" : "outlined"
                          }
                          onPress={() => setValue(control.key, choice)}
                          contentStyle={{ minHeight: 44 }}
                        >
                          {choice}
                        </NativeButton>
                      ) : (
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
                            style={
                              value === choice ? styles.selectedText : undefined
                            }
                          >
                            {choice}
                          </Text>
                        </Pressable>
                      ),
                    )}
                  </View>
                ) : null}
                {phone ? (
                  active ? (
                    <NativeButton
                      accessibilityLabel={`${control.label}: Reset this value`}
                      disabled={settingsUnavailable}
                      mode="text"
                      compact
                      onPress={() => resetValue(control.key)}
                      contentStyle={{ minHeight: 44 }}
                      style={{ alignSelf: "flex-start" }}
                    >
                      Reset this value
                    </NativeButton>
                  ) : null
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${control.label}: Reset this value`}
                    disabled={settingsUnavailable || !active}
                    onPress={() => resetValue(control.key)}
                  >
                    <Text style={[styles.reset, !active && styles.disabled]}>
                      Reset this value
                    </Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </SettingsSection>
      ))}

      <SettingsSection
        phone={phone}
        title="Chat appearance"
        description="Background color and avatar initials"
        icon="palette-outline"
      >
        {!phone ? (
          <Text accessibilityRole="header" style={styles.section}>
            Chat appearance
          </Text>
        ) : null}
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
                accessibilityState={{
                  selected: appearance.background === color,
                }}
                disabled={settingsUnavailable}
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
          {phone ? (
            <PaperTextInput
              mode="outlined"
              label="Chat avatar initials"
              accessibilityLabel="Chat avatar initials"
              placeholder="Up to 2 initials"
              maxLength={2}
              value={appearance.avatar ?? ""}
              disabled={settingsUnavailable}
              onChangeText={(avatar) => {
                const next = { ...appearanceRef.current };
                if (avatar) next.avatar = avatar;
                else delete next.avatar;
                void saveAppearance(next);
              }}
              outlineStyle={{ borderRadius: 12 }}
              style={styles.paperInput}
            />
          ) : (
            <TextInput
              accessibilityLabel="Chat avatar initials"
              placeholder="Up to 2 initials"
              maxLength={2}
              value={appearance.avatar ?? ""}
              editable={!settingsUnavailable}
              onChangeText={(avatar) => {
                const next = { ...appearanceRef.current };
                if (avatar) next.avatar = avatar;
                else delete next.avatar;
                void saveAppearance(next);
              }}
              style={styles.input}
            />
          )}
          {props.avatarPort ? (
            <>
              <Text style={styles.label}>Avatar photo</Text>
              {appearance.avatarAttachmentId ? (
                avatarUris[appearance.avatarAttachmentId] ? (
                  <Image
                    source={{ uri: avatarUris[appearance.avatarAttachmentId] }}
                    accessibilityLabel="Conversation avatar photo"
                    style={styles.avatarPhoto}
                  />
                ) : (
                  <Text style={styles.hint}>
                    The saved avatar photo is missing on this device. Choose a
                    new photo to replace it; the rest of this chat still works.
                  </Text>
                )
              ) : null}
              <View style={styles.row}>
                <NativeButton
                  mode="outlined"
                  accessibilityLabel={
                    appearance.avatarAttachmentId
                      ? "Replace conversation avatar photo"
                      : "Choose conversation avatar photo"
                  }
                  disabled={settingsUnavailable || busy}
                  onPress={chooseAvatarPhoto}
                >
                  {appearance.avatarAttachmentId
                    ? "Replace avatar photo"
                    : "Choose avatar photo"}
                </NativeButton>
                {appearance.avatarAttachmentId ? (
                  <NativeButton
                    mode="text"
                    accessibilityLabel="Remove conversation avatar photo"
                    disabled={settingsUnavailable || busy}
                    onPress={removeAvatarPhoto}
                  >
                    Remove
                  </NativeButton>
                ) : null}
              </View>
            </>
          ) : null}
        </View>
      </SettingsSection>

      <SettingsSection
        phone={phone}
        title="Context recovery"
        description="Manage long conversations and retry replies"
        icon="restore"
      >
        {!phone ? (
          <Text accessibilityRole="header" style={styles.section}>
            Context recovery
          </Text>
        ) : null}
        <View style={styles.card}>
          <Text style={styles.hint}>
            {phone
              ? "Keep longer conversations manageable. Your saved messages stay in history."
              : "Compaction creates a request projection; saved transcript history is retained."}
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
                  "Compact the conversation context",
                  "Check the model connection, then try Compact and retry again.",
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
                  "Reload model context",
                  "Check the model connection, then try Reload context again.",
                )
              }
              style={styles.secondary}
            >
              <Text>Reload context</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={
                busy || !props.onRetry || !!props.retryUnavailableReason
              }
              onPress={() =>
                void runAction(
                  () => props.onRetry?.(),
                  "Retry the chat request",
                  "Check the model connection and the chat error, then try Retry request again.",
                )
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
          {!phone && props.contextProgress ? (
            <Text accessibilityLiveRegion="polite" style={styles.hint}>
              {props.contextProgress}
            </Text>
          ) : null}
        </View>
      </SettingsSection>
      {diagnostics ? (
        <View style={{ gap: 8 }}>
          <Text accessibilityRole="header" style={styles.section}>
            Troubleshooting
          </Text>
          <Text style={styles.description}>
            Open the trace log to turn recording on, inspect app events, or copy
            a report when something fails.
          </Text>
          <NativeButton
            mode="outlined"
            accessibilityLabel="Open trace log from Settings"
            onPress={diagnostics.openTrace}
          >
            Trace log
          </NativeButton>
        </View>
      ) : null}
    </ScrollView>
  );
}

function SettingsSection({
  phone,
  title,
  description,
  icon,
  children,
}: {
  phone: boolean;
  title: string;
  description: string;
  icon: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const styles = useMemo(() => createStyles(theme, true), [theme]);
  if (!phone) return <>{children}</>;
  return (
    <View style={styles.disclosure}>
      <List.Accordion
        title={title}
        description={description}
        accessibilityLabel={title}
        expanded={expanded}
        onPress={() => setExpanded((value) => !value)}
        left={(props) => <List.Icon {...props} icon={icon} />}
        titleStyle={styles.disclosureTitle}
        descriptionStyle={styles.disclosureDescription}
        style={{ backgroundColor: theme.colors.surface }}
        children={null}
      />
      {expanded ? (
        <View style={styles.disclosureContent}>{children}</View>
      ) : null}
    </View>
  );
}

function NumericSettingInput(props: {
  phone?: boolean;
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
  if (props.phone) {
    return (
      <PaperTextInput
        mode="outlined"
        accessibilityLabel={props.label}
        keyboardType="decimal-pad"
        disabled={!props.enabled}
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
        outlineStyle={{ borderRadius: 12 }}
        style={props.style}
      />
    );
  }
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

function createStyles(theme: MD3Theme, phone = false) {
  return StyleSheet.create({
    page: {
      padding: phone ? 16 : 18,
      paddingBottom: phone ? 24 : 18,
      gap: 12,
      backgroundColor: theme.colors.background,
    },
    title: { fontSize: 23, fontWeight: "700", color: theme.colors.onSurface },
    description: {
      fontSize: 14,
      lineHeight: phone ? 22 : 20,
      color: theme.colors.onSurfaceVariant,
    },
    saveStatus: {
      minHeight: 22,
      lineHeight: 20,
      fontSize: phone ? 14 : 12,
      color: theme.colors.onSurfaceVariant,
    },
    section: {
      marginTop: phone ? 8 : 14,
      fontSize: 18,
      fontWeight: phone ? "600" : "700",
      color: theme.colors.onSurface,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 8,
    },
    scope: {
      paddingVertical: phone ? 11 : 9,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: theme.colors.outline,
      borderRadius: phone ? 12 : 18,
    },
    scopeText: {
      color: theme.colors.onSurface,
      ...(phone ? { fontSize: 14, lineHeight: 20 } : {}),
    },
    selected: {
      backgroundColor: phone
        ? theme.colors.primaryContainer
        : theme.colors.primary,
      borderColor: theme.colors.primary,
    },
    selectedText: {
      color: phone ? theme.colors.onPrimaryContainer : theme.colors.onPrimary,
    },
    card: {
      padding: phone ? 14 : 13,
      borderRadius: phone ? 16 : 12,
      borderWidth: phone ? 0 : 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: phone
        ? theme.colors.surfaceVariant
        : theme.colors.surface,
      gap: phone ? 12 : 9,
    },
    heading: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 8,
    },
    label: {
      fontSize: phone ? 16 : 15,
      fontWeight: "600",
      color: theme.colors.onSurface,
      ...(phone ? { lineHeight: 24, flex: 1 } : {}),
    },
    origin: {
      fontSize: phone ? 14 : 12,
      color: theme.colors.onSurfaceVariant,
      ...(phone ? { lineHeight: 20 } : {}),
    },
    hint: {
      fontSize: phone ? 14 : 12,
      lineHeight: phone ? 20 : 17,
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
    paperInput: {
      backgroundColor: theme.colors.surface,
      fontSize: 17,
      minHeight: 52,
    },
    promptInput: { minHeight: phone ? 88 : 96, textAlignVertical: "top" },
    disabled: { opacity: 0.5 },
    choice: {
      borderWidth: 1,
      borderColor: theme.colors.outline,
      borderRadius: phone ? 12 : 16,
      paddingHorizontal: 10,
      paddingVertical: phone ? 11 : 7,
    },
    reset: { color: theme.colors.primary, paddingVertical: 3 },
    secondary: {
      borderWidth: 1,
      borderColor: theme.colors.outline,
      borderRadius: phone ? 12 : 9,
      paddingHorizontal: 11,
      paddingVertical: phone ? 11 : 9,
    },
    swatch: {
      width: phone ? 44 : 34,
      height: phone ? 44 : 34,
      borderRadius: phone ? 22 : 17,
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
    avatarPhoto: {
      width: 72,
      height: 72,
      borderRadius: 36,
      alignSelf: "flex-start",
    },
    message: {
      color: theme.colors.onSecondaryContainer,
      padding: phone ? 12 : 9,
      backgroundColor: theme.colors.secondaryContainer,
      borderRadius: phone ? 12 : 8,
      ...(phone ? { fontSize: 14, lineHeight: 20 } : {}),
    },
    themeControl: { marginBottom: 8 },
    disclosure: {
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      borderRadius: 18,
      backgroundColor: theme.colors.surface,
      overflow: "hidden",
    },
    disclosureTitle: {
      fontSize: 16,
      lineHeight: 24,
      fontWeight: "600",
      color: theme.colors.onSurface,
    },
    disclosureDescription: {
      fontSize: 14,
      lineHeight: 20,
      letterSpacing: 0,
      color: theme.colors.onSurfaceVariant,
    },
    disclosureContent: { padding: 12, gap: 12 },
  });
}
