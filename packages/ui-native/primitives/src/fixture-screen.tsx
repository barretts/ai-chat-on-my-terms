import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { PaperProvider } from "react-native-paper";
import { colors, spacing } from "@locallab/ui-tokens";
import { NativeButton } from "./native-button";
import { NativeInput } from "./native-input";
import { NativeSurface } from "./native-surface";
import { NativeText } from "./native-text";
import { nativeTheme } from "./theme";

/** Native-only fixture for touch, Dynamic Type, and keyboard-focus smoke checks. */
export function NativePrimitivesFixtureScreen() {
  const [name, setName] = useState("");
  const [status, setStatus] = useState("Ready");

  return (
    <PaperProvider
      theme={nativeTheme}
      settings={{
        icon: (props) => <MaterialCommunityIcons {...props} />,
      }}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        style={styles.screen}
        contentContainerStyle={styles.content}
      >
        <NativeText
          accessibilityLabel="Native primitives fixture"
          variant="headlineMedium"
        >
          Native UI fixture
        </NativeText>
        <NativeText
          accessibilityLabel="Fixture supports large text"
          variant="bodyLarge"
        >
          Try large text, touch the button, and focus the input.
        </NativeText>
        <NativeSurface
          accessibilityLabel="Interactive fixture surface"
          style={styles.surface}
        >
          <View style={styles.stack}>
            <NativeText accessibilityLabel="Your name" variant="titleMedium">
              Your name
            </NativeText>
            <NativeInput
              accessibilityLabel="Enter your name"
              autoCapitalize="words"
              onChangeText={setName}
              placeholder="Name"
              returnKeyType="done"
              value={name}
            />
            <NativeButton
              accessibilityLabel="Save fixture name"
              onPress={() =>
                setStatus(
                  name.trim() ? `Saved ${name.trim()}` : "Enter a name first",
                )
              }
              mode="contained"
            >
              Save
            </NativeButton>
            <NativeText
              accessibilityLabel={`Status: ${status}`}
              accessibilityLiveRegion="polite"
            >
              {status}
            </NativeText>
          </View>
        </NativeSurface>
      </ScrollView>
    </PaperProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.xl, gap: spacing.lg },
  surface: { padding: spacing.lg, borderRadius: 16 },
  stack: { gap: spacing.md },
});
