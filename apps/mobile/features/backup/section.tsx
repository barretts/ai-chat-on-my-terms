import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Text, TextInput, useTheme } from "react-native-paper";
import type { MD3Theme } from "react-native-paper";
import { useWorkspaceLayout } from "@locallab/ui-native-primitives";
import { useBackup } from "./provider";

/** Encrypted backup: passphrase, cloud object id, create/restore actions. */
export function BackupSection() {
  const theme = useTheme();
  const { phone } = useWorkspaceLayout();
  const styles = StyleSheet.create(createStyles(theme, phone));
  const backup = useBackup();
  const [passphrase, setPassphrase] = useState("");
  const [objectId, setObjectId] = useState("workspace-backup");
  const [confirmRestore, setConfirmRestore] = useState(false);

  return (
    <View testID="backup-section">
      <Text accessibilityRole="header" style={styles.header}>
        Encrypted Backup
      </Text>
      <Text style={styles.hint}>
        Your chats, personas and attachments are encrypted on this device with
        your passphrase before upload. We never see the passphrase, PINs, or
        plaintext. Restores replace local data and roll back completely on
        failure.
      </Text>

      {!backup.cryptoAvailable && (
        <Text testID="backup-unavailable" style={styles.message}>
          Backup encryption is not available on this build yet.
        </Text>
      )}

      <TextInput
        testID="backup-passphrase"
        label="Backup passphrase"
        secureTextEntry
        value={passphrase}
        onChangeText={setPassphrase}
        accessibilityLabel="Backup passphrase"
        style={styles.input}
      />
      <Text style={styles.hint}>
        At least 8 characters; losing it means losing the backup.
      </Text>
      <TextInput
        testID="backup-object-id"
        label="Backup id on the server"
        value={objectId}
        onChangeText={setObjectId}
        accessibilityLabel="Backup object id"
        style={styles.input}
      />

      <View style={styles.row}>
        <Button
          testID="backup-create"
          mode="contained"
          loading={backup.busy}
          disabled={!backup.cryptoAvailable || !backup.storeConfigured || passphrase.length < 8}
          accessibilityLabel="Create and upload encrypted backup"
          onPress={() => void backup.createAndUpload(passphrase, objectId)}
        >
          Back up now
        </Button>
        {confirmRestore ? (
          <Button
            testID="backup-restore-confirm"
            mode="contained"
            buttonColor={theme.colors.error}
            loading={backup.busy}
            disabled={!backup.cryptoAvailable || !backup.storeConfigured}
            accessibilityLabel="Confirm restore"
            onPress={() => {
              setConfirmRestore(false);
              void backup.restoreFromStore(passphrase, objectId);
            }}
          >
            Replace local data? Yes
          </Button>
        ) : (
          <Button
            testID="backup-restore"
            mode="outlined"
            disabled={!backup.cryptoAvailable || !backup.storeConfigured}
            accessibilityLabel="Restore from encrypted backup"
            onPress={() => setConfirmRestore(true)}
          >
            Restore from cloud
          </Button>
        )}
      </View>

      {backup.lastPreview !== null && (
        <Text testID="backup-last-preview" style={styles.hint}>
          Last backup: {backup.lastPreview.manifest.createdAt} — chats:{" "}
          {String(backup.lastPreview.manifest.counts.chats)}, personas:{" "}
          {String(backup.lastPreview.manifest.counts.personas)}, attachments:{" "}
          {String(backup.lastPreview.manifest.counts.attachments)}
        </Text>
      )}
      {backup.error !== null && (
        <Text testID="backup-error" style={styles.message}>
          {backup.error}
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
    hint: { color: theme.colors.onSurfaceVariant, marginBottom: 12 },
    input: { minWidth: 180, marginBottom: 12 },
    message: { color: theme.colors.error, marginBottom: 12 },
  } as const;
}
