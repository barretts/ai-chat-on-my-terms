import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Text, TextInput, useTheme } from "react-native-paper";
import type { MD3Theme } from "react-native-paper";
import { useWorkspaceLayout } from "@locallab/ui-native-primitives";
import { useAccount } from "./provider";

/** Optional account (AC-01). Local-only users can ignore this section
 * entirely: nothing in the app requires an account or this service. */
export function AccountSection() {
  const theme = useTheme();
  const { phone } = useWorkspaceLayout();
  const styles = StyleSheet.create(createStyles(theme, phone));
  const account = useAccount();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  if (!account.available)
    return (
      <View testID="account-unavailable">
        <Text accessibilityRole="header" style={styles.header}>
          Account
        </Text>
        <Text style={styles.hint}>
          Local-only mode: no account is required, and nothing is sent to an
          account service on this build.
        </Text>
      </View>
    );

  return (
    <View testID="account-section">
      <Text accessibilityRole="header" style={styles.header}>
        Account
      </Text>
      <Text style={styles.hint}>
        Optional. Your chats and settings stay on this device either way;
        signing out only removes the online session.
      </Text>
      {account.account === null ? (
        <>
          <View style={styles.row}>
            <TextInput
              testID="account-email"
              label="Email"
              value={email}
              onChangeText={setEmail}
              accessibilityLabel="Account email"
              autoCapitalize="none"
              style={styles.input}
            />
            <TextInput
              testID="account-password"
              label="Password"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
              accessibilityLabel="Account password"
              style={styles.input}
            />
          </View>
          <View style={styles.graceRow}>
            <Button
              testID="account-sign-in"
              mode="contained"
              loading={account.busy}
              disabled={account.busy || email.length === 0}
              onPress={() => void account.signIn(email, password)}
            >
              Sign in
            </Button>
            <Button
              testID="account-anonymous"
              loading={account.busy}
              disabled={account.busy}
              onPress={() => void account.anonymousSignIn()}
            >
              Anonymous account
            </Button>
          </View>
        </>
      ) : (
        <View style={styles.graceRow}>
          <Text style={styles.label}>
            Linked: {account.account.providers.map((p) => p.provider).join(", ")}
          </Text>
          <Button
            testID="account-sign-out"
            loading={account.busy}
            onPress={() => void account.signOut()}
          >
            Sign out
          </Button>
        </View>
      )}
      {account.error !== null && <Text style={styles.message}>{account.error}</Text>}
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
      alignItems: "center",
      marginBottom: 12,
    },
    label: { color: theme.colors.onBackground },
    hint: { color: theme.colors.onSurfaceVariant, marginBottom: 12 },
    input: { minWidth: 180 },
    message: { color: theme.colors.error },
  } as const;
}
