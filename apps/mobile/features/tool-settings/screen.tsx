import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Switch, Text, TextInput } from "react-native-paper";
import {
  NativeButton,
  NativeDropdown,
  NativeSurface,
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";
import { ErrorNotice } from "../diagnostics/error-notice";
import { describeError } from "../diagnostics/errors";
import { McpServersSection } from "./mcp-panel";
import type { SQLiteMcpServerStore } from "./mcp-servers";
import { LmStudioIntegrationsSection } from "./lmstudio-panel";
import type { SQLiteLmStudioIntegrationStore } from "./lmstudio-integrations";
import type { SecretStore } from "@locallab/security-secrets";
import {
  TOOL_SETTINGS_CATALOG,
  resolveToolPolicy,
} from "./settings";
import type {
  SQLiteToolSettingsStore,
  ToolConversationSettings,
  ToolGlobalSettings,
} from "./settings";

/**
 * App-wide and per-chat tool settings. Every save goes straight to the local
 * SQLite store; this panel performs no network calls. Labels are display-only:
 * the tool name stays the stable identity used by invocations and history.
 */
export function ToolSettingsPanel({
  store,
  conversationId,
  onClose,
  servers,
  secrets,
  lmStudio,
}: {
  store: SQLiteToolSettingsStore;
  conversationId: string;
  onClose?: () => void;
  servers?: SQLiteMcpServerStore;
  secrets?: SecretStore;
  lmStudio?: SQLiteLmStudioIntegrationStore;
}) {
  const { phone } = useWorkspaceLayout();
  const [global, setGlobal] = useState<ToolGlobalSettings | null>(null);
  const [conversation, setConversation] =
    useState<ToolConversationSettings>({});
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [nextGlobal, nextConversation] = await Promise.all([
          store.load(),
          store.loadConversation(conversationId),
        ]);
        if (!active) return;
        setGlobal(nextGlobal);
        setConversation(nextConversation);
      } catch (cause) {
        if (active)
          setError(
            describeError(cause, {
              operation: "Load tool settings",
              recovery:
                "Close this panel and open it again. Tool settings are stored on this device only.",
            }),
          );
      }
    })();
    return () => {
      active = false;
    };
  }, [store, conversationId]);
  function updateGlobal(next: ToolGlobalSettings) {
    if (!global) return;
    const previous = global;
    setGlobal(next);
    setError("");
    void (async () => {
      try {
        await store.save(next);
      } catch (cause) {
        setError(
          describeError(cause, {
            operation: "Save tool settings",
            recovery:
              "Nothing was saved. Shorten the labels or try again; settings stay on this device.",
          }),
        );
        setGlobal(previous);
      }
    })();
  }
  function updateConversation(next: ToolConversationSettings) {
    const previous = conversation;
    setConversation(next);
    setError("");
    void (async () => {
      try {
        await store.saveConversation(conversationId, next);
      } catch (cause) {
        setError(
          describeError(cause, {
            operation: "Save this chat's tool settings",
            recovery:
              "Nothing was saved for this chat. Try again; settings stay on this device.",
          }),
        );
        setConversation(previous);
      }
    })();
  }
  function commitLabel(name: string) {
    if (!global) return;
    const draft = labelDrafts[name];
    if (draft === undefined) return;
    setLabelDrafts((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
    const trimmed = draft.trim();
    if (trimmed === (global.labels[name] ?? TOOL_SETTINGS_CATALOG[name]?.label))
      return;
    const labels = { ...global.labels };
    // An empty label falls back to the catalog display name, so drop the key.
    if (trimmed === "") delete labels[name];
    else labels[name] = trimmed;
    updateGlobal({ ...global, labels });
  }
  const policy = global
    ? resolveToolPolicy({
        global,
        conversation,
        capabilities: { tools: "yes" },
      })
    : null;
  function renderControls(tone: "phone" | "desktop") {
    if (!global || !policy) return null;
    const styles = tone === "phone" ? phoneStyles : desktopStyles;
    const surface = (key: string, label: string, children: ReactNode) =>
      tone === "phone" ? (
        <View key={key} style={styles.card}>
          {children}
        </View>
      ) : (
        <NativeSurface
          key={key}
          accessibilityLabel={label}
          style={styles.card}
        >
          {children}
        </NativeSurface>
      );
    return (
      <>
        <View style={styles.card} testID="tool-settings-master">
          <View style={styles.switchRow}>
            <Switch
              value={global.globalEnabled}
              onValueChange={(value) =>
                updateGlobal({ ...global, globalEnabled: value })
              }
              accessibilityLabel="Use tools in this app"
              testID="tool-settings-master-switch"
            />
            <Text style={styles.rowTitle}>Use tools in this app</Text>
          </View>
          <Text style={styles.helper}>
            Turns every tool off for new messages when disabled.
          </Text>
        </View>
        {surface(
          "chat-override",
          "This chat's tools",
          <>
            <Text style={styles.rowTitle}>Tools in this chat</Text>
            <View testID="tool-settings-override">
              <NativeDropdown
                label="Chat override"
                value={
                  conversation.globalEnabled === undefined
                    ? "inherit"
                    : conversation.globalEnabled
                      ? "on"
                      : "off"
                }
                options={[
                  {
                    value: "inherit",
                    label: "Inherit from app settings",
                  },
                  { value: "on", label: "On for this chat" },
                  { value: "off", label: "Off for this chat" },
                ]}
                onChange={(value) =>
                  updateConversation({
                    ...(value === "inherit"
                      ? {}
                      : { globalEnabled: value === "on" }),
                    ...(conversation.tools
                      ? { tools: conversation.tools }
                      : {}),
                  })
                }
              />
            </View>
            <Text style={styles.helper}>
              Chat overrides apply to this conversation only; the app-wide
              switch stays untouched.
            </Text>
          </>,
        )}
        {surface(
          "round-policy",
          "Tool round policy",
          <>
            <Text style={styles.rowTitle}>Tool rounds per message</Text>
            <View testID="tool-settings-round-limit">
              <NativeDropdown
                label="Round limit"
                value={global.roundLimit === null ? "unlimited" : String(global.roundLimit)}
                options={[
                  { value: "3", label: "3 rounds" },
                  { value: "6", label: "6 rounds" },
                  { value: "12", label: "12 rounds" },
                  { value: "unlimited", label: "Unlimited" },
                ]}
                onChange={(value) =>
                  updateGlobal({
                    ...global,
                    roundLimit: value === "unlimited" ? null : Number(value),
                  })
                }
              />
            </View>
            <Text style={styles.helper}>
              Unlimited removes only the round cap; the deadline, token and
              size limits still apply.
            </Text>
          </>,
        )}
        {surface(
          "tool-rows",
          "Individual tools",
          <>
            {Object.keys(TOOL_SETTINGS_CATALOG).map((name) => {
              const entry = TOOL_SETTINGS_CATALOG[name];
              if (!entry) return null;
              const currentLabel =
                labelDrafts[name] ??
                global.labels[name] ??
                entry.label;
              return (
                <View key={name} style={styles.tool}>
                  <Text style={styles.rowTitle}>
                    {global.labels[name] ?? entry.label}
                  </Text>
                  <Text style={styles.helper}>{entry.description}</Text>
                  <TextInput
                    mode="outlined"
                    label="Display name"
                    accessibilityLabel={`Display name for ${entry.label}`}
                    testID={`tool-settings-label-${name}`}
                    value={currentLabel}
                    onChangeText={(value) =>
                      setLabelDrafts((current) => ({ ...current, [name]: value }))
                    }
                    onSubmitEditing={() => commitLabel(name)}
                    onBlur={() => commitLabel(name)}
                  />
                  <View style={styles.switchRow}>
                    <Switch
                      value={global.tools[name] ?? true}
                      onValueChange={(value) =>
                        updateGlobal({
                          ...global,
                          tools: { ...global.tools, [name]: value },
                        })
                      }
                      disabled={!global.globalEnabled}
                      accessibilityLabel={`Enable ${entry.label} in this app`}
                      testID={`tool-settings-tool-${name}`}
                    />
                    <Text style={styles.rowTitle}>Enabled in this app</Text>
                    {!global.globalEnabled ? (
                      <Text style={styles.helper}>off everywhere</Text>
                    ) : null}
                  </View>
                  <Text
                    style={styles.effective}
                    testID={`tool-settings-effective-${name}`}
                  >
                    Effective in this chat:{" "}
                    {policy.engaged && policy.tools[name] ? "on" : "off"}
                  </Text>
                </View>
              );
            })}
            <Text style={styles.helper}>
              Renaming changes only what you see; the tool's identity and past
              results stay linked.
            </Text>
          </>,
        )}
        {servers !== undefined && secrets !== undefined ? (
          <McpServersSection servers={servers} secrets={secrets} />
        ) : null}
        {lmStudio !== undefined ? (
          <LmStudioIntegrationsSection integrations={lmStudio} />
        ) : null}
        {onClose ? (
          <NativeButton
            accessibilityLabel="Back to chat from tool settings"
            onPress={onClose}
          >
            Back to chat
          </NativeButton>
        ) : null}
      </>
    );
  }
  if (phone) {
    return (
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={phoneStyles.content}
        testID="tool-settings-panel"
      >
        <Text style={phoneStyles.heading}>Tool settings</Text>
        {error ? <ErrorNotice message={error} /> : null}
        {global ? (
          renderControls("phone")
        ) : (
          <Text testID="tool-settings-loading">Loading tool settings…</Text>
        )}
      </ScrollView>
    );
  }
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={desktopStyles.content}
      testID="tool-settings-panel"
    >
      <Text style={desktopStyles.heading}>Tool settings</Text>
      {error ? <ErrorNotice message={error} /> : null}
      {global ? (
        renderControls("desktop")
      ) : (
        <Text testID="tool-settings-loading">Loading tool settings…</Text>
      )}
    </ScrollView>
  );
}

const phoneStyles = StyleSheet.create({
  content: { padding: 20, gap: 20, paddingBottom: 32 },
  heading: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  card: { padding: 20, gap: 16 },
  tool: { gap: 8 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowTitle: { fontSize: 16, fontWeight: "600" },
  helper: { fontSize: 14, lineHeight: 20 },
  effective: { fontSize: 14 },
});

const desktopStyles = StyleSheet.create({
  content: { padding: 16, gap: 14 },
  heading: { fontSize: 20, fontWeight: "700" },
  card: { padding: 14, gap: 10 },
  tool: { gap: 4 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowTitle: { fontWeight: "600" },
  helper: {},
  effective: {},
});
