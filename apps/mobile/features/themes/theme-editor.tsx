import { useState } from "react";
import { View } from "react-native";
import {
  Button,
  Menu,
  SegmentedButtons,
  Switch,
  Text,
  TextInput,
} from "react-native-paper";
import {
  BUILTIN_THEMES,
  isHexColor,
  parseOverrideImport,
  parseThemeImport,
  type AppearanceOverrideV1,
  type AvatarSize,
  type BubbleStyle,
  type FontChoice,
  type PaletteV1,
  type ThemeControlsV1,
  type ThemeV1,
  type ThemeScheme,
} from "@locallab/themes-schema";
import { useAppTheme } from "./provider";
import { PhoneSheet } from "./phone-sheet";

/** Sample avatar diameters for the live preview, keyed by the schema enum. */
const AVATAR_DIAMETERS: Record<AvatarSize, number> = {
  small: 24,
  medium: 36,
  large: 52,
};

/** Corner radius the preview bubble shows for each bubble style. */
const BUBBLE_RADII: Record<BubbleStyle, number> = {
  classic: 12,
  rounded: 22,
  sharp: 0,
};

const BUBBLE_OPTIONS: { value: BubbleStyle; label: string }[] = [
  { value: "classic", label: "Classic" },
  { value: "rounded", label: "Rounded" },
  { value: "sharp", label: "Sharp" },
];
const AVATAR_SIZE_OPTIONS: { value: AvatarSize; label: string }[] = [
  { value: "small", label: "S" },
  { value: "medium", label: "M" },
  { value: "large", label: "L" },
];
const AVATAR_PLACEMENT_OPTIONS: {
  value: "leading" | "trailing" | "hidden";
  label: string;
}[] = [
  { value: "leading", label: "Left" },
  { value: "trailing", label: "Right" },
  { value: "hidden", label: "Off" },
];
const FONT_OPTIONS: { value: FontChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "serif", label: "Serif" },
  { value: "mono", label: "Mono" },
];

function Stepper({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  onChange: (delta: number) => void;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingVertical: 8,
      }}
    >
      <Text variant="bodyMedium">
        {label}: {value.toFixed(2)}
      </Text>
      <View style={{ flexDirection: "row", gap: 4 }}>
        <Button compact onPress={() => onChange(-step)}>
          −
        </Button>
        <Button compact onPress={() => onChange(step)}>
          +
        </Button>
      </View>
    </View>
  );
}

/** Live theme editor sheet: global custom themes, or per-chat overrides. */
export function ThemeEditorSheet({
  visible,
  onClose,
  conversationId,
}: {
  visible: boolean;
  onClose: () => void;
  conversationId?: string;
}) {
  const settings = useAppTheme();
  const perChat = conversationId !== undefined;
  const allThemes = [...BUILTIN_THEMES, ...settings.customThemes];
  const [selectedId, setSelectedId] = useState(() =>
    perChat && conversationId !== undefined
      ? settings.chatAppearanceFor(conversationId).theme.id
      : settings.themeId,
  );
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [draftId, setDraftId] = useState("");
  const [draftName, setDraftName] = useState("");
  const [scheme, setScheme] = useState<ThemeScheme>("light");
  const [paletteDraft, setPaletteDraft] = useState<Record<keyof PaletteV1, string>>({
    background: "#f8f9fb",
    surface: "#ffffff",
    primary: "#2f5fa8",
    text: "#20232b",
  });
  const [controls, setControls] = useState<ThemeControlsV1>(() => ({
    fontScale: 1,
    bubbleStyle: "classic",
    gradient: null,
    backgroundDim: 0,
    avatarSize: "medium",
    avatarPlacement: "leading",
    fontChoice: "system",
  }));
  const [message, setMessage] = useState("");
  const [importText, setImportText] = useState("");
  const selected =
    allThemes.find((candidate) => candidate.id === selectedId) ?? allThemes[0];
  function selectTheme(id: string) {
    const theme = allThemes.find((candidate) => candidate.id === id);
    setSelectedId(id);
    if (theme === undefined) return;
    setScheme(theme.variants ? scheme : theme.scheme);
    setPaletteDraft({
      ...(theme.variants ? theme.variants[scheme] : theme.palette),
    });
    setControls({ ...theme.controls, gradient: theme.controls.gradient });
  }
  function chooseTheme(id: string) {
    selectTheme(id);
    if (!perChat) void settings.setThemeId(id);
  }
  const paletteReady = (Object.keys(paletteDraft) as (keyof PaletteV1)[]).every(
    (key) => isHexColor(paletteDraft[key]),
  );
  const previewPalette = paletteReady ? paletteDraft : (selected?.palette ?? paletteDraft);
  const previewDim = controls.gradient ?? null;
  async function saveDraft() {
    if (perChat && conversationId !== undefined) {
      const override: AppearanceOverrideV1 = {
        version: 1,
        themeId: selectedId,
        fontScale: controls.fontScale,
        bubbleStyle: controls.bubbleStyle,
        gradient: controls.gradient,
        backgroundDim: controls.backgroundDim,
        avatarSize: controls.avatarSize,
        avatarPlacement: controls.avatarPlacement,
        fontChoice: controls.fontChoice,
      };
      await settings.setChatOverrideFor(conversationId, override);
      setMessage("Chat appearance saved.");
      return;
    }
    const id = draftId.trim();
    const name = draftName.trim() || "My theme";
    const theme: ThemeV1 = {
      version: 1,
      id,
      name,
      kind: "custom",
      scheme,
      palette: {
        background: paletteDraft.background,
        surface: paletteDraft.surface,
        primary: paletteDraft.primary,
        text: paletteDraft.text,
      },
      controls,
    };
    const result = await settings.saveCustomTheme(theme);
    if (!result.ok) {
      setMessage(result.reason);
      return;
    }
    await settings.setThemeId(id);
    setSelectedId(id);
    setMessage(`Theme "${name}" saved and applied.`);
  }
  async function importTextAsJson() {
    let raw: unknown;
    try {
      raw = JSON.parse(importText);
    } catch {
      setMessage("Import must be valid JSON.");
      return;
    }
    const asTheme = parseThemeImport(raw);
    if (asTheme.ok) {
      const result = await settings.saveCustomTheme({
        ...asTheme.theme,
        version: 1,
      });
      if (!result.ok) {
        setMessage(result.reason);
        return;
      }
      await settings.setThemeId(asTheme.theme.id);
      setSelectedId(asTheme.theme.id);
      setImportText("");
      setMessage(`Imported theme "${asTheme.theme.name}".`);
      return;
    }
    const asOverride = parseOverrideImport(raw);
    if (asOverride.ok && conversationId !== undefined) {
      await settings.setChatOverrideFor(conversationId, asOverride.override);
      setImportText("");
      setMessage("Imported chat appearance.");
      return;
    }
    setMessage(asTheme.reason);
  }
  return (
    <PhoneSheet
      visible={visible}
      onClose={onClose}
      testID="theme-editor"
      title={perChat ? "Chat appearance" : "Themes"}
      closeLabel="Close theme editor"
    >
      <Text variant="labelLarge">Theme set</Text>
      <Menu
        visible={themeMenuOpen}
        onDismiss={() => setThemeMenuOpen(false)}
        anchor={
          <Button
            mode="outlined"
            testID="theme-set-select"
            accessibilityLabel="Choose theme set"
            onPress={() => setThemeMenuOpen(true)}
            style={{ marginTop: 4 }}
          >
            {selected?.name ?? "Choose a theme set"}
          </Button>
        }
      >
        {allThemes.map((theme) => (
          <Menu.Item
            key={theme.id}
            testID={`theme-option-${theme.id}`}
            title={
              !perChat && theme.id === settings.themeId
                ? `${theme.name} (active)`
                : theme.name
            }
            onPress={() => {
              setThemeMenuOpen(false);
              chooseTheme(theme.id);
            }}
          />
        ))}
      </Menu>
      {selected?.variants !== undefined && (
        <Text variant="bodySmall" style={{ marginTop: 4 }}>
          Includes light and dark palettes; the active one follows your
          System/Light/Dark setting.
        </Text>
      )}
      {!perChat && (
        <>
          <Text
            variant="labelLarge"
            style={{ marginTop: 16 }}
          >New custom theme</Text>
          <TextInput
            label="Id (a-z0-9-)"
            value={draftId}
            onChangeText={setDraftId}
            autoCapitalize="none"
            style={{ marginTop: 4 }}
          />
          <TextInput
            label="Name"
            value={draftName}
            onChangeText={setDraftName}
            style={{ marginTop: 4 }}
          />
          <View
            style={{
              flexDirection: "row",
              gap: 4,
              marginTop: 8,
              alignItems: "center",
            }}
          >
            <Text variant="bodyMedium">Palette</Text>
            {(Object.keys(paletteDraft) as (keyof PaletteV1)[]).map((key) => (
              <TextInput
                key={key}
                label={key}
                value={paletteDraft[key]}
                onChangeText={(value) =>
                  setPaletteDraft((current) => ({ ...current, [key]: value }))
                }
                autoCapitalize="none"
                style={{ flex: 1, minWidth: 80 }}
              />
            ))}
          </View>
          <SegmentedButtons
            value={scheme}
            onValueChange={(value) => {
              const next = value as ThemeScheme;
              setScheme(next);
              if (selected?.variants !== undefined)
                setPaletteDraft({ ...selected.variants[next] });
            }}
            buttons={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            style={{ marginTop: 8 }}
          />
        </>
      )}
      <Text variant="labelLarge" style={{ marginTop: 16 }}>
        Reading
      </Text>
      <Stepper
        label="Font size"
        value={controls.fontScale}
        step={0.1}
        onChange={(delta) =>
          setControls((current) => ({
            ...current,
            fontScale: Math.min(
              2.0,
              Math.max(0.8, Math.round((current.fontScale + delta) * 10) / 10),
            ),
          }))
        }
      />
      <SegmentedButtons
        value={controls.bubbleStyle}
        onValueChange={(value) =>
          setControls((current) => ({
            ...current,
            bubbleStyle: value as BubbleStyle,
          }))
        }
        buttons={BUBBLE_OPTIONS}
      />
      <SegmentedButtons
        value={controls.fontChoice}
        onValueChange={(value) =>
          setControls((current) => ({
            ...current,
            fontChoice: value as FontChoice,
          }))
        }
        buttons={FONT_OPTIONS}
        style={{ marginTop: 8 }}
      />
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 12,
        }}
      >
        <Text variant="labelLarge">Background</Text>
        <Switch
          value={controls.gradient !== null}
          onValueChange={(enabled) =>
            setControls((current) => ({
              ...current,
              gradient: enabled
                ? {
                    from: "#2f5fa8",
                    to: "#176e70",
                    angleDegrees: 90,
                  }
                : null,
            }))
          }
        />
      </View>
      <Stepper
        label="Dim"
        value={controls.backgroundDim}
        step={0.1}
        onChange={(delta) =>
          setControls((current) => ({
            ...current,
            backgroundDim: Math.min(
              0.6,
              Math.max(
                0,
                Math.round((current.backgroundDim + delta) * 100) / 100,
              ),
            ),
          }))
        }
      />
      {controls.gradient !== null && (
        <View
          style={{ flexDirection: "row", gap: 4, alignItems: "center" }}
        >
          <TextInput
            label="From"
            value={controls.gradient.from}
            onChangeText={(value) =>
              setControls((current) =>
                current.gradient === null || !isHexColor(value)
                  ? current
                  : {
                      ...current,
                      gradient: { ...current.gradient, from: value },
                    },
              )
            }
            autoCapitalize="none"
            style={{ flex: 1 }}
          />
          <TextInput
            label="To"
            value={controls.gradient.to}
            onChangeText={(value) =>
              setControls((current) =>
                current.gradient === null || !isHexColor(value)
                  ? current
                  : {
                      ...current,
                      gradient: { ...current.gradient, to: value },
                    },
              )
            }
            autoCapitalize="none"
            style={{ flex: 1 }}
          />
          <TextInput
            label="Angle"
            value={String(controls.gradient.angleDegrees)}
            keyboardType="numeric"
            onChangeText={(value) => {
              const angle = Number(value);
              setControls((current) =>
                current.gradient === null ||
                !Number.isInteger(angle) ||
                angle < 0 ||
                angle > 359
                  ? current
                  : { ...current, gradient: { ...current.gradient, angleDegrees: angle } },
              );
            }}
            style={{ flex: 1 }}
          />
        </View>
      )}
      <Text variant="labelLarge" style={{ marginTop: 12 }}>
        Avatars
      </Text>
      <SegmentedButtons
        value={controls.avatarSize}
        onValueChange={(value) =>
          setControls((current) => ({
            ...current,
            avatarSize: value as AvatarSize,
          }))
        }
        buttons={AVATAR_SIZE_OPTIONS}
      />
      <SegmentedButtons
        value={controls.avatarPlacement}
        onValueChange={(value) =>
          setControls((current) => ({
            ...current,
            avatarPlacement: value as (typeof AVATAR_PLACEMENT_OPTIONS)[number]["value"],
          }))
        }
        buttons={AVATAR_PLACEMENT_OPTIONS}
        style={{ marginTop: 8 }}
      />
      <Text variant="labelLarge" style={{ marginTop: 16 }}>
        Preview
      </Text>
      <View
        style={{
          backgroundColor: previewPalette.background,
          padding: 12,
          borderRadius: 12,
          marginTop: 4,
        }}
      >
        {previewDim !== null && (
          <View
            style={{
              flexDirection: "row",
              height: 6,
              borderRadius: 3,
              overflow: "hidden",
              marginBottom: 8,
            }}
          >
            <View style={{ flex: 1, backgroundColor: previewDim.from }} />
            <View style={{ flex: 1, backgroundColor: previewDim.to }} />
          </View>
        )}
        <View
          style={{
            flexDirection:
              controls.avatarPlacement === "trailing"
                ? "row-reverse"
                : "row",
            alignItems: "center",
            gap: 8,
          }}
        >
          {controls.avatarPlacement !== "hidden" && (
            <View
              style={{
                width: AVATAR_DIAMETERS[controls.avatarSize],
                height: AVATAR_DIAMETERS[controls.avatarSize],
                borderRadius: AVATAR_DIAMETERS[controls.avatarSize] / 2,
                backgroundColor: previewPalette.primary,
              }}
            />
          )}
          <View
            style={{
              backgroundColor: previewPalette.surface,
              borderRadius: BUBBLE_RADII[controls.bubbleStyle],
              padding: 10,
            }}
          >
            <Text
              style={{
                color: previewPalette.text,
                fontSize: 14 * controls.fontScale,
              }}
            >
              How does this look?
            </Text>
          </View>
        </View>
      </View>
      <Button mode="contained" onPress={saveDraft} style={{ marginTop: 16 }}>
        {perChat ? "Apply to this chat" : "Save theme and apply"}
      </Button>
      {perChat && conversationId !== undefined && (
        <Button
          mode="text"
          onPress={() => {
            void settings
              .setChatOverrideFor(conversationId, null)
              .then(() => setMessage("Using global theme again."));
          }}
        >
          Use global appearance
        </Button>
      )}
      <Text variant="labelLarge" style={{ marginTop: 16 }}>
        Import (theme JSON, or appearance JSON in chat mode)
      </Text>
      <TextInput
        multiline
        value={importText}
        onChangeText={setImportText}
        autoCapitalize="none"
        style={{ marginTop: 4 }}
      />
      <View style={{ flexDirection: "row", gap: 4, marginTop: 8 }}>
        <Button compact onPress={() => void importTextAsJson()}>
          Import
        </Button>
        <Button
          compact
          onPress={() => {
            if (selected === undefined) return;
            setImportText(JSON.stringify(selected, undefined, 2));
          }}
        >
          Export selected
        </Button>
      </View>
      {message.length > 0 && (
        <Text variant="bodySmall" style={{ marginTop: 8 }}>
          {message}
        </Text>
      )}
    </PhoneSheet>
  );
}
