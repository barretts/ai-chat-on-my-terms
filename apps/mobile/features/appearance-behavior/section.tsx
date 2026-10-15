import { StyleSheet, View } from "react-native";
import { SegmentedButtons, Switch, Text, useTheme } from "react-native-paper";
import type { MD3Theme } from "react-native-paper";
import { useWorkspaceLayout } from "@locallab/ui-native-primitives";
import { useAppearanceBehavior } from "./provider";
import type { LowBatteryMode } from "@locallab/appearance-behavior";

const MODE_LABELS: Record<LowBatteryMode, string> = {
  off: "Off",
  auto: "Auto",
  on: "On",
};

/** Glass toggle, low-battery profile selector, and full-width reply toggle. */
export function AppearanceBehaviorSection() {
  const theme = useTheme();
  const { phone } = useWorkspaceLayout();
  const styles = StyleSheet.create(createStyles(theme, phone));
  const { behavior, updateBehavior } = useAppearanceBehavior();
  return (
    <View testID="appearance-behavior-section">
      <Text accessibilityRole="header" style={styles.header}>
        Display behavior
      </Text>
      <View style={styles.row}>
        <Text style={styles.label}>Glass effects</Text>
        <Switch
          value={behavior.glassEnabled}
          onValueChange={(glassEnabled) =>
            void updateBehavior({ ...behavior, glassEnabled })
          }
          accessibilityLabel="Toggle glass effects"
        />
      </View>
      <Text style={styles.label}>Low battery mode</Text>
      <SegmentedButtons
        value={behavior.lowBatteryMode}
        onValueChange={(value) =>
          void updateBehavior({
            ...behavior,
            lowBatteryMode: value as LowBatteryMode,
          })
        }
        buttons={(["off", "auto", "on"] as const).map((mode) => ({
          value: mode,
          label: MODE_LABELS[mode],
          accessibilityLabel: `Low battery mode ${MODE_LABELS[mode]}`,
        }))}
      />
      <View style={styles.row}>
        <Text style={styles.label}>Full-width assistant replies</Text>
        <Switch
          value={behavior.fullWidthReplies}
          onValueChange={(fullWidthReplies) =>
            void updateBehavior({ ...behavior, fullWidthReplies })
          }
          accessibilityLabel="Toggle full-width assistant replies"
        />
      </View>
    </View>
  );
}

function createStyles(theme: MD3Theme, phone: boolean) {
  return {
    header: {
      fontSize: 14,
      fontWeight: "600" as const,
      color: theme.colors.onSurface,
      marginTop: phone ? 12 : 16,
      marginBottom: 8,
    },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      minHeight: 44,
      gap: 8,
    },
    label: {
      color: theme.colors.onSurfaceVariant,
      flexShrink: 1,
    },
  };
}
