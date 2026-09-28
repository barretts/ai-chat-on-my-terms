import { useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import type { FitMode, ModelFitChoice } from "@locallab/models-fit";
import type { OnboardingState, OnboardingTheme } from "./index";
import { NativeButton, NativeSurface } from "@locallab/ui-native-primitives";

export function OnboardingScreen(props: {
  recommendations: readonly ModelFitChoice[];
  initialState?: Pick<OnboardingState, "mode" | "theme">;
  downloadAvailable?: boolean;
  onBrowseModels?(): void;
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
  const [tier, setTier] = useState<ModelFitChoice["tier"]>("balanced");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState("");
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
    setMessage("");
    try {
      if (modelId) await props.onDownload(modelId);
      await props.onFinish({ mode, theme, modelId });
      setMessage(
        modelId
          ? "Model is ready. Your setup is saved."
          : "Setup saved. Add a model whenever you are ready.",
      );
    } catch {
      setMessage(
        "Setup could not finish. Check available space and try again, or continue without a model.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const race = async () => {
    if (!props.onRace || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const modelId = await props.onRace();
      await props.onFinish({ mode, theme, modelId });
      setMessage(
        modelId
          ? "The first model setup completed."
          : "Model race stopped. You can choose a model later.",
      );
    } catch {
      setMessage(
        "Model setup did not complete. You can continue without a model.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <ScrollView
      style={{ backgroundColor: paperTheme.colors.background }}
      contentContainerStyle={styles.page}
    >
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
            onPress={() => {
              setMode("beginner");
              void props
                .onModeChange?.("beginner")
                .catch(() =>
                  setMessage("The setup style could not be saved. Try again."),
                );
            }}
          >
            Beginner
          </NativeButton>
          <NativeButton
            accessibilityLabel="Choose power user setup"
            accessibilityState={{ selected: mode === "power" }}
            mode={mode === "power" ? "contained" : "outlined"}
            disabled={busy}
            onPress={() => {
              setMode("power");
              void props
                .onModeChange?.("power")
                .catch(() =>
                  setMessage("The setup style could not be saved. Try again."),
                );
            }}
          >
            Power user
          </NativeButton>
        </View>
        <Text>
          {mode === "beginner"
            ? "Beginner setup offers a guided start with a recommended model."
            : "Power user setup shows model size and memory estimates so you can choose your own setup."}
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
              onPress={() => {
                setTheme(value);
                void props
                  .onThemeChange?.(value)
                  .catch(() =>
                    setMessage("The theme could not be saved. Try again."),
                  );
              }}
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
          Get started with a local model
        </Text>
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
          onPress={() =>
            props.onBrowseModels
              ? props.onBrowseModels()
              : selected && void finish(selected.model.id)
          }
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
      {message ? <Text accessibilityRole="alert">{message}</Text> : null}
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
});
