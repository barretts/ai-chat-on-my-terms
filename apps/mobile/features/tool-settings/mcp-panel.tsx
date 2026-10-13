import { useEffect, useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";
import { TextInput } from "react-native-paper";
import { NativeButton, useWorkspaceLayout } from "@locallab/ui-native-primitives";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import { McpHttpClient, mcpErrorResult } from "@locallab/tools-mcp-http";
import {
  resolveMcpHeaders,
  validateMcpUrl,
} from "./mcp-servers";
import type { McpServerRow, SQLiteMcpServerStore } from "./mcp-servers";

/**
 * Explicit MCP server management: add a labeled URL with an optional key,
 * check the server, then enable the server and each discovered tool
 * separately. Nothing here auto-enables a tool, and the remote tool name is
 * the identity that invocations and history use.
 */
export function McpServersSection({
  servers,
  secrets,
}: {
  servers: SQLiteMcpServerStore;
  secrets: SecretStore;
}) {
  const { phone } = useWorkspaceLayout();
  const styles = phone ? phoneStyles : desktopStyles;
  const [rows, setRows] = useState<McpServerRow[]>([]);
  const [labelDraft, setLabelDraft] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState("");
  useEffect(() => {
    let active = true;
    void servers
      .load()
      .then((next) => {
        if (active) setRows(next);
      })
      .catch(() => {
        if (active)
          setNotice("MCP server settings could not be loaded. Try again.");
      });
    return () => {
      active = false;
    };
  }, [servers]);
  async function addServer() {
    setNotice("");
    try {
      const url = validateMcpUrl(urlDraft.trim());
      const label =
        labelDraft.trim() === "" ? new URL(url).hostname : labelDraft.trim();
      const id = globalThis.crypto.randomUUID();
      const authRef =
        keyDraft.trim() === ""
          ? undefined
          : (
              await secrets.put(
                new URL(url).origin,
                "authorization",
                `Bearer ${keyDraft.trim()}`,
              )
            ).ref;
      await servers.save({
        id,
        label,
        url,
        enabled: false,
        toolEnabled: {},
        ...(authRef === undefined ? {} : { authRef }),
      });
      setLabelDraft("");
      setUrlDraft("");
      setKeyDraft("");
      setRows(await servers.load());
      setNotice(
        "Server added. It starts disabled — check it, then enable it and the tools you want.",
      );
    } catch (cause) {
      setNotice(
        cause instanceof Error ? cause.message : "The server could not be added.",
      );
    }
  }
  async function updateRow(row: McpServerRow) {
    setNotice("");
    try {
      await servers.save(row);
      setRows(await servers.load());
    } catch (cause) {
      setNotice(
        cause instanceof Error
          ? cause.message
          : "The server settings could not be saved.",
      );
    }
  }
  async function checkRow(row: McpServerRow) {
    setNotice("");
    setBusyId(row.id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const headers = await resolveMcpHeaders(secrets, row);
      const client = new McpHttpClient({
        id: row.id,
        label: row.label,
        url: row.url,
        ...(Object.keys(headers).length ? { headers } : {}),
      });
      try {
        await client.initialize(controller.signal);
        const discovery = await client.discoverTools(controller.signal);
        setNotice(
          `${row.label}: reachable. ${discovery.tools.length} tool${discovery.tools.length === 1 ? "" : "s"} discovered${discovery.errors.length ? `, ${discovery.errors.length} rejected as invalid` : ""}. Turn on the ones to use.`,
        );
        const merged = { ...row.toolEnabled };
        for (const tool of discovery.tools)
          if (!(tool.name in merged)) merged[tool.name] = false;
        await servers.save({ ...row, toolEnabled: merged });
        setRows(await servers.load());
      } finally {
        await client.dispose();
      }
    } catch (cause) {
      setNotice(`${row.label}: ${mcpErrorResult(cause).error.message}`);
    } finally {
      clearTimeout(timer);
      setBusyId("");
    }
  }
  async function removeRow(row: McpServerRow) {
    setNotice("");
    if (row.authRef !== undefined)
      await secrets.remove(row.authRef as SecretRef).catch(() => {});
    await servers.remove(row.id);
    setRows(await servers.load());
  }
  return (
    <View style={styles.card} testID="tool-settings-mcp">
      <Text style={styles.rowTitle}>MCP servers</Text>
      <Text style={styles.helper}>
        Add a labeled server address; keys stay in the device key storage and
        are only ever sent to that address. Discovered tools stay off until you
        turn each one on, and a model can only use tools if it supports them.
      </Text>
      <View style={styles.addRow}>
        <TextInput
          mode="outlined"
          label="Server name"
          accessibilityLabel="MCP server name"
          value={labelDraft}
          onChangeText={setLabelDraft}
        />
        <TextInput
          mode="outlined"
          label="Server URL (http or https)"
          accessibilityLabel="MCP server URL"
          value={urlDraft}
          onChangeText={setUrlDraft}
          autoCapitalize="none"
        />
        <TextInput
          mode="outlined"
          label="Bearer key (optional)"
          accessibilityLabel="MCP bearer key"
          value={keyDraft}
          onChangeText={setKeyDraft}
          secureTextEntry
          autoCapitalize="none"
        />
        <NativeButton
          mode="outlined"
          onPress={() => void addServer()}
          accessibilityLabel="Add MCP server"
          testID="tool-settings-mcp-add"
        >
          Add server
        </NativeButton>
      </View>
      {rows.map((row) => (
        <View
          key={row.id}
          style={styles.server}
          testID={`tool-settings-mcp-${row.id}`}
        >
          <Text style={styles.rowTitle}>{row.label}</Text>
          <Text style={styles.helper}>{row.url}</Text>
          <View style={styles.switchRow}>
            <Switch
              value={row.enabled}
              onValueChange={(value) =>
                void updateRow({ ...row, enabled: value })
              }
              accessibilityLabel={`Enable MCP server ${row.label}`}
              testID={`tool-settings-mcp-toggle-${row.id}`}
            />
            <Text style={styles.rowTitle}>Enabled for new messages</Text>
          </View>
          <View style={styles.actions}>
            <NativeButton
              mode="outlined"
              onPress={() => void checkRow(row)}
              disabled={busyId === row.id}
              accessibilityLabel={`Check MCP server ${row.label}`}
              testID={`tool-settings-mcp-check-${row.id}`}
            >
              {busyId === row.id ? "Checking…" : "Check server"}
            </NativeButton>
            <NativeButton
              mode="text"
              onPress={() => void removeRow(row)}
              accessibilityLabel={`Remove MCP server ${row.label}`}
              testID={`tool-settings-mcp-remove-${row.id}`}
            >
              Remove
            </NativeButton>
          </View>
          {Object.keys(row.toolEnabled).length ? (
            <View>
              {Object.keys(row.toolEnabled).map((name) => (
                <View key={name} style={styles.switchRow}>
                  <Switch
                    value={row.toolEnabled[name] === true}
                    onValueChange={(value) =>
                      void updateRow({
                        ...row,
                        toolEnabled: { ...row.toolEnabled, [name]: value },
                      })
                    }
                    accessibilityLabel={`Use ${name} from ${row.label}`}
                    testID={`tool-settings-mcp-tool-${row.id}-${name}`}
                  />
                  <Text style={styles.rowTitle}>{name}</Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.helper}>
              No discovered tools yet. Use “Check server” to list them.
            </Text>
          )}
        </View>
      ))}
      {notice !== "" ? (
        <Text style={styles.notice} testID="tool-settings-mcp-notice">
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
  actions: { flexDirection: "row", gap: 8 },
  rowTitle: { fontWeight: "600" },
  helper: { opacity: 0.7 },
  notice: { fontWeight: "500" },
});
const desktopStyles = phoneStyles;
