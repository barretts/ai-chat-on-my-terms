import { useEffect, useRef, useState } from "react";
import { Linking, ScrollView, Switch, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import type { SecretStore } from "@locallab/security-secrets";
import {
  CHAT_PROVIDER_KINDS,
  type ChatProviderKind,
  type ChatProviderRegistration,
  type SQLiteChatProviderRegistry,
  createRegisteredChatProvider,
} from "./providers";
import { createId } from "../../platform/crypto";
import { providerFetch } from "../../platform/provider-fetch";
import {
  NativeButton,
  NativeDropdown,
  NativeInput,
  NativeSurface,
} from "@locallab/ui-native-primitives";
import {
  CLOUD_COMPATIBLE_PRESETS,
  createCloudCompatibleProvider,
} from "@locallab/provider-cloud-compatible";
import {
  putProviderCredential,
  verifyOpenRouterCredential,
} from "./provider-setup-helpers";

const nativeKinds = ["local-gguf", "mlx-ios", "mac-gguf", "mac-mlx"];
const kindLabel = (kind: string): string =>
  (
    ({
      compatible: "Local server · llama.cpp",
      ollama: "Ollama",
      lmstudio: "LM Studio",
      openrouter: "OpenRouter",
      openai: "OpenAI",
      anthropic: "Anthropic",
      gemini: "Google Gemini",
      "cloud-compatible": "Custom cloud API",
    }) as Record<string, string>
  )[kind] ?? kind;
const defaults: Record<string, string> = {
  openrouter: CLOUD_COMPATIBLE_PRESETS.openrouter,
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  mistral: "https://api.mistral.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
};

export function ProviderSetupPanel(props: {
  registry: SQLiteChatProviderRegistry;
  secrets: SecretStore;
  conversationId: string;
  onSelected(value: ChatProviderRegistration): void | Promise<void>;
  onClose(): void;
}) {
  const theme = useTheme();
  const [registrations, setRegistrations] = useState<
    ChatProviderRegistration[]
  >([]);
  const [loadingSaved, setLoadingSaved] = useState(true);
  const [kind, setKind] = useState<ChatProviderKind>("compatible");
  const [label, setLabel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [cleartext, setCleartext] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [availableModels, setAvailableModels] = useState<readonly string[]>([]);
  const [editing, setEditing] = useState<ChatProviderRegistration | null>(null);
  const [pendingRemove, setPendingRemove] =
    useState<ChatProviderRegistration | null>(null);
  const [manual, setManual] = useState(false);
  const [savedQuery, setSavedQuery] = useState("");
  const operation = useRef(false);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const reload = async () => {
    const list = await props.registry.list();
    if (mounted.current) setRegistrations(list);
  };
  useEffect(() => {
    mounted.current = true;
    void reload()
      .catch(() => setError("Saved providers could not be read."))
      .finally(() => setLoadingSaved(false));
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, [props.registry]);
  useEffect(() => {
    setAvailableModels([]);
    setError("");
    setStatus("");
  }, [kind, endpoint]);
  const reset = () => {
    setEditing(null);
    setLabel("");
    setModel("");
    setKey("");
    setCleartext(false);
    setAvailableModels([]);
    setManual(false);
  };
  const chooseKind = (value: string) => {
    reset();
    setKind(value as ChatProviderKind);
    setEndpoint(defaults[value] ?? "");
    if (value === "openrouter") setLabel("OpenRouter");
  };
  const select = async (value: ChatProviderRegistration) => {
    await props.registry.select(props.conversationId, value.id);
    await props.onSelected(value);
    props.onClose();
  };
  const checkedEndpoint = () => {
    let url: URL;
    try {
      url = new URL(endpoint.trim());
    } catch {
      throw new Error(
        "Enter a complete endpoint, such as http://192.168.1.213:35961/v1.",
      );
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error(
        "Use an HTTP or HTTPS endpoint without credentials in the URL.",
      );
    if (
      ["jan", "omlx", "unsloth", "compatible"].includes(kind) &&
      !["/", "/v1", "/v1/"].includes(url.pathname)
    )
      throw new Error("Use the compatible server origin or its /v1 API base.");
    if (url.protocol === "http:" && !cleartext)
      throw new Error("Allow this local HTTP origin before connecting.");
    return url;
  };
  const savedCredential = (url: URL) =>
    editing?.kind === kind &&
    editing.endpoint &&
    new URL(editing.endpoint).origin === url.origin
      ? editing.credentialRef
      : undefined;
  const connection = (
    url: URL,
    ref?: ChatProviderRegistration["credentialRef"],
  ): ChatProviderRegistration => ({
    id: editing?.id ?? createId(),
    label: label.trim() || kindLabel(kind),
    kind,
    endpoint: url.toString(),
    modelId: model.trim() || "model-discovery",
    ...(ref ? { credentialRef: ref } : {}),
    ...(editing?.headerRefs &&
    editing.kind === kind &&
    editing.endpoint &&
    new URL(editing.endpoint).origin === url.origin
      ? { headerRefs: editing.headerRefs }
      : {}),
    cleartextAuthorized: cleartext,
    favorite: editing?.favorite ?? false,
    allowCrossProviderRouting: editing?.allowCrossProviderRouting ?? false,
  });
  const work = async (action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Connection could not be updated.",
        );
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const queryModels = (test = false) =>
    work(async () => {
      setStatus("");
      const url = checkedEndpoint();
      const credential = key.trim()
        ? await putProviderCredential(props.secrets, kind, url.origin, key)
        : undefined;
      const ref = credential?.ref ?? savedCredential(url);
      const controller = new AbortController();
      request.current = controller;
      const timeout = setTimeout(
        () =>
          controller.abort(
            new Error("The endpoint took too long. Check the server address."),
          ),
        20000,
      );
      let port: ReturnType<typeof createRegisteredChatProvider> | undefined;
      try {
        if (kind === "openrouter" && test) {
          if (!ref) throw new Error("Enter your OpenRouter API key.");
          await verifyOpenRouterCredential(
            props.secrets,
            ref,
            providerFetch,
            controller.signal,
          );
        }
        const publicRouter = kind === "openrouter" && !test;
        port = publicRouter
          ? createCloudCompatibleProvider({
              fetch: providerFetch,
              secrets: props.secrets,
              resolveConnection: async () => ({ provider: "openrouter" }),
            })
          : createRegisteredChatProvider(connection(url, ref), {
              fetch: providerFetch,
              secrets: props.secrets,
            });
        const result = await port.listModels(
          publicRouter ? { provider: "openrouter" } : undefined,
          controller.signal,
        );
        if (!result.ok) throw new Error(result.error.message);
        if (!mounted.current) return;
        const list = [...new Set(result.value)].sort();
        setAvailableModels(list);
        if (!model && list.length === 1) setModel(list[0]!);
        if (test && (!model || !list.includes(model)))
          throw new Error(
            model
              ? `This endpoint does not list ${model}. Choose an available model.`
              : "Choose a model from the dropdown, then test again.",
          );
        setStatus(
          test
            ? `Connected: ${model} is available.`
            : `Found ${list.length} models on your endpoint. Choose one from the dropdown.`,
        );
      } finally {
        clearTimeout(timeout);
        if (request.current === controller) request.current = null;
        await port?.dispose?.();
        if (credential)
          await props.secrets.remove(credential.ref).catch(() => {});
      }
    });
  const cleanupCredential = async (
    ref: ChatProviderRegistration["credentialRef"],
  ) => {
    if (!ref) return;
    const saved = await props.registry.list();
    if (
      !saved.some(
        (item) => item.credentialRef === ref || item.headerRefs?.includes(ref),
      )
    )
      await props.secrets.remove(ref).catch(() => {});
  };
  const save = (use = true) =>
    work(async () => {
      const url = checkedEndpoint();
      if (!label.trim() || !model.trim())
        throw new Error("Give this provider a name and choose a model.");
      const credential = key.trim()
        ? await putProviderCredential(props.secrets, kind, url.origin, key)
        : undefined;
      let committed = false;
      try {
        const ref = credential?.ref ?? savedCredential(url);
        if (kind === "openrouter" && !ref)
          throw new Error("Enter your OpenRouter API key.");
        const value = connection(url, ref);
        await props.registry.save(value);
        committed = true;
        if (editing?.credentialRef !== ref)
          await cleanupCredential(editing?.credentialRef);
        setKey("");
        setEditing(value);
        await reload();
        setStatus(`${value.label} saved. It's in your provider list.`);
        if (use) await select(value);
        else if (
          (await props.registry.selected(props.conversationId))?.id === value.id
        )
          await props.onSelected(value);
      } finally {
        if (credential && !committed)
          await props.secrets.remove(credential.ref).catch(() => {});
      }
    });
  const edit = (value: ChatProviderRegistration) => {
    setEditing(value);
    setKind(value.kind);
    setLabel(value.label);
    setEndpoint(value.endpoint ?? "");
    setModel(value.modelId);
    setKey("");
    setCleartext(value.cleartextAuthorized === true);
    setManual(false);
  };
  const remove = () =>
    work(async () => {
      if (!pendingRemove) return;
      const value = pendingRemove;
      await props.registry.remove(value.id, props.conversationId);
      await reload();
      setPendingRemove(null);
      if (editing?.id === value.id) reset();
      await cleanupCredential(value.credentialRef);
      setStatus(`${value.label} removed. Your conversations are kept.`);
    });
  const filtered = registrations.filter((value) =>
    `${value.label} ${value.modelId} ${value.kind}`
      .toLowerCase()
      .includes(savedQuery.toLowerCase()),
  );
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        padding: 16,
        gap: 14,
        backgroundColor: theme.colors.background,
      }}
    >
      <Text accessibilityRole="header" variant="headlineSmall">
        Your provider buddies
      </Text>
      <Text>
        One address book for local servers, cloud models, and on-device AI. Save
        a connection once and come back anytime.
      </Text>
      {loadingSaved ? (
        <Text accessibilityLiveRegion="polite">Opening your address book…</Text>
      ) : null}
      {registrations.length > 3 ? (
        <NativeInput
          accessibilityLabel="Search saved providers"
          label="Search saved providers"
          value={savedQuery}
          onChangeText={setSavedQuery}
        />
      ) : null}
      {!registrations.length && !loadingSaved ? (
        <NativeSurface
          accessibilityLabel="Empty provider address book"
          style={{ padding: 18, gap: 6 }}
        >
          <Text variant="titleMedium">Your first AI buddy is waiting.</Text>
          <Text>Add a local server or cloud provider below.</Text>
        </NativeSurface>
      ) : null}
      {filtered.map((value) => (
        <NativeSurface
          key={value.id}
          accessibilityLabel={`Saved provider ${value.label}`}
          style={{ padding: 12, gap: 8 }}
        >
          <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
            <View
              style={{
                backgroundColor: theme.colors.primaryContainer,
                padding: 10,
              }}
            >
              <Text style={{ color: theme.colors.primary, fontSize: 22 }}>
                {nativeKinds.includes(value.kind) ? "▣" : "✦"}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="titleMedium">
                {value.favorite ? "★ " : ""}
                {value.label}
              </Text>
              <Text variant="bodySmall" numberOfLines={2}>
                {value.modelId}
              </Text>
              <Text variant="labelSmall">{kindLabel(value.kind)}</Text>
            </View>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <NativeButton
              accessibilityLabel={`Use saved provider ${value.label}`}
              disabled={busy}
              mode="contained"
              onPress={() => void work(() => select(value))}
            >
              Chat with this buddy
            </NativeButton>
            <NativeButton
              accessibilityLabel={`Favorite provider ${value.label}`}
              accessibilityState={{ selected: value.favorite === true }}
              disabled={busy}
              onPress={() =>
                void work(async () => {
                  await props.registry.save({
                    ...value,
                    favorite: !value.favorite,
                  });
                  setEditing((current) =>
                    current?.id === value.id
                      ? { ...current, favorite: !value.favorite }
                      : current,
                  );
                  await reload();
                })
              }
            >
              {value.favorite ? "★" : "☆"}
            </NativeButton>
            {!nativeKinds.includes(value.kind) ? (
              <>
                <NativeButton
                  accessibilityLabel={`Edit provider ${value.label}`}
                  disabled={busy}
                  onPress={() => edit(value)}
                >
                  Edit
                </NativeButton>
                <NativeButton
                  accessibilityLabel={`Remove provider ${value.label}`}
                  disabled={busy}
                  onPress={() => setPendingRemove(value)}
                >
                  Remove
                </NativeButton>
              </>
            ) : null}
          </View>
        </NativeSurface>
      ))}
      {pendingRemove ? (
        <NativeSurface
          accessibilityLabel="Confirm provider removal"
          style={{ padding: 14, gap: 8 }}
        >
          <Text>Remove {pendingRemove.label} from your address book?</Text>
          <Text>
            Your history stays. Other chats using this connection will need a
            new provider.
          </Text>
          <NativeButton
            accessibilityLabel="Confirm remove provider"
            disabled={busy}
            onPress={() => void remove()}
          >
            Remove connection
          </NativeButton>
          <NativeButton
            accessibilityLabel="Keep provider"
            onPress={() => setPendingRemove(null)}
          >
            Keep it
          </NativeButton>
        </NativeSurface>
      ) : null}
      <NativeButton
        accessibilityLabel="Add provider"
        disabled={busy}
        onPress={() => {
          reset();
          setEndpoint("");
        }}
      >
        ＋ Add an AI buddy
      </NativeButton>
      <NativeSurface
        accessibilityLabel="Provider connection editor"
        style={{ padding: 14, gap: 12 }}
      >
        <Text variant="titleMedium">
          {editing ? `Edit ${editing.label}` : "New connection"}
        </Text>
        <NativeDropdown
          label="Provider type"
          value={kind}
          options={CHAT_PROVIDER_KINDS.filter(
            (value) => !nativeKinds.includes(value),
          ).map((value) => ({ value, label: kindLabel(value) }))}
          onChange={chooseKind}
          disabled={busy}
        />
        <NativeInput
          label="Provider name"
          accessibilityLabel="Provider name"
          value={label}
          onChangeText={setLabel}
          editable={!busy}
          placeholder="My OxCoder, OpenRouter…"
        />
        <NativeInput
          label="Provider endpoint URL"
          accessibilityLabel="Provider endpoint URL"
          value={endpoint}
          onChangeText={setEndpoint}
          editable={!busy && kind !== "openrouter"}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="http://192.168.1.213:35961/v1"
        />
        <NativeInput
          label={
            editing?.credentialRef
              ? "API key · blank keeps saved key"
              : kind === "openrouter"
                ? "OpenRouter API key (required)"
                : "Provider API key (optional)"
          }
          accessibilityLabel="Provider API key"
          value={key}
          onChangeText={setKey}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
        />
        {kind !== "openrouter" ? (
          <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
            <Switch
              accessibilityLabel="Authorize local HTTP origin"
              value={cleartext}
              onValueChange={setCleartext}
              disabled={busy}
            />
            <Text style={{ flex: 1 }}>Allow this local HTTP origin</Text>
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            <Text>
              Model browsing needs no key. Chat uses your OpenRouter account and
              may use credits.
            </Text>
            <Text
              accessibilityRole="link"
              accessibilityLabel="Create an OpenRouter API key"
              style={{ color: theme.colors.primary, paddingVertical: 10 }}
              onPress={() =>
                void Linking.openURL("https://openrouter.ai/settings/keys")
              }
            >
              Create an OpenRouter API key ↗
            </Text>
          </View>
        )}
        <NativeDropdown
          label="Chat model"
          value={model}
          options={availableModels.map((value) => ({ value, label: value }))}
          disabled={busy}
          loading={busy}
          onChange={setModel}
          onOpen={() => {
            if (!availableModels.length && endpoint.trim()) void queryModels();
          }}
          emptyText={
            error ||
            "Load models from your endpoint, or enter a custom ID below."
          }
        />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <NativeButton
            accessibilityLabel={
              kind === "openrouter"
                ? "Load OpenRouter models"
                : "Load endpoint models"
            }
            disabled={busy}
            loading={busy}
            onPress={() => void queryModels()}
          >
            ↻ Load models
          </NativeButton>
          <NativeButton
            accessibilityLabel="Enter custom model ID"
            disabled={busy}
            onPress={() => setManual(!manual)}
          >
            {manual ? "Hide custom ID" : "Custom model ID…"}
          </NativeButton>
        </View>
        {manual ? (
          <NativeInput
            label="Exact chat model ID"
            accessibilityLabel="Exact chat model ID"
            value={model}
            onChangeText={setModel}
            autoCapitalize="none"
            editable={!busy}
          />
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <NativeButton
            accessibilityLabel="Test connection"
            disabled={busy}
            onPress={() => void queryModels(true)}
          >
            Test connection
          </NativeButton>
          <NativeButton
            accessibilityLabel="Save provider to list"
            disabled={busy}
            onPress={() => void save(false)}
          >
            Save to list
          </NativeButton>
          <NativeButton
            accessibilityLabel="Save and use provider"
            disabled={busy}
            mode="contained"
            onPress={() => void save()}
          >
            Save & chat
          </NativeButton>
        </View>
      </NativeSurface>
      {status ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: theme.colors.secondary }}
        >
          {status}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: theme.colors.error }}>
          {error}
        </Text>
      ) : null}
      <NativeButton accessibilityLabel="Back to chat" onPress={props.onClose}>
        Back to chat
      </NativeButton>
    </ScrollView>
  );
}
