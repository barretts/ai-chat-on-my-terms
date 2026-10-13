import { useEffect, useRef, useState } from "react";
import { Keyboard, Linking, Platform, ScrollView, View } from "react-native";
import { Text } from "react-native-paper";
import {
  NativeButton,
  NativeDropdown,
  NativeInput,
  NativeSurface,
} from "@locallab/ui-native-primitives";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import { braveSearchFetch } from "../../platform/brave-search-fetch";
import { webAccessFetch } from "../../platform/web-access";
import { providerFetch } from "../../platform/provider-fetch";
import {
  createConfiguredWebResearchClient,
  resolveEffectiveWebResearchMode,
  saveWebResearchConfiguration,
  WebResearchCleanupError,
  type WebResearchSettingsStore,
  type WebResearchSettings,
  type WebResearchMode,
} from "./web-research-settings";
import { BRAVE_SEARCH_ORIGIN } from "./brave-web-search";
import { describeError } from "../../features/diagnostics/errors";
import { ErrorNotice } from "../../features/diagnostics/error-notice";

export function WebResearchSettingsPanel({
  settings,
  secrets,
  conversationId,
  onChanged,
}: {
  settings: WebResearchSettingsStore;
  secrets: SecretStore;
  conversationId: string;
  onChanged?(): void;
}) {
  const [provider, setProvider] =
    useState<WebResearchSettings["provider"]>("public");
  const [saved, setSaved] = useState<WebResearchSettings>({
    provider: "public",
    credentialRef: null,
    endpoint: null,
  });
  const [endpoint, setEndpoint] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [missingKey, setMissingKey] = useState(false);
  const [mode, setMode] = useState<WebResearchMode>("auto");
  const [override, setOverride] = useState<WebResearchMode | null>(null);
  const mounted = useRef(true);
  const operation = useRef(false);
  const active = useRef<AbortController | null>(null);
  const scroll = useRef<ScrollView>(null);
  const pendingCleanup = useRef(new Set<SecretRef>());
  useEffect(() => {
    if (!error) return;
    Keyboard.dismiss();
    requestAnimationFrame(() =>
      scroll.current?.scrollTo({ y: 0, animated: true }),
    );
  }, [error]);
  useEffect(() => {
    mounted.current = true;
    void settings
      .read()
      .then(async (value) => {
        if (!mounted.current) return;
        setSaved(value);
        setProvider(value.provider);
        setMode(value.mode ?? "auto");
        setEndpoint(value.endpoint ?? "");
        if (value.credentialRef) {
          const keyOrigin =
            value.provider === "searxng" && value.endpoint !== null
              ? new URL(value.endpoint).origin
              : BRAVE_SEARCH_ORIGIN;
          try {
            await secrets.resolveHeaders(keyOrigin, [value.credentialRef]);
          } catch (cause) {
            if (mounted.current) {
              setMissingKey(true);
              setError(
                describeError(cause, {
                  operation:
                    value.provider === "searxng"
                      ? "Read saved SearXNG key"
                      : "Read saved Brave Search key",
                  recovery:
                    "The saved key is unavailable. Enter and save it again, or choose another search service.",
                }),
              );
            }
          }
        }
      })
      .catch((cause) => {
        if (mounted.current)
          setError(
            describeError(cause, {
              operation: "Load web search settings",
              recovery: "Reopen this page and try again.",
            }),
          );
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, [settings, secrets, conversationId]);
  useEffect(() => {
    void settings
      .readConversationOverride(conversationId)
      .then((value) => {
        if (mounted.current) setOverride(value);
      })
      .catch((cause) => {
        if (mounted.current)
          setError(
            describeError(cause, {
              operation: "Load web search override for this chat",
              recovery: "Reopen this page and try again.",
            }),
          );
      });
  }, [settings, conversationId]);
  const applyOverride = async (value: "inherit" | WebResearchMode) => {
    setError("");
    setStatus("");
    try {
      if (value === "inherit") {
        await settings.removeConversationOverride(conversationId);
        if (mounted.current) {
          setOverride(null);
          setStatus("This chat follows the app-wide mode.");
        }
      } else {
        await settings.saveConversationOverride(conversationId, value);
        if (mounted.current) {
          setOverride(value);
          setStatus(`This chat now uses ${value} web research.`);
        }
      }
      onChanged?.();
    } catch (cause) {
      if (mounted.current)
        setError(
          describeError(cause, {
            operation: "Save web search policy for this chat",
            recovery: "Try again. Your other settings are unchanged.",
          }),
        );
    }
  };
  const persist = async (clear = false) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await saveWebResearchConfiguration({
        settings,
        secrets,
        provider: clear ? "public" : provider,
        mode,
        ...(provider === "searxng" && !clear ? { endpoint } : {}),
        ...(clear
          ? { clearKey: true }
          : (provider === "brave" || provider === "searxng") && key.trim()
            ? { newKey: key }
            : {}),
      });
      if (!mounted.current) return;
      setSaved(result.value);
      setProvider(result.value.provider);
      setMode(result.value.mode ?? "auto");
      setKey("");
      setEndpoint(result.value.endpoint ?? "");
      setMissingKey(
        clear ||
        (provider === "brave" && key.trim()) ||
        (provider === "searxng" && key.trim())
          ? false
          : missingKey,
      );
      setStatus(
        result.replacedKeyRemoved
          ? clear
            ? "Saved key removed. Public search is selected."
            : "Web search settings saved."
          : "Web search settings saved.",
      );
      if (!result.replacedKeyRemoved) {
        if (result.pendingCleanupRef)
          pendingCleanup.current.add(result.pendingCleanupRef);
        setError(
          describeError(result.cleanupError, {
            operation: "Remove previous search key",
            recovery:
              "The settings were saved, but the previous key could not be removed. Use Retry secure cleanup to remove it.",
          }),
        );
      }
      onChanged?.();
    } catch (cause) {
      if (cause instanceof WebResearchCleanupError)
        pendingCleanup.current.add(cause.pendingCleanupRef);
      if (mounted.current)
        setError(
          describeError(cause, {
            operation: clear
              ? "Remove saved search key"
              : "Save web search settings",
            recovery: "Check the selected service and key, then save again.",
          }),
        );
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const retryCleanup = async () => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      for (const ref of pendingCleanup.current) {
        try {
          await secrets.remove(ref);
          pendingCleanup.current.delete(ref);
        } catch (cause) {
          const message = describeError(cause, {
            operation: "Retry secure search-key cleanup",
            recovery:
              "Try secure cleanup again and inspect the trace log if secure storage remains unavailable.",
          });
          if (mounted.current)
            setError((current) =>
              current ? `${current}\n\n${message}` : message,
            );
        }
      }
      if (!pendingCleanup.current.size && mounted.current)
        setStatus("Pending secure keys removed.");
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const test = async () => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    const controller = new AbortController();
    active.current = controller;
    try {
      const client = await createConfiguredWebResearchClient({
        settings,
        secrets,
        publicFetch: webAccessFetch,
        searchApiFetch: braveSearchFetch,
        providerFetch,
      });
      const results = await client.search(
        "Expo documentation",
        controller.signal,
      );
      if (mounted.current)
        setStatus(
          results.length
            ? `Search connected. ${results.length} result${results.length === 1 ? "" : "s"} returned for “Expo documentation”.`
            : "Search connected, but no results were returned. Try a different question.",
        );
    } catch (cause) {
      if (mounted.current) {
        if (controller.signal.aborted) setStatus("Search test canceled.");
        else
          setError(
            describeError(cause, {
              operation: "Test saved web search service",
              recovery:
                "Check the service, API key and request allowance. Try again or choose Public search. If Public search is blocked, choose Brave Search.",
            }),
          );
      }
    } finally {
      active.current = null;
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const unsaved =
    key.trim().length > 0 ||
    provider !== saved.provider ||
    (provider === "searxng" && endpoint.trim() !== (saved.endpoint ?? "")) ||
    mode !== (saved.mode ?? "auto");
  return (
    <ScrollView
      ref={scroll}
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 12 }}
      keyboardShouldPersistTaps="handled"
    >
      {error ? <ErrorNotice message={error} /> : null}
      {pendingCleanup.current.size ? (
        <NativeButton
          accessibilityLabel="Retry secure cleanup"
          disabled={busy}
          onPress={() => void retryCleanup()}
        >
          Retry secure cleanup
        </NativeButton>
      ) : null}
      <NativeSurface
        style={{ padding: 16, gap: 12 }}
        accessibilityLabel="Web search settings"
      >
        <Text variant="titleMedium" accessibilityRole="header">
          Web search service
        </Text>
        <Text variant="bodyMedium">
          Choose where chat looks for fresh information.
        </Text>
        <NativeDropdown
          label="Search service"
          value={provider}
          onChange={(value) => {
            setProvider(value as WebResearchSettings["provider"]);
            if (value === "public") setKey("");
            setStatus("");
            setError("");
          }}
          options={[
            { value: "public", label: "Public search · DuckDuckGo" },
            { value: "brave", label: "Brave Search API" },
            { value: "searxng", label: "SearXNG server" },
          ]}
          disabled={loading || busy}
        />
        <Text variant="titleMedium" accessibilityRole="header">
          When to browse
        </Text>
        <Text variant="bodyMedium">
          Auto browses when you ask or when a tool-capable model needs fresh
          information. Manual browses only when you ask. Off never browses.
        </Text>
        <NativeDropdown
          label="App-wide mode"
          value={mode}
          onChange={(value) => {
            setMode(value as WebResearchMode);
            setStatus("");
            setError("");
          }}
          options={[
            { value: "auto", label: "Auto · with capable models" },
            { value: "manual", label: "Manual · only when you ask" },
            { value: "off", label: "Off · never browse" },
          ]}
          disabled={loading || busy}
        />
        {provider === "public" ? (
          <Text variant="bodyMedium">
            Public search may be blocked by browser verification or rate limits.
            No key needed. Choose Brave for a supported API.
          </Text>
        ) : provider === "searxng" ? (
          <>
            <Text variant="bodyMedium">
              Queries and any access key go only to this SearXNG server. The
              server must allow the JSON search API: enable format=json in its
              settings.
            </Text>
            <NativeInput
              label="SearXNG server address"
              accessibilityLabel="SearXNG server address"
              value={endpoint}
              onChangeText={setEndpoint}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!loading && !busy}
            />
            <NativeInput
              label={
                saved.provider === "searxng" && saved.credentialRef
                  ? "Replace access key (optional)"
                  : "Access key (optional)"
              }
              accessibilityLabel="SearXNG access key"
              value={key}
              onChangeText={setKey}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!loading && !busy}
            />
            <Text variant="bodySmall">
              {Platform.OS === "web"
                ? "A key is kept in this tab only. Re-enter after reload. On iPhone, the key uses system secure storage."
                : "A key is saved in your phone's system secure storage."}
            </Text>
            {!missingKey &&
            saved.provider === "searxng" &&
            saved.credentialRef ? (
              <Text variant="bodySmall">
                Key saved. Leave blank to keep it.
              </Text>
            ) : null}
          </>
        ) : (
          <>
            <Text variant="bodyMedium">
              Searches and tests use your Brave Search plan. Your query and key
              go only to Brave.
            </Text>
            <NativeButton
              accessibilityLabel="Open Brave Search API dashboard"
              onPress={() =>
                void Linking.openURL(
                  "https://api-dashboard.search.brave.com/",
                ).catch((cause) =>
                  setError(
                    describeError(cause, {
                      operation: "Open Brave Search dashboard",
                      recovery:
                        "Open https://api-dashboard.search.brave.com/ in your browser.",
                    }),
                  ),
                )
              }
            >
              Get a Brave Search key
            </NativeButton>
            <NativeInput
              label={
                saved.credentialRef
                  ? "Replace Brave Search key"
                  : "Brave Search API key"
              }
              accessibilityLabel="Brave Search API key"
              value={key}
              onChangeText={setKey}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!loading && !busy}
            />
            <Text variant="bodySmall">
              {Platform.OS === "web"
                ? "Kept in this tab only. Re-enter after reload. On iPhone, the key uses system secure storage."
                : "Saved in your phone's system secure storage."}
            </Text>
            {!missingKey && saved.credentialRef ? (
              <Text variant="bodySmall">
                Key saved. Leave blank to keep it.
              </Text>
            ) : null}
          </>
        )}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <NativeButton
            accessibilityLabel="Save web search settings"
            mode="contained"
            disabled={
              loading ||
              busy ||
              (provider === "brave" &&
                !key.trim() &&
                (!saved.credentialRef || missingKey)) ||
              (provider === "searxng" && !endpoint.trim())
            }
            onPress={() => void persist()}
          >
            Save
          </NativeButton>
          <NativeButton
            accessibilityLabel="Test saved web search service"
            disabled={
              loading ||
              busy ||
              unsaved ||
              (saved.provider === "brave" && missingKey)
            }
            onPress={() => void test()}
          >
            Test search
          </NativeButton>
          {active.current ? (
            <NativeButton
              accessibilityLabel="Cancel web search test"
              onPress={() => active.current?.abort()}
            >
              Cancel
            </NativeButton>
          ) : null}
          {saved.credentialRef ? (
            <NativeButton
              accessibilityLabel={
                saved.provider === "searxng"
                  ? "Remove saved SearXNG key"
                  : "Remove saved Brave Search key"
              }
              disabled={loading || busy}
              onPress={() => void persist(true)}
            >
              Remove key
            </NativeButton>
          ) : null}
        </View>
        {unsaved ? (
          <Text variant="bodySmall">
            Save your changes before testing. Test search uses the public
            question “Expo documentation”.
          </Text>
        ) : null}
        {busy ? (
          <Text accessibilityLiveRegion="polite">
            {active.current
              ? "Testing the saved search service…"
              : "Saving settings…"}
          </Text>
        ) : null}
        {status ? <Text accessibilityLiveRegion="polite">{status}</Text> : null}
      </NativeSurface>
      <NativeSurface
        style={{ margin: 12, padding: 16, gap: 12 }}
        accessibilityLabel="Web research for this chat"
      >
        <Text variant="titleMedium" accessibilityRole="header">
          This chat
        </Text>
        <Text variant="bodyMedium">
          This chat currently uses{" "}
          {resolveEffectiveWebResearchMode(saved.mode ?? "auto", override)}{" "}
          {override ? "(set for this chat)" : "(the app-wide mode)"}.
        </Text>
        <NativeDropdown
          label="Mode for this chat"
          value={override ?? "inherit"}
          onChange={(value) =>
            void applyOverride(value as "inherit" | WebResearchMode)
          }
          options={[
            { value: "inherit", label: "Use the app-wide mode" },
            { value: "auto", label: "Auto · with capable models" },
            { value: "manual", label: "Manual · only when you ask" },
            { value: "off", label: "Off · never browse" },
          ]}
          disabled={loading}
        />
        <Text variant="bodySmall">
          Overrides apply to this chat only and are kept until you remove them.
        </Text>
      </NativeSurface>
    </ScrollView>
  );
}
