import { useCallback, useEffect, useState } from "react";
import { Platform, ScrollView, StyleSheet, View } from "react-native";
import { SecretStoreError } from "@locallab/security-secrets";
import { Switch, Text } from "react-native-paper";
import type { SecretRef } from "@locallab/security-secrets";
import {
  NativeButton,
  NativeInput,
  NativeSurface,
} from "@locallab/ui-native-primitives";
import {
  getProviderHelp,
  type ConnectionFeatureDependencies,
  type SavedConnection,
  discoverConnections,
  normalizeConnectionHost,
  modelConnectionKind,
  testConnection,
} from "./index";

/** Settings screen; caller supplies the migrated database, secure store and platform permission adapter. */
export function ConnectionsScreen({
  repository,
  secrets,
  permission,
  probe,
  connectivity,
  discoveryAvailable = true,
}: ConnectionFeatureDependencies) {
  const [items, setItems] = useState<SavedConnection[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("openai-compatible");
  const [host, setHost] = useState("");
  const [headerName, setHeaderName] = useState("Authorization");
  const [headerValue, setHeaderValue] = useState("");
  const [headersEnabled, setHeadersEnabled] = useState(false);
  const [discoveryHosts, setDiscoveryHosts] = useState("");
  const [results, setResults] = useState<
    Array<{ status: string; host: string; provider?: string }>
  >([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(
    async () => setItems(await repository.list()),
    [repository],
  );
  useEffect(() => {
    void reload().catch((error: unknown) => setMessage(errorText(error)));
  }, [reload]);

  const selected = items.find((item) => item.id === selectedId) ?? null;
  const beginNew = () => {
    setSelectedId(null);
    setName("");
    setKind("openai-compatible");
    setHost("");
    setHeaderName("Authorization");
    setHeaderValue("");
    setHeadersEnabled(false);
  };
  const edit = (item: SavedConnection) => {
    setSelectedId(item.id);
    setName(item.name);
    setKind(item.kind);
    setHost(item.host);
    setHeaderName("Authorization");
    setHeaderValue("");
    setHeadersEnabled(item.customHeadersEnabled);
  };

  const save = async () => {
    setBusy(true);
    setMessage("");
    let addedRef: SecretRef | null = null;
    const replacedRefs: SecretRef[] = [];
    let saved = false;
    try {
      const cleanHost = normalizeConnectionHost(host);
      let refs = selected?.headerRefs ?? [];
      if (
        selected &&
        selected.host !== cleanHost &&
        (refs.length || selected.credentialRef)
      )
        throw new Error(
          "Remove saved credentials before changing the server host. Credentials are bound to their original host.",
        );
      if (headerValue.trim()) {
        const retained: string[] = [];
        for (const ref of refs) {
          try {
            const existing = await secrets.resolveHeaders(cleanHost, [
              ref as SecretRef,
            ]);
            if (Object.keys(existing).includes(headerName.trim().toLowerCase()))
              replacedRefs.push(ref as SecretRef);
            else retained.push(ref);
          } catch (cause) {
            if (
              Platform.OS === "web" &&
              cause instanceof SecretStoreError &&
              (cause.code === "missing" || cause.code === "host-mismatch")
            )
              replacedRefs.push(ref as SecretRef);
            else throw cause;
          }
        }
        refs = retained;
        addedRef = (
          await secrets.put(cleanHost, headerName.trim(), headerValue.trim())
        ).ref;
      }
      const nextRefs = addedRef ? [...refs, addedRef] : refs;
      const connection = await repository.save({
        ...(selected ? { id: selected.id } : {}),
        name,
        kind,
        host: cleanHost,
        headerRefs: nextRefs,
        customHeadersEnabled: headersEnabled,
      });
      saved = true;
      setSelectedId(connection.id);
      setHost(connection.host);
      setHeaderValue("");
      const cleanup = await Promise.allSettled(
        replacedRefs.map((ref) => secrets.remove(ref)),
      );
      await reload();
      setMessage(
        cleanup.some((result) => result.status === "rejected")
          ? "Connection saved. Some replaced secure values could not be removed."
          : selected &&
              modelConnectionKind(selected.kind) !== modelConnectionKind(kind)
            ? "Connection saved on this device. Choose a model again in Models for the changed provider type."
            : selected &&
                selected.host !== connection.host &&
                connection.host.startsWith("http://")
              ? "Connection saved. Use the selected model in Models to authorize the new local HTTP origin for chat."
              : "Connection saved on this device.",
      );
    } catch (error) {
      if (addedRef && !saved)
        await secrets.remove(addedRef).catch(() => undefined);
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: SavedConnection) => {
    setBusy(true);
    try {
      await repository.delete(item.id);
      if (selectedId === item.id) beginNew();
      const refs = [
        ...item.headerRefs,
        ...(item.credentialRef ? [item.credentialRef] : []),
      ];
      const cleanup = await Promise.allSettled(
        refs.map((ref) => secrets.remove(ref as SecretRef)),
      );
      await reload();
      setMessage(
        cleanup.some((result) => result.status === "rejected")
          ? `${item.name} deleted. Some secure values could not be removed from system storage.`
          : `${item.name} deleted.`,
      );
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const clearHeaders = async (item: SavedConnection) => {
    setBusy(true);
    try {
      await repository.save({
        id: item.id,
        name: item.name,
        kind: item.kind,
        host: item.host,
        credentialRef: item.credentialRef,
        headerRefs: [],
        customHeadersEnabled: false,
      });
      const cleanup = await Promise.allSettled(
        item.headerRefs.map((ref) => secrets.remove(ref as SecretRef)),
      );
      await reload();
      setHeadersEnabled(false);
      setMessage(
        cleanup.some((result) => result.status === "rejected")
          ? "Header references removed. Some secure values could not be cleared from system storage."
          : "Custom headers removed from this connection and secure storage.",
      );
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const move = async (item: SavedConnection, delta: -1 | 1) => {
    const index = items.findIndex((candidate) => candidate.id === item.id);
    const other = items[index + delta];
    if (!other) return;
    const ids = items.map((candidate) => candidate.id);
    [ids[index], ids[index + delta]] = [ids[index + delta]!, ids[index]!];
    setBusy(true);
    try {
      await repository.reorder(ids);
      await reload();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const discover = async () => {
    setBusy(true);
    setMessage("");
    setResults([]);
    try {
      const hosts = discoveryHosts
        .split(/[\n, ]+/)
        .map((value) => value.trim())
        .filter(Boolean);
      const found = await discoverConnections(hosts, permission, probe);
      setResults(found);
      setMessage(
        found.some((result) => result.status === "auth-required")
          ? "Some servers require authentication. They are discoverable; add them manually and configure credentials after saving."
          : `${found.length} host(s) checked. No credentials were sent during discovery.`,
      );
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const check = async (item: SavedConnection) => {
    setBusy(true);
    setMessage("Testing connection…");
    try {
      const result = await testConnection({
        connection: item,
        secrets,
        request: connectivity,
      });
      setMessage(
        result === "connected"
          ? "Connection succeeded."
          : result === "auth-required"
            ? "Server found; authentication is required. Check secure credentials and the custom-header switch."
            : "Connection failed. Check the host, server status and network permissions.",
      );
    } catch {
      setMessage(
        "Could not test this connection. Check the host and secure credential setup.",
      );
    } finally {
      setBusy(false);
    }
  };

  const help = getProviderHelp(kind);
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.page}
    >
      <Text accessibilityRole="header" variant="headlineMedium">
        Connections
      </Text>
      <Text>
        {Platform.OS === "web"
          ? "Connections persist in this browser. Header values stay only in this tab; re-enter them after reloading. The iPhone app stores credentials in system secure storage."
          : "Saved connections stay on this device. Credentials are stored separately in the operating system secure store."}
      </Text>
      <NativeSurface
        accessibilityLabel="Saved provider connections"
        style={styles.card}
      >
        <Text accessibilityRole="header" variant="titleLarge">
          Saved providers
        </Text>
        {items.length === 0 ? (
          <Text>No connections saved yet.</Text>
        ) : (
          items.map((item, index) => (
            <View key={item.id} style={styles.row}>
              <View style={styles.grow}>
                <Text variant="titleMedium">{item.name}</Text>
                <Text>
                  {item.kind} · {item.host}
                </Text>
              </View>
              <NativeButton
                compact
                accessibilityLabel={`Edit ${item.name}`}
                disabled={busy}
                onPress={() => edit(item)}
              >
                Edit
              </NativeButton>
              <NativeButton
                compact
                accessibilityLabel={`Move ${item.name} up`}
                disabled={busy || index === 0}
                onPress={() => void move(item, -1)}
              >
                ↑
              </NativeButton>
              <NativeButton
                compact
                accessibilityLabel={`Move ${item.name} down`}
                disabled={busy || index === items.length - 1}
                onPress={() => void move(item, 1)}
              >
                ↓
              </NativeButton>
              <NativeButton
                compact
                accessibilityLabel={`Delete ${item.name}`}
                disabled={busy}
                onPress={() => void remove(item)}
              >
                Delete
              </NativeButton>
            </View>
          ))
        )}
        <NativeButton
          accessibilityLabel="Add a new connection"
          disabled={busy}
          onPress={beginNew}
        >
          Add connection
        </NativeButton>
      </NativeSurface>
      <NativeSurface
        accessibilityLabel="Connection editor and provider setup help"
        style={styles.card}
      >
        <Text accessibilityRole="header" variant="titleLarge">
          {selected ? "Edit connection" : "New connection"}
        </Text>
        <NativeInput
          accessibilityLabel="Connection name"
          label="Name"
          value={name}
          onChangeText={setName}
          editable={!busy}
        />
        <NativeInput
          accessibilityLabel="Provider type"
          label="Provider (e.g. lm-studio, ollama, openai)"
          value={kind}
          onChangeText={setKind}
          editable={!busy}
          autoCapitalize="none"
        />
        <NativeInput
          accessibilityLabel="Server host"
          label="Server URL or LAN host"
          value={host}
          onChangeText={setHost}
          editable={!busy}
          autoCapitalize="none"
          keyboardType="url"
          placeholder="http://192.168.1.20:1234"
        />
        <NativeInput
          accessibilityLabel="Custom header name"
          label="Custom header name"
          value={headerName}
          onChangeText={setHeaderName}
          editable={!busy}
          autoCapitalize="none"
        />
        <NativeInput
          accessibilityLabel="Custom header value"
          label="Custom header value (stored securely)"
          value={headerValue}
          onChangeText={setHeaderValue}
          editable={!busy}
          secureTextEntry
        />
        <View style={styles.row}>
          <Text style={styles.grow}>Enable custom headers when connecting</Text>
          <Switch
            accessibilityLabel="Enable custom headers"
            value={headersEnabled}
            onValueChange={setHeadersEnabled}
            disabled={busy}
          />
        </View>
        <Text>
          {Platform.OS === "web"
            ? "Header values stay in memory for this tab. Only opaque references are saved with this connection. Re-enter values after reloading. Discovery never reads or sends them."
            : "Header values are written to secure storage and only their opaque references are saved with this connection. Discovery never reads or sends them."}
        </Text>
        {selected && selected.headerRefs.length > 0 ? (
          <NativeButton
            accessibilityLabel="Remove custom headers from selected connection"
            disabled={busy}
            onPress={() => void clearHeaders(selected)}
          >
            Remove saved custom headers
          </NativeButton>
        ) : null}
        <View style={styles.row}>
          <NativeButton
            accessibilityLabel="Save connection"
            disabled={busy || !name.trim() || !host.trim()}
            onPress={() => void save()}
          >
            {busy ? "Working…" : "Save connection"}
          </NativeButton>
          {selected ? (
            <NativeButton
              accessibilityLabel="Test selected connection"
              disabled={busy}
              onPress={() => void check(selected)}
            >
              Test
            </NativeButton>
          ) : null}
        </View>
        <Text accessibilityRole="header" variant="titleMedium">
          {help.title}
        </Text>
        {help.steps.map((step) => (
          <Text key={step}>• {step}</Text>
        ))}
      </NativeSurface>
      <NativeSurface
        accessibilityLabel="Local network server discovery"
        style={styles.card}
      >
        <Text accessibilityRole="header" variant="titleLarge">
          Find a server on your LAN
        </Text>
        <Text>
          Enter specific host names or IP addresses separated by commas or new
          lines. The scan asks for local network permission, checks at most 16
          hosts with a short timeout, and sends no auth headers. Protected
          servers are shown as requiring authentication.
        </Text>
        {!discoveryAvailable ? (
          <Text>
            Native LAN discovery permission is unavailable in this browser. Add
            a known server URL above and use Test. On an iPhone, use your
            computer's LAN address instead of localhost.
          </Text>
        ) : null}
        <NativeInput
          accessibilityLabel="LAN hosts to check"
          label="LAN hosts to check"
          value={discoveryHosts}
          onChangeText={setDiscoveryHosts}
          autoCapitalize="none"
          placeholder="192.168.1.20:1234"
          multiline
        />
        <NativeButton
          accessibilityLabel="Request permission and scan entered LAN hosts"
          disabled={busy || !discoveryAvailable || !discoveryHosts.trim()}
          onPress={() => void discover()}
        >
          Request permission and scan
        </NativeButton>
        {results.map((result) => (
          <View key={`${result.host}:${result.status}`} style={styles.row}>
            <Text style={styles.grow}>
              {result.host} —{" "}
              {result.status === "found"
                ? `${result.provider} server`
                : result.status === "auth-required"
                  ? "server found; authentication required"
                  : "no compatible server found"}
            </Text>
            {result.status !== "not-found" ? (
              <NativeButton
                compact
                accessibilityLabel={`Add server at ${result.host}`}
                disabled={busy}
                onPress={() => {
                  beginNew();
                  setHost(`http://${result.host}`);
                  setKind(result.provider ?? "openai-compatible");
                  setName(
                    result.provider === "lm-studio"
                      ? "LM Studio"
                      : "Discovered server",
                  );
                }}
              >
                Add
              </NativeButton>
            ) : null}
          </View>
        ))}
      </NativeSurface>
      {message ? <Text accessibilityRole="alert">{message}</Text> : null}
    </ScrollView>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Connection settings could not be saved.";
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 16 },
  card: { padding: 16, gap: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  grow: { flex: 1 },
});
