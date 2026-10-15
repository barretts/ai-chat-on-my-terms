import { useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Button,
  Switch,
  Text,
  TextInput,
  useTheme,
} from "react-native-paper";
import type { MD3Theme } from "react-native-paper";
import { useWorkspaceLayout } from "@locallab/ui-native-primitives";
import { GRACE_PERIODS, validatePin } from "@locallab/app-lock";
import type { GracePeriod } from "@locallab/app-lock";
import { useAppLock } from "./provider";

const GRACE_LABELS: Record<GracePeriod, string> = {
  immediate: "Immediate",
  fifteenSeconds: "15s",
  oneMinute: "1m",
  fiveMinutes: "5m",
  fifteenMinutes: "15m",
  oneHour: "1h",
};

/** Enable/disable App Lock, choose the grace period, change the PIN. */
export function AppLockSection() {
  const theme = useTheme();
  const { phone } = useWorkspaceLayout();
  const styles = StyleSheet.create(createStyles(theme, phone));
  const lock = useAppLock();
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [nextPin, setNextPin] = useState("");
  const [changePin, setChangePin] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const enable = async () => {
    const a = validatePin(newPin);
    const b = validatePin(confirmPin);
    if (!a.ok) {
      setMessage(a.reason);
      return;
    }
    if (!b.ok) {
      setMessage(b.reason);
      return;
    }
    if (newPin !== confirmPin) {
      setMessage("the two PIN entries must match");
      return;
    }
    const result = await lock.setPin(newPin);
    if (!result.ok) {
      setMessage(result.reason ?? null);
      return;
    }
    setNewPin("");
    setConfirmPin("");
    setMessage(null);
  };

  const disable = async () => {
    const result = await lock.disableWithPin(currentPin);
    if (!result.ok) {
      setMessage(result.reason ?? null);
      return;
    }
    setCurrentPin("");
    setMessage(null);
  };

  const rotatePin = async () => {
    const result = await lock.changePin(currentPin, nextPin);
    if (!result.ok) {
      setMessage(result.reason ?? null);
      return;
    }
    setCurrentPin("");
    setNextPin("");
    setChangePin(false);
    setMessage(null);
  };

  return (
    <View testID="app-lock-section">
      <Text accessibilityRole="header" style={styles.header}>
        App Lock
      </Text>
      <View style={styles.row}>
        <Text style={styles.label}>Require PIN when returning</Text>
        <Switch
          testID="app-lock-enabled"
          value={lock.hasLock}
          disabled={lock.hasLock}
          accessibilityLabel="Enable App Lock"
          onValueChange={() => undefined}
        />
      </View>

      {!lock.hasLock && (
        <>
          <Text style={styles.hint}>
            App Lock is a Pro feature; the PIN stays on this device and is
            never synced or backed up.
          </Text>
          <View style={styles.row}>
            <TextInput
              testID="app-lock-new-pin"
              label="New PIN (4 or 6 digits)"
              secureTextEntry
              keyboardType="number-pad"
              value={newPin}
              onChangeText={setNewPin}
              accessibilityLabel="New PIN"
              style={styles.input}
            />
            <TextInput
              testID="app-lock-confirm-pin"
              label="Confirm PIN"
              secureTextEntry
              keyboardType="number-pad"
              value={confirmPin}
              onChangeText={setConfirmPin}
              accessibilityLabel="Confirm PIN"
              style={styles.input}
            />
          </View>
          <View style={styles.row}>
            <Button
              testID="app-lock-enable"
              mode="contained"
              accessibilityLabel="Turn on App Lock"
              onPress={() => void enable()}
            >
              Turn on App Lock
            </Button>
          </View>
        </>
      )}

      {lock.hasLock && (
        <>
          <Text style={styles.hint}>
            Grace period: {GRACE_LABELS[lock.grace]}
          </Text>
          <View style={styles.graceRow}>
            {GRACE_PERIODS.map((period) => (
              <Button
                key={period}
                testID={`app-lock-grace-${period}`}
                mode={period === lock.grace ? "contained" : "outlined"}
                accessibilityLabel={`Grace period ${GRACE_LABELS[period]}`}
                onPress={() => void lock.setGrace(period)}
              >
                {GRACE_LABELS[period]}
              </Button>
            ))}
          </View>
          <View style={styles.row}>
            <TextInput
              testID="app-lock-current-pin"
              label="Current PIN"
              secureTextEntry
              keyboardType="number-pad"
              value={currentPin}
              onChangeText={setCurrentPin}
              accessibilityLabel="Current PIN"
              style={styles.input}
            />
          </View>
          {!changePin ? (
            <View style={styles.row}>
              <Button
                testID="app-lock-disable"
                accessibilityLabel="Turn off App Lock"
                onPress={() => void disable()}
              >
                Turn off App Lock
              </Button>
              <Button
                testID="app-lock-change-open"
                accessibilityLabel="Change PIN"
                onPress={() => setChangePin(true)}
              >
                Change PIN
              </Button>
            </View>
          ) : (
            <>
              <View style={styles.row}>
                <TextInput
                  testID="app-lock-next-pin"
                  label="New PIN (4 or 6 digits)"
                  secureTextEntry
                  keyboardType="number-pad"
                  value={nextPin}
                  onChangeText={setNextPin}
                  accessibilityLabel="New PIN"
                  style={styles.input}
                />
              </View>
              <View style={styles.row}>
                <Button
                  testID="app-lock-change-confirm"
                  mode="contained"
                  accessibilityLabel="Confirm new PIN"
                  onPress={() => void rotatePin()}
                >
                  Save new PIN
                </Button>
              </View>
            </>
          )}
        </>
      )}

      {message !== null && (
        <Text testID="app-lock-message" style={styles.message}>
          {message}
        </Text>
      )}
    </View>
  );
}

function createStyles(theme: MD3Theme, phone: boolean) {
  return {
    header: {
      fontSize: 18,
      fontWeight: "600",
      color: theme.colors.onBackground,
      marginBottom: 8,
    },
    row: {
      flexDirection: phone ? "column" : "row",
      gap: 12,
      marginBottom: 12,
    },
    graceRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      marginBottom: 12,
    },
    label: { color: theme.colors.onBackground },
    hint: { color: theme.colors.onSurfaceVariant, marginBottom: 12 },
    input: { minWidth: 180 },
    message: { color: theme.colors.error },
  } as const;
}
