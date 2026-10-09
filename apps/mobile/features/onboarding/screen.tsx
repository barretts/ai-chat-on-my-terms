import { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, ScrollView, StyleSheet, View } from "react-native";
import {
  Button,
  Icon,
  List,
  SegmentedButtons,
  Text,
  useTheme,
} from "react-native-paper";
import type { FitMode, ModelFitChoice } from "@locallab/models-fit";
import type { OnboardingState, OnboardingTheme } from "./index";
import { describeError } from "../diagnostics/errors";
import { ErrorNotice } from "../diagnostics/error-notice";
import {
  NativeButton,
  NativeSurface,
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";

export interface OnboardingPreferences {
  mode: FitMode;
  theme: OnboardingTheme;
}

export function OnboardingScreen(props: {
  recommendations: readonly ModelFitChoice[];
  initialState?: Pick<OnboardingState, "mode" | "theme">;
  downloadAvailable?: boolean;
  onBrowseModels?(preferences: OnboardingPreferences): void | Promise<void>;
  onConnect?(preferences: OnboardingPreferences): Promise<void>;
  onModeChange?(mode: FitMode): Promise<void>;
  onThemeChange?(theme: OnboardingTheme): Promise<void>;
  onDownload(modelId: string): Promise<void>;
  onFinish(input: {
    mode: FitMode;
    theme: OnboardingTheme;
    modelId: string | null;
  }): Promise<void>;
  onRace?(): Promise<string | null>;
}) {
  const [mode, setMode] = useState<FitMode>(
    props.initialState?.mode ?? "beginner",
  );
  const [theme, setTheme] = useState<OnboardingTheme>(
    props.initialState?.theme ?? "system",
  );
  const paperTheme = useTheme();
  const { phone } = useWorkspaceLayout();
  const [tier, setTier] = useState<ModelFitChoice["tier"]>("balanced");
  const [showPreferences, setShowPreferences] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activePath, setActivePath] = useState<
    "connect" | "models" | "chat" | null
  >(null);
  const busyRef = useRef(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const scroll = useRef<ScrollView>(null);
  useEffect(() => {
    if (!error) return;
    Keyboard.dismiss();
    requestAnimationFrame(() =>
      scroll.current?.scrollTo({ y: 0, animated: true }),
    );
  }, [error]);
  const choices = useMemo(
    () =>
      mode === "beginner"
        ? props.recommendations.slice(0, 3)
        : props.recommendations,
    [props.recommendations, mode],
  );
  const selected = choices.find((choice) => choice.tier === tier) ?? choices[0];

  const finish = async (modelId: string | null) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActivePath(modelId ? "models" : "chat");
    setMessage("");
    setError("");
    let operation = modelId ? "Download initial model" : "Save initial setup";
    try {
      if (modelId) await props.onDownload(modelId);
      operation = "Save initial setup";
      await props.onFinish({ mode, theme, modelId });
      setMessage(
        modelId
          ? "Model is ready. Your setup is saved."
          : "Setup saved. Add a model whenever you are ready.",
      );
    } catch (cause) {
      setError(
        describeError(cause, {
          operation,
          recovery:
            "Try again, or start without a model and choose one in Models later.",
        }),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
      setActivePath(null);
    }
  };

  const followPath = async (path: "connect" | "models") => {
    if (path === "models" && !props.onBrowseModels) {
      if (selected) await finish(selected.model.id);
      return;
    }
    const action = path === "connect" ? props.onConnect : props.onBrowseModels;
    if (!action || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActivePath(path);
    setMessage("");
    setError("");
    try {
      await action({ mode, theme });
      setMessage("Setup saved.");
    } catch (cause) {
      setError(
        describeError(cause, {
          operation:
            path === "connect"
              ? "Open connection setup"
              : "Open phone model setup",
          recovery:
            "Try this option again, or start without a model and open it from the chat menu.",
        }),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
      setActivePath(null);
    }
  };

  const race = async () => {
    if (!props.onRace || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActivePath("models");
    setMessage("");
    setError("");
    try {
      const modelId = await props.onRace();
      await props.onFinish({ mode, theme, modelId });
      setMessage(
        modelId
          ? "The first model setup completed."
          : "Model race stopped. You can choose a model later.",
      );
    } catch (cause) {
      setError(
        describeError(cause, {
          operation: "Complete model race setup",
          recovery: "Choose a model in Models or continue without a model.",
        }),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
      setActivePath(null);
    }
  };

  const chooseMode = async (value: FitMode) => {
    const previous = mode;
    setMessage("");
    setError("");
    setMode(value);
    try {
      await props.onModeChange?.(value);
    } catch (cause) {
      setMode(previous);
      setError(
        describeError(cause, {
          operation: "Save setup style",
          recovery:
            "Choose the setup style again. Your previous selection has been restored.",
        }),
      );
    }
  };
  const chooseTheme = async (value: OnboardingTheme) => {
    const previous = theme;
    setMessage("");
    setError("");
    setTheme(value);
    try {
      await props.onThemeChange?.(value);
    } catch (cause) {
      setTheme(previous);
      setError(
        describeError(cause, {
          operation: "Save appearance preference",
          recovery:
            "Choose the appearance again. Your previous selection has been restored.",
        }),
      );
    }
  };

  if (phone) {
    return (
      <ScrollView
        ref={scroll}
        style={{ backgroundColor: paperTheme.colors.background }}
        contentContainerStyle={styles.phonePage}
        keyboardShouldPersistTaps="handled"
      >
        {error ? <ErrorNotice message={error} /> : null}
        <View style={styles.phoneWelcome}>
          <View
            style={[
              styles.phoneMark,
              { backgroundColor: paperTheme.colors.primaryContainer },
            ]}
          >
            <Icon
              source="chat-outline"
              size={26}
              color={paperTheme.colors.onPrimaryContainer}
            />
          </View>
          <Text
            accessibilityRole="header"
            variant="headlineLarge"
            style={styles.phoneHeading}
          >
            Welcome to LocalLab
          </Text>
          <Text
            variant="bodyLarge"
            style={[
              styles.phoneIntro,
              { color: paperTheme.colors.onSurfaceVariant },
            ]}
          >
            Where would you like your model to run?
          </Text>
        </View>

        <View style={styles.phoneChoices}>
          {props.onConnect ? (
            <NativeSurface
              accessibilityLabel="Connect a PC or online model"
              style={styles.phoneModelCard}
            >
              <Text accessibilityRole="header" variant="titleLarge">
                Connect a PC or online model
              </Text>
              <Text
                variant="bodyMedium"
                style={{ color: paperTheme.colors.onSurfaceVariant }}
              >
                Use your computer's model server or a service such as
                OpenRouter. No phone download needed.
              </Text>
              <Button
                accessibilityLabel="Connect a PC or online model"
                mode="contained"
                disabled={busy}
                loading={busy && activePath === "connect"}
                onPress={() => void followPath("connect")}
                contentStyle={styles.phonePrimaryContent}
                style={styles.phonePrimaryButton}
              >
                Connect a model
              </Button>
            </NativeSurface>
          ) : null}

          <NativeSurface
            accessibilityLabel="Download a phone model"
            style={styles.phoneModelCard}
          >
            <Text accessibilityRole="header" variant="titleLarge">
              Download a phone model
            </Text>
            <Text
              variant="bodyMedium"
              style={{ color: paperTheme.colors.onSurfaceVariant }}
            >
              Run on this phone, offline after downloading. Choose a model and
              see its size before you download.
            </Text>
            <Button
              accessibilityLabel="Download suggested model"
              mode={props.onConnect ? "outlined" : "contained"}
              disabled={
                busy ||
                (!props.onBrowseModels &&
                  (!selected || props.downloadAvailable === false))
              }
              loading={busy && activePath === "models"}
              onPress={() => void followPath("models")}
              contentStyle={styles.phonePrimaryContent}
              style={styles.phonePrimaryButton}
            >
              {props.onBrowseModels
                ? "Choose a phone model"
                : "Download and continue"}
            </Button>
          </NativeSurface>

          <View style={styles.phoneSkip}>
            <Button
              accessibilityLabel="Continue without a model"
              disabled={busy}
              loading={busy && activePath === "chat"}
              onPress={() => void finish(null)}
              contentStyle={styles.phoneButtonContent}
            >
              Start without a model
            </Button>
            <Text
              variant="bodyMedium"
              style={[
                styles.phoneSkipCopy,
                { color: paperTheme.colors.onSurfaceVariant },
              ]}
            >
              Explore the app and choose a model later.
            </Text>
          </View>
        </View>

        {message ? (
          <Text accessibilityLiveRegion="polite">{message}</Text>
        ) : null}
        <NativeSurface
          accessibilityLabel="Optional setup preferences"
          style={styles.phonePreferences}
        >
          <List.Accordion
            title="Preferences"
            description={`${mode === "beginner" ? "Beginner" : "Power user"} · ${theme === "system" ? "System appearance" : theme === "dark" ? "Dark appearance" : "Light appearance"}`}
            accessibilityLabel="Show setup preferences"
            expanded={showPreferences}
            onPress={() => setShowPreferences((shown) => !shown)}
            style={styles.phoneDisclosure}
            theme={{ colors: { background: paperTheme.colors.surface } }}
          >
            <View style={styles.phoneDetails}>
              <View
                accessibilityLabel="Choose setup mode"
                style={styles.phoneSection}
              >
                <Text accessibilityRole="header" variant="titleMedium">
                  Chat controls
                </Text>
                <SegmentedButtons
                  value={mode}
                  onValueChange={chooseMode}
                  buttons={[
                    {
                      value: "beginner",
                      label: "Beginner",
                      accessibilityLabel: `Choose beginner setup${mode === "beginner" ? ", selected" : ""}`,
                      disabled: busy,
                      style: styles.phoneSegment,
                    },
                    {
                      value: "power",
                      label: "Power user",
                      accessibilityLabel: `Choose power user setup${mode === "power" ? ", selected" : ""}`,
                      disabled: busy,
                      style: styles.phoneSegment,
                    },
                  ]}
                />
                <Text
                  variant="bodyMedium"
                  style={{ color: paperTheme.colors.onSurfaceVariant }}
                >
                  {mode === "beginner"
                    ? "Beginner shows the main chat tools and hides advanced menu sections."
                    : "Power user shows all menu sections, including advanced chat tools."}
                </Text>
              </View>
              <View style={styles.phoneSection}>
                <Text accessibilityRole="header" variant="titleMedium">
                  Appearance
                </Text>
                <SegmentedButtons
                  value={theme}
                  onValueChange={chooseTheme}
                  buttons={(["system", "light", "dark"] as const).map(
                    (value) => ({
                      value,
                      label: value[0]!.toUpperCase() + value.slice(1),
                      accessibilityLabel: `Choose ${value} theme${theme === value ? ", selected" : ""}`,
                      disabled: busy,
                      style: styles.phoneSegment,
                    }),
                  )}
                />
                <Text
                  variant="bodyMedium"
                  style={{ color: paperTheme.colors.onSurfaceVariant }}
                >
                  You can change these preferences in Settings later.
                </Text>
              </View>
            </View>
          </List.Accordion>
        </NativeSurface>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      ref={scroll}
      style={{ backgroundColor: paperTheme.colors.background }}
      contentContainerStyle={styles.page}
    >
      {error ? <ErrorNotice message={error} /> : null}
      <Text accessibilityRole="header" variant="headlineMedium">
        Welcome to LocalLab
      </Text>
      <Text>
        Choose a setup style. Cloud providers are optional, and local model
        choices are estimates based on this device’s available resources.
      </Text>
      <NativeSurface accessibilityLabel="Choose setup mode" style={styles.card}>
        <Text accessibilityRole="header" variant="titleLarge">
          How do you want to set up?
        </Text>
        <View style={styles.row}>
          <NativeButton
            accessibilityLabel="Choose beginner setup"
            accessibilityState={{ selected: mode === "beginner" }}
            mode={mode === "beginner" ? "contained" : "outlined"}
            disabled={busy}
            onPress={() => chooseMode("beginner")}
          >
            Beginner
          </NativeButton>
          <NativeButton
            accessibilityLabel="Choose power user setup"
            accessibilityState={{ selected: mode === "power" }}
            mode={mode === "power" ? "contained" : "outlined"}
            disabled={busy}
            onPress={() => chooseMode("power")}
          >
            Power user
          </NativeButton>
        </View>
        <Text>
          {mode === "beginner"
            ? "Beginner setup hides advanced menu sections and offers a guided start with a recommended model."
            : "Power user setup shows model size and memory estimates, plus all advanced chat menu sections."}
        </Text>
        <Text accessibilityRole="header" variant="titleMedium">
          Choose a theme
        </Text>
        <View style={styles.row}>
          {(["system", "light", "dark"] as const).map((value) => (
            <NativeButton
              accessibilityLabel={`Choose ${value} theme`}
              key={value}
              accessibilityState={{ selected: theme === value }}
              mode={theme === value ? "contained" : "outlined"}
              disabled={busy}
              onPress={() => chooseTheme(value)}
            >
              {value[0]!.toUpperCase() + value.slice(1)}
            </NativeButton>
          ))}
        </View>
      </NativeSurface>
      <NativeSurface
        accessibilityLabel="Suggested local model"
        style={styles.card}
      >
        <Text accessibilityRole="header" variant="titleLarge">
          Choose where your model runs
        </Text>
        {props.onConnect ? (
          <NativeButton
            accessibilityLabel="Connect a PC or online model"
            mode="contained"
            disabled={busy}
            loading={busy && activePath === "connect"}
            onPress={() => void followPath("connect")}
          >
            Connect a PC or online model
          </NativeButton>
        ) : null}
        {choices.length ? (
          choices.map((choice) => (
            <NativeButton
              accessibilityLabel={`Choose ${choice.tier} model ${choice.model.name}`}
              key={choice.tier}
              disabled={busy}
              onPress={() => setTier(choice.tier)}
            >
              {choice.tier}
              {choice === selected ? " ✓" : ""} · {choice.model.name}
            </NativeButton>
          ))
        ) : (
          <Text>
            No model has a verified fit estimate for this device yet. You can
            continue without downloading.
          </Text>
        )}
        {selected ? (
          <Text>
            Estimated working set{" "}
            {formatBytes(selected.estimatedWorkingSetBytes)}; download{" "}
            {formatBytes(selected.storageRequiredBytes)}. Actual fit depends on
            model and device conditions.
          </Text>
        ) : null}
        <NativeButton
          accessibilityLabel="Download suggested model"
          disabled={
            busy ||
            (!props.onBrowseModels &&
              (!selected || props.downloadAvailable === false))
          }
          onPress={() => void followPath("models")}
        >
          {props.onBrowseModels
            ? "Choose a phone model"
            : "Download suggestion"}
        </NativeButton>
        {props.downloadAvailable === false ? (
          <Text>
            Phone models are available in Models, with download progress and
            cancellation. You can also continue and add OpenRouter or a model
            server from chat.
          </Text>
        ) : null}
        {props.onRace ? (
          <NativeButton
            accessibilityLabel="Try optional model setup race"
            disabled={busy}
            onPress={() => void race()}
          >
            Try optional model race
          </NativeButton>
        ) : null}
        <NativeButton
          accessibilityLabel="Continue without a model"
          mode="contained"
          disabled={busy}
          onPress={() => void finish(null)}
        >
          Continue without a model
        </NativeButton>
      </NativeSurface>
      <Text>
        Your theme and setup style are saved on this device. You can configure a
        provider from chat whenever you are ready.
      </Text>
      {message ? <Text accessibilityLiveRegion="polite">{message}</Text> : null}
    </ScrollView>
  );
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return `${gib.toFixed(gib >= 10 ? 0 : 1)} GB`;
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 16 },
  card: { padding: 16, gap: 12 },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  phonePage: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 28,
    gap: 20,
  },
  phoneWelcome: { gap: 12 },
  phoneMark: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  phoneHeading: {
    fontSize: 32,
    lineHeight: 38,
    fontWeight: "700",
    letterSpacing: -0.7,
  },
  phoneIntro: { fontSize: 17, lineHeight: 25 },
  phoneSection: { gap: 12 },
  phoneChoices: { gap: 16 },
  phoneSegment: { minHeight: 48 },
  phoneModelCard: { borderRadius: 24, borderWidth: 1, padding: 20, gap: 12 },
  phoneSkip: { gap: 2 },
  phoneSkipCopy: { textAlign: "center" },
  phonePreferences: {
    borderRadius: 24,
    borderWidth: 1,
    padding: 4,
    overflow: "hidden",
  },
  phoneDisclosure: { backgroundColor: "transparent", padding: 0 },
  phoneDetails: { gap: 20, padding: 16 },
  phoneButtonContent: { minHeight: 48 },
  phonePrimaryContent: { minHeight: 52 },
  phonePrimaryButton: { borderRadius: 18 },
});
