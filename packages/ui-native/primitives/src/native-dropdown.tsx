import { useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { IconButton, Text, TextInput, useTheme } from "react-native-paper";
import { NativeButton } from "./native-button";
import { SafeAreaView } from "react-native-safe-area-context";

/** Searchable picker with bounded rendering and full-size mobile touch targets. */
export function NativeDropdown({
  label,
  value,
  options,
  onChange,
  onOpen,
  disabled,
  loading,
  emptyText = "No options available. Load the list first.",
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string; detail?: string }[];
  onChange(value: string): void;
  onOpen?(): void;
  disabled?: boolean;
  loading?: boolean;
  emptyText?: string;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedLabel =
    options.find((option) => option.value === value)?.label ||
    value ||
    "Choose…";
  const matching = options.filter((option) =>
    `${option.label} ${option.value}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <View style={{ gap: 5 }}>
      <Text variant="labelMedium">{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: selectedLabel }}
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        onPress={() => {
          setQuery("");
          setOpen(true);
          onOpen?.();
        }}
        style={[
          styles.anchor,
          theme.roundness > 0 && {
            borderRadius: 12,
            borderWidth: 1,
            minHeight: 52,
          },
          {
            backgroundColor: theme.dark ? theme.colors.surface : "#fffdf8",
            borderColor: theme.colors.outline,
          },
        ]}
      >
        <Text numberOfLines={1} style={{ flex: 1 }}>
          {selectedLabel}
        </Text>
        <Text style={{ color: theme.colors.primary }}>
          {loading ? "…" : "▼"}
        </Text>
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <SafeAreaView
          edges={["top", "bottom", "left", "right"]}
          style={{ flex: 1 }}
        >
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            style={styles.overlay}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Dismiss ${label}`}
              onPress={() => setOpen(false)}
              style={StyleSheet.absoluteFill}
            />
            <View
              accessibilityViewIsModal
              style={[
                styles.popup,
                theme.roundness > 0 && {
                  borderRadius: 24,
                  borderWidth: 1,
                  overflow: "hidden",
                },
                {
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.outline,
                },
              ]}
            >
              <View
                style={[
                  styles.title,
                  { backgroundColor: theme.colors.primary },
                  theme.roundness > 0 && {
                    backgroundColor: theme.colors.surface,
                    paddingVertical: 8,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.titleText,
                    { color: theme.colors.onPrimary },
                    theme.roundness > 0 && {
                      color: theme.colors.onSurface,
                      fontSize: 20,
                      flex: 1,
                    },
                  ]}
                >
                  {label}
                </Text>
                {theme.roundness > 0 ? (
                  <IconButton
                    icon="close"
                    accessibilityLabel={`Close ${label}`}
                    style={{ width: 44, height: 44, margin: 0 }}
                    onPress={() => setOpen(false)}
                  />
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Close ${label}`}
                    onPress={() => setOpen(false)}
                    hitSlop={10}
                  >
                    <Text
                      style={[
                        styles.titleText,
                        { color: theme.colors.onPrimary },
                      ]}
                    >
                      ×
                    </Text>
                  </Pressable>
                )}
              </View>
              <TextInput
                label={`Search ${label.toLowerCase()}`}
                accessibilityLabel={`Search ${label.toLowerCase()}`}
                value={query}
                onChangeText={setQuery}
                autoCapitalize="none"
                autoCorrect={false}
                mode="outlined"
                style={{ margin: 12 }}
              />
              <ScrollView
                keyboardShouldPersistTaps="handled"
                style={{ maxHeight: 340 }}
                contentContainerStyle={{ padding: 8 }}
              >
                {loading ? (
                  <Text
                    accessibilityLiveRegion="polite"
                    style={{ padding: 12 }}
                  >
                    Reading models from your endpoint…
                  </Text>
                ) : null}
                {matching.slice(0, 80).map((option) => (
                  <Pressable
                    key={option.value}
                    accessibilityRole="button"
                    accessibilityLabel={`Choose ${option.label}`}
                    accessibilityState={{ selected: value === option.value }}
                    onPress={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    style={{
                      padding: 12,
                      minHeight: 48,
                      backgroundColor:
                        value === option.value
                          ? theme.colors.primaryContainer
                          : "transparent",
                      borderBottomWidth: 1,
                      borderColor: theme.colors.outlineVariant,
                    }}
                  >
                    <Text
                      style={{
                        fontWeight: value === option.value ? "700" : "400",
                      }}
                    >
                      {option.label}
                    </Text>
                    {option.detail ? (
                      <Text variant="bodySmall">{option.detail}</Text>
                    ) : null}
                  </Pressable>
                ))}
                {!matching.length && !loading ? (
                  <Text style={{ padding: 12 }}>
                    {query ? "No matches. Try another search." : emptyText}
                  </Text>
                ) : null}
              </ScrollView>
              <View style={{ padding: 12, gap: 8 }}>
                <Text variant="bodySmall">
                  {matching.length} matches
                  {matching.length > 80 ? " · Search to narrow the list" : ""}
                </Text>
                <NativeButton
                  accessibilityLabel={`Done choosing ${label}`}
                  onPress={() => setOpen(false)}
                >
                  Done
                </NativeButton>
              </View>
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    </View>
  );
}
const styles = StyleSheet.create({
  anchor: {
    minHeight: 48,
    borderWidth: 2,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  overlay: {
    flex: 1,
    backgroundColor: "#00000070",
    justifyContent: "center",
    alignItems: "center",
    padding: 18,
  },
  popup: { width: "100%", maxWidth: 480, maxHeight: "85%", borderWidth: 2 },
  title: {
    padding: 10,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  titleText: { fontWeight: "700" },
});
