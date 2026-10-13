import { useEffect, useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";
import { TextInput } from "react-native-paper";
import { NativeButton, useWorkspaceLayout } from "@locallab/ui-native-primitives";
import type { LmStudioIntegration } from "@locallab/tools-mcp-lmstudio";
import type { SQLiteLmStudioIntegrationStore } from "./lmstudio-integrations";

/**
 * LM Studio integrated-MCP names only. The host runs the servers; this app
 * stores which names exist and which are allowed for new messages. There is
 * deliberately no URL field here — remote MCP servers live in the MCP
 * servers section — and renaming a row changes only the display label.
 */
export function LmStudioIntegrationsSection({
  integrations,
}: {
  integrations: SQLiteLmStudioIntegrationStore;
}) {
  const { phone } = useWorkspaceLayout();
  const styles = phone ? phoneStyles : desktopStyles;
  const [rows, setRows] = useState<LmStudioIntegration[]>([]);
  const [nameDraft, setNameDraft] = useState("");
  const [labelDraft, setLabelDraft] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    void integrations
      .load()
      .then((next) => {
        if (active) setRows(next);
      })
      .catch(() => {
        if (active)
          setNotice(
            "LM Studio integration settings could not be loaded. Try again.",
          );
      });
    return () => {
      active = false;
    };
  }, [integrations]);
  async function addIntegration() {
    setNotice("");
    try {
      await integrations.add(nameDraft, labelDraft);
      setNameDraft("");
      setLabelDraft("");
      setRows(await integrations.load());
      setNotice(
        "Integration added. It starts disabled — turn it on to let LM Studio use it for new messages.",
      );
    } catch (cause) {
      setNotice(
        cause instanceof Error
          ? cause.message
          : "The integration could not be added.",
      );
    }
  }
  async function updateRow(row: LmStudioIntegration) {
    setNotice("");
    try {
      await integrations.save(row);
      setRows(await integrations.load());
    } catch (cause) {
      setNotice(
        cause instanceof Error
          ? cause.message
          : "The integration settings could not be saved.",
      );
    }
  }
  async function removeRow(row: LmStudioIntegration) {
    setNotice("");
    await integrations.remove(row.id);
    setRows(await integrations.load());
  }
  return (
    <View style={styles.card} testID="tool-settings-lmstudio">
      <Text style={styles.rowTitle}>LM Studio integrated MCP</Text>
      <Text style={styles.helper}>
        LM Studio runs these MCP servers itself from its own mcp.json on the
        computer; this phone only stores the names so it can ask for them by
        name. This works with LM Studio only — never with Ollama or other
        compatible servers.
      </Text>
      <View style={styles.addRow}>
        <TextInput
          mode="outlined"
          label="Server name (from mcp.json)"
          accessibilityLabel="LM Studio integration name"
          value={nameDraft}
          onChangeText={setNameDraft}
          autoCapitalize="none"
        />
        <TextInput
          mode="outlined"
          label="Display name (optional)"
          accessibilityLabel="LM Studio integration display name"
          value={labelDraft}
          onChangeText={setLabelDraft}
        />
        <NativeButton
          mode="outlined"
          onPress={() => void addIntegration()}
          accessibilityLabel="Add LM Studio integration"
          testID="tool-settings-lmstudio-add"
        >
          Add integration
        </NativeButton>
      </View>
      {rows.map((row) => (
        <View
          key={row.id}
          style={styles.server}
          testID={`tool-settings-lmstudio-${row.id}`}
        >
          <TextInput
            mode="outlined"
            label="Display name"
            accessibilityLabel={`Display name for LM Studio integration ${row.name}`}
            value={row.label}
            onChangeText={(value) =>
              setRows((current) =>
                current.map((item) =>
                  item.id === row.id ? { ...item, label: value } : item,
                ),
              )
            }
            onBlur={() => void updateRow(row)}
          />
          <Text style={styles.helper}>Sent to LM Studio as: {row.name}</Text>
          <View style={styles.switchRow}>
            <Switch
              value={row.enabled}
              onValueChange={(value) =>
                void updateRow({ ...row, enabled: value })
              }
              accessibilityLabel={`Enable LM Studio integration ${row.name}`}
              testID={`tool-settings-lmstudio-toggle-${row.id}`}
            />
            <Text style={styles.rowTitle}>Allow for new messages</Text>
          </View>
          <NativeButton
            mode="text"
            onPress={() => void removeRow(row)}
            accessibilityLabel={`Remove LM Studio integration ${row.name}`}
            testID={`tool-settings-lmstudio-remove-${row.id}`}
          >
            Remove
          </NativeButton>
        </View>
      ))}
      {notice !== "" ? (
        <Text style={styles.notice} testID="tool-settings-lmstudio-notice">
          {notice}
        </Text>
      ) : null}
    </View>
  );
}

const phoneStyles = StyleSheet.create({
  card: { padding: 16, gap: 12, marginBottom: 12 },
  addRow: { gap: 8 },
  server: {
    padding: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.3)",
    borderRadius: 8,
  },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowTitle: { fontWeight: "600" },
  helper: { opacity: 0.7 },
  notice: { fontWeight: "500" },
});
const desktopStyles = phoneStyles;
