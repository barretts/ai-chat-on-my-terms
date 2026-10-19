import { useEffect, useRef, useState } from "react";
import { Keyboard, Linking, Platform, ScrollView, View } from "react-native";
import {
  List,
  SegmentedButtons,
  Switch,
  Text,
  useTheme,
} from "react-native-paper";
import type {
  SecretDescriptor,
  SecretRef,
  SecretStore,
} from "@locallab/security-secrets";
import { SecretStoreError } from "@locallab/security-secrets";
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
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";
import {
  CLOUD_COMPATIBLE_PRESETS,
  createCloudCompatibleProvider,
} from "@locallab/provider-cloud-compatible";
import {
  OPENAI_RESPONSES_ENDPOINT,
  putProviderCredential,
  validateProviderEndpoint,
  verifyOpenRouterCredential,
} from "./provider-setup-helpers";
import { LanConnectionDiscovery } from "./lan-connection-discovery";
import { describeError } from "../../features/diagnostics/errors";
import { ErrorNotice } from "../../features/diagnostics/error-notice";

const nativeKinds = ["local-gguf", "mlx-ios", "mac-gguf", "mac-mlx"];
const localServerKinds = [
  "ollama",
  "lmstudio",
  "jan",
  "omlx",
  "unsloth",
  "compatible",
];
const thisPcEndpoint = "http://192.168.1.213:35961/v1";
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
  openai: OPENAI_RESPONSES_ENDPOINT,
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
  const { phone } = useWorkspaceLayout();
  const [registrations, setRegistrations] = useState<
    ChatProviderRegistration[]
  >([]);
  const [loadingSaved, setLoadingSaved] = useState(true);
  const [kind, setKind] = useState<ChatProviderKind>("compatible");
  const [label, setLabel] = useState(phone ? "This PC" : "");
  const [endpoint, setEndpoint] = useState(phone ? thisPcEndpoint : "");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [cleartext, setCleartext] = useState(phone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [availableModels, setAvailableModels] = useState<readonly string[]>([]);
  const [editing, setEditing] = useState<ChatProviderRegistration | null>(null);
  const [pendingRemove, setPendingRemove] =
    useState<ChatProviderRegistration | null>(null);
  const [manual, setManual] = useState(false);
  const [savedQuery, setSavedQuery] = useState("");
  const [showEditor, setShowEditor] = useState(false);
  const [credentialProblems, setCredentialProblems] = useState<
    Record<string, string>
  >({});
  const [activeId, setActiveId] = useState<string>();
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  const [dropHeaders, setDropHeaders] = useState(false);
  const operation = useRef(false);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const scroll = useRef<ScrollView>(null);
  const cleanupPending = useRef(new Map<SecretRef, string>());
  const reportFailure = (
    cause: unknown,
    operation: string,
    recovery: string,
  ) => {
    const message = describeError(cause, { operation, recovery });
    if (mounted.current)
      setError((current) => (current ? `${current}\n\n${message}` : message));
  };
  const removeSecureValue = async (ref: SecretRef, operation: string) => {
    try {
      await props.secrets.remove(ref);
      cleanupPending.current.delete(ref);
      return true;
    } catch (cause) {
      cleanupPending.current.set(ref, operation);
      reportFailure(
        cause,
        operation,
        "Use Retry secure cleanup to remove the pending value. Review the trace log if it still fails.",
      );
      return false;
    }
  };
  useEffect(() => {
    if (!error) return;
    Keyboard.dismiss();
    requestAnimationFrame(() =>
      scroll.current?.scrollTo({ y: 0, animated: true }),
    );
  }, [error]);
  const reload = async () => {
    const list = await props.registry.list();
    const problems: Record<string, string> = {};
    await Promise.all(
      list.map(async (value) => {
        const refs = [
          ...(value.credentialRef ? [value.credentialRef] : []),
          ...(value.headerRefs ?? []),
        ];
        if (!refs.length || !value.endpoint) return;
        try {
          await props.secrets.resolveHeaders(
            new URL(value.endpoint).origin,
            refs,
          );
        } catch (cause) {
          problems[value.id] = describeError(cause, {
            operation: "Read saved connection credentials",
            recovery:
              "Edit this connection and enter the API key again. Clear unavailable custom headers and re-enter them if needed.",
          });
        }
      }),
    );
    const active = await props.registry.selected(props.conversationId);
    if (mounted.current) {
      setRegistrations(list);
      setCredentialProblems(problems);
      setActiveId(active?.id);
      if (Object.keys(problems).length)
        setError((current) => current || Object.values(problems).join("\n\n"));
    }
    return list;
  };
  useEffect(() => {
    mounted.current = true;
    void reload()
      .then((list) => {
        if (mounted.current) setShowEditor(list.length === 0);
      })
      .catch((cause) =>
        reportFailure(
          cause,
          "Load saved provider connections",
          "Reopen Connections and try again.",
        ),
      )
      .finally(() => {
        if (mounted.current) setLoadingSaved(false);
      });
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, [props.registry]);
  useEffect(() => {
    setAvailableModels([]);
    setStatus("");
  }, [kind, endpoint]);
  const reset = () => {
    setError("");
    setStatus("");
    setEditing(null);
    setLabel("");
    setModel("");
    setKey("");
    setCleartext(false);
    setAvailableModels([]);
    setManual(false);
    setHeaderName("");
    setHeaderValue("");
    setDropHeaders(false);
  };
  const chooseKind = (value: string) => {
    const previous = editing;
    reset();
    if (previous) {
      setEditing(previous);
      setLabel(previous.label);
    }
    if (value === "this-pc") {
      setKind("compatible");
      setLabel("This PC");
      setEndpoint(thisPcEndpoint);
      setCleartext(true);
      return;
    }
    setKind(value as ChatProviderKind);
    setEndpoint(defaults[value] ?? "");
    if (value === "openrouter" && !previous) setLabel("OpenRouter");
  };
  const select = async (value: ChatProviderRegistration) => {
    if (value.modelId === "model-discovery") {
      edit(value);
      reportFailure(
        new Error("This connection has no selected chat model."),
        "Use saved connection",
        "Choose a chat model, then save this connection.",
      );
      return;
    }
    const refs = [
      ...(value.credentialRef ? [value.credentialRef] : []),
      ...(value.headerRefs ?? []),
    ];
    if (value.endpoint && refs.length) {
      try {
        await props.secrets.resolveHeaders(
          new URL(value.endpoint).origin,
          refs,
        );
      } catch (cause) {
        edit(value);
        throw cause;
      }
    }
    await props.registry.select(props.conversationId, value.id);
    await props.onSelected(value);
    props.onClose();
  };
  const checkedEndpoint = () =>
    validateProviderEndpoint(kind, endpoint, cleartext);
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
    ...(localServerKinds.includes(kind) &&
    !dropHeaders &&
    editing?.headerRefs &&
    editing.kind === kind &&
    editing.endpoint &&
    new URL(editing.endpoint).origin === url.origin
      ? { headerRefs: editing.headerRefs }
      : {}),
    cleartextAuthorized: cleartext,
    favorite: editing?.favorite ?? false,
    allowCrossProviderRouting: editing?.allowCrossProviderRouting ?? false,
  });
  const prepareHeaders = async (url: URL) => {
    const base = connection(url);
    if (!headerValue.trim())
      return {
        refs: base.headerRefs ?? [],
        added: undefined as SecretRef | undefined,
      };
    if (!headerName.trim())
      throw new Error("Enter a name for the custom header.");
    const refs: SecretRef[] = [];
    for (const ref of base.headerRefs ?? []) {
      const resolved = await props.secrets.resolveHeaders(url.origin, [ref]);
      if (!Object.hasOwn(resolved, headerName.trim().toLowerCase()))
        refs.push(ref);
    }
    const added = await props.secrets.put(
      url.origin,
      headerName.trim(),
      headerValue.trim(),
    );
    return { refs: [...refs, added.ref], added: added.ref };
  };
  const work = async (
    action: () => Promise<void>,
    operationName: string,
    recovery: string,
  ) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await action();
    } catch (cause) {
      reportFailure(
        cause,
        operationName,
        cause instanceof SecretStoreError && cause.code === "invalid-header"
          ? "Check custom header names. Each header can have one value: use the API key field or a custom Authorization header."
          : recovery,
      );
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const queryModels = (test = false) =>
    work(
      async () => {
        setStatus("");
        const url = checkedEndpoint();
        let credential: SecretDescriptor | undefined;
        let addedHeader: SecretRef | undefined;
        const controller = new AbortController();
        request.current = controller;
        const timeout = setTimeout(
          () =>
            controller.abort(
              new Error(
                "The endpoint took too long. Check the server address.",
              ),
            ),
          20000,
        );
        let port: ReturnType<typeof createRegisteredChatProvider> | undefined;
        let observed: { status: number; url: string } | undefined;
        const endpointFetch: typeof fetch = async (input, init) => {
          const response = await providerFetch(input, init);
          observed = {
            status: response.status,
            url: response.url || String(input),
          };
          return response;
        };
        try {
          credential = key.trim()
            ? await putProviderCredential(props.secrets, kind, url.origin, key)
            : undefined;
          if (!mounted.current || controller.signal.aborted)
            throw new Error("Connection request canceled.");
          const ref = credential?.ref ?? savedCredential(url);
          const headers = await prepareHeaders(url);
          addedHeader = headers.added;
          if (!mounted.current || controller.signal.aborted)
            throw new Error("Connection request canceled.");
          if (kind === "openrouter" && test) {
            if (!ref) throw new Error("Enter your OpenRouter API key.");
            await verifyOpenRouterCredential(
              props.secrets,
              ref,
              endpointFetch,
              controller.signal,
            );
          }
          const publicRouter = kind === "openrouter" && !test;
          port = publicRouter
            ? createCloudCompatibleProvider({
                fetch: endpointFetch,
                secrets: props.secrets,
                resolveConnection: async () => ({ provider: "openrouter" }),
              })
            : createRegisteredChatProvider(
                { ...connection(url, ref), headerRefs: headers.refs },
                {
                  fetch: endpointFetch,
                  secrets: props.secrets,
                },
              );
          const result = await port.listModels(
            publicRouter ? { provider: "openrouter" } : undefined,
            controller.signal,
          );
          if (!result.ok)
            throw {
              ...result.error,
              message: `${result.error.message}\nEndpoint: ${observed?.url ?? url.toString()}${observed ? ` (HTTP ${observed.status})` : ""}.`,
              ...(observed ? { status: observed.status } : {}),
            };
          if (!mounted.current) return;
          const list = [...new Set(result.value)].sort();
          setAvailableModels(list);
          const selectedModel = model || (list.length === 1 ? list[0]! : "");
          if (selectedModel !== model) setModel(selectedModel);
          if (test && (!selectedModel || !list.includes(selectedModel)))
            throw new Error(
              model
                ? `This endpoint does not list ${model}. Choose an available model.`
                : "Choose a model from the dropdown, then test again.",
            );
          setStatus(
            test
              ? `Connected: ${selectedModel} is available.`
              : `Found ${list.length} models on your endpoint. Choose one from the dropdown.`,
          );
        } catch (cause) {
          if (
            controller.signal.aborted &&
            controller.signal.reason instanceof Error &&
            controller.signal.reason.name === "AbortError"
          ) {
            if (mounted.current) setStatus("Connection request canceled.");
            return;
          }
          throw controller.signal.aborted
            ? (controller.signal.reason ?? cause)
            : cause;
        } finally {
          clearTimeout(timeout);
          if (request.current === controller) request.current = null;
          try {
            await port?.dispose?.();
          } catch (cause) {
            reportFailure(
              cause,
              "Close provider model request",
              "Retry the model request. Inspect the trace log if provider cleanup still fails.",
            );
          } finally {
            await Promise.all([
              ...(credential
                ? [
                    removeSecureValue(
                      credential.ref,
                      "Remove temporary provider API key",
                    ),
                  ]
                : []),
              ...(addedHeader
                ? [
                    removeSecureValue(
                      addedHeader,
                      "Remove temporary custom header",
                    ),
                  ]
                : []),
            ]);
          }
        }
      },
      test ? "Test provider connection" : "Load endpoint models",
      "Check the endpoint, server status, API key and selected model, then try again.",
    );
  const cleanupCredential = async (
    ref: ChatProviderRegistration["credentialRef"],
  ) => {
    if (!ref) return true;
    const saved = await props.registry.list();
    if (
      !saved.some(
        (item) => item.credentialRef === ref || item.headerRefs?.includes(ref),
      )
    )
      return removeSecureValue(ref, "Remove previous provider credential");
    return true;
  };
  const save = (use = true) =>
    work(
      async () => {
        const url = checkedEndpoint();
        if (!label.trim() || !model.trim())
          throw new Error("Give this provider a name and choose a model.");
        const credential = key.trim()
          ? await putProviderCredential(props.secrets, kind, url.origin, key)
          : undefined;
        let committed = false;
        let addedHeader: SecretRef | undefined;
        let cleanupSucceeded = true;
        try {
          const ref = credential?.ref ?? savedCredential(url);
          if (ref) await props.secrets.resolveHeaders(url.origin, [ref]);
          if (!localServerKinds.includes(kind) && !ref)
            throw new Error(
              `Enter your ${kindLabel(kind)} API key before saving.`,
            );
          const headers = await prepareHeaders(url);
          addedHeader = headers.added;
          if (ref || headers.refs.length)
            await props.secrets.resolveHeaders(url.origin, [
              ...(ref ? [ref] : []),
              ...headers.refs,
            ]);
          const value = { ...connection(url, ref), headerRefs: headers.refs };
          await props.registry.save(value);
          committed = true;
          if (editing?.credentialRef !== ref)
            cleanupSucceeded =
              (await cleanupCredential(editing?.credentialRef)) &&
              cleanupSucceeded;
          for (const previous of editing?.headerRefs ?? [])
            if (!headers.refs.includes(previous))
              cleanupSucceeded =
                (await cleanupCredential(previous)) && cleanupSucceeded;
          setKey("");
          setHeaderValue("");
          setHeaderName("");
          setEditing(value);
          await reload();
          setStatus(`${value.label} saved. It's in your provider list.`);
          if (!cleanupSucceeded) return;
          if (use) await select(value);
          else {
            if (
              (await props.registry.selected(props.conversationId))?.id ===
              value.id
            )
              await props.onSelected(value);
            setShowEditor(false);
            setEditing(null);
          }
        } finally {
          if (credential && !committed)
            await removeSecureValue(
              credential.ref,
              "Remove unsaved provider API key",
            );
          if (addedHeader && !committed)
            await removeSecureValue(
              addedHeader,
              "Remove unsaved custom header",
            );
        }
      },
      "Save provider connection",
      "Check the connection fields and secure credentials, then save again. If it was already saved, verify it in your connection list.",
    );
  const edit = (value: ChatProviderRegistration) => {
    setShowEditor(true);
    setEditing(value);
    setKind(value.kind);
    setLabel(value.label);
    setEndpoint(value.endpoint ?? "");
    setModel(value.modelId === "model-discovery" ? "" : value.modelId);
    setKey("");
    setCleartext(value.cleartextAuthorized === true);
    setManual(false);
    setHeaderName("");
    setHeaderValue("");
    setDropHeaders(false);
  };
  const remove = () =>
    work(
      async () => {
        if (!pendingRemove) return;
        const value = pendingRemove;
        setPendingRemove(null);
        await props.registry.remove(value.id, props.conversationId);
        if (editing?.id === value.id) reset();
        await cleanupCredential(value.credentialRef);
        for (const ref of value.headerRefs ?? []) await cleanupCredential(ref);
        await reload();
        setStatus(`${value.label} removed. Your conversations are kept.`);
      },
      "Remove provider connection",
      "Check your connection list, then retry removal or Retry secure cleanup. Conversations are kept.",
    );
  const filtered = registrations.filter((value) =>
    `${value.label} ${value.modelId} ${value.kind}`
      .toLowerCase()
      .includes(savedQuery.toLowerCase()),
  );
  return (
    <ScrollView
      ref={scroll}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        padding: 16,
        gap: 14,
        backgroundColor: theme.colors.background,
      }}
    >
      <Text accessibilityRole="header" variant="headlineSmall">
        Your connections
      </Text>
      <Text>
        Choose a saved connection, or add your computer or an online provider.
      </Text>
      {error ? <ErrorNotice message={error} /> : null}
      {cleanupPending.current.size ? (
        <NativeButton
          accessibilityLabel="Retry secure cleanup"
          disabled={busy}
          onPress={() =>
            void work(
              async () => {
                for (const [ref, operation] of cleanupPending.current)
                  await removeSecureValue(ref, operation);
                if (!cleanupPending.current.size)
                  setStatus("Pending secure values removed.");
              },
              "Retry secure credential cleanup",
              "Try again and inspect the trace log if secure storage remains unavailable.",
            )
          }
        >
          Retry secure cleanup
        </NativeButton>
      ) : null}
      {status ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: theme.colors.secondary }}
        >
          {status}
        </Text>
      ) : null}
      {busy && request.current ? (
        <NativeButton
          accessibilityLabel="Cancel connection request"
          onPress={() => request.current?.abort()}
        >
          Cancel request
        </NativeButton>
      ) : null}
      {loadingSaved ? (
        <Text accessibilityLiveRegion="polite">Opening your address book…</Text>
      ) : null}
      {!showEditor && registrations.length > 3 ? (
        <NativeInput
          accessibilityLabel="Search saved providers"
          label="Search saved providers"
          value={savedQuery}
          onChangeText={setSavedQuery}
        />
      ) : null}
      {!phone && !showEditor && !registrations.length && !loadingSaved ? (
        <NativeSurface
          accessibilityLabel="Empty provider address book"
          style={{ padding: 18, gap: 6 }}
        >
          <Text variant="titleMedium">Add your first connection</Text>
          <Text>Add a local server or cloud provider below.</Text>
        </NativeSurface>
      ) : null}
      {!showEditor &&
        filtered.map((value) => (
          <NativeSurface
            key={value.id}
            accessibilityLabel={`Saved provider ${value.label}`}
            style={{ padding: 12, gap: 8 }}
          >
            <View
              style={{ flexDirection: "row", gap: 10, alignItems: "center" }}
            >
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
                  {value.modelId === "model-discovery"
                    ? "Choose a chat model"
                    : value.modelId}
                </Text>
                <Text variant="labelSmall">{kindLabel(value.kind)}</Text>
                {activeId === value.id ? (
                  <Text style={{ color: theme.colors.primary }}>
                    Current chat
                  </Text>
                ) : null}
              </View>
            </View>
            {credentialProblems[value.id] ? (
              <ErrorNotice message={credentialProblems[value.id]!} />
            ) : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              <NativeButton
                accessibilityLabel={`Use saved provider ${value.label}`}
                disabled={busy}
                mode="contained"
                onPress={() =>
                  void work(
                    () => select(value),
                    "Use saved provider connection",
                    "Edit this connection and check its selected model and saved credentials, then try again.",
                  )
                }
              >
                {credentialProblems[value.id]
                  ? "Enter credentials"
                  : value.modelId === "model-discovery"
                    ? "Choose model"
                    : activeId === value.id
                      ? "Return to chat"
                      : "Use in chat"}
              </NativeButton>
              <NativeButton
                accessibilityLabel={`Favorite provider ${value.label}`}
                accessibilityState={{ selected: value.favorite === true }}
                disabled={busy}
                onPress={() =>
                  void work(
                    async () => {
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
                    },
                    "Save provider favorite",
                    "Try marking the connection as a favorite again.",
                  )
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
      {!showEditor && !loadingSaved ? (
        <NativeButton
          accessibilityLabel="Add provider"
          disabled={busy}
          onPress={() => {
            reset();
            chooseKind(phone ? "this-pc" : "compatible");
            setShowEditor(true);
          }}
        >
          Add a connection
        </NativeButton>
      ) : null}
      {showEditor && !loadingSaved ? (
        <NativeSurface
          accessibilityLabel="Provider connection editor"
          style={{ padding: 14, gap: 12 }}
        >
          <Text variant="titleMedium">
            {editing ? `Edit ${editing.label}` : "New connection"}
          </Text>
          {registrations.length ? (
            <NativeButton
              accessibilityLabel="Cancel connection edit"
              disabled={busy}
              onPress={() => {
                setShowEditor(false);
                reset();
                setError("");
                setStatus("");
              }}
            >
              Cancel
            </NativeButton>
          ) : null}
          {Platform.OS === "web" ? (
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant }}
            >
              Keys stay in this tab. After refresh, edit the connection and
              enter its key again. The iPhone app saves keys in secure storage.
            </Text>
          ) : null}
          {editing && credentialProblems[editing.id] ? (
            <ErrorNotice message={credentialProblems[editing.id]!} />
          ) : null}
          {phone && !editing ? (
            <SegmentedButtons
              value={
                kind === "compatible" &&
                endpoint.replace(/\/$/, "") === thisPcEndpoint
                  ? "this-pc"
                  : kind === "openrouter"
                    ? "openrouter"
                    : "custom"
              }
              onValueChange={(value) =>
                chooseKind(value === "custom" ? "compatible" : value)
              }
              buttons={[
                {
                  value: "this-pc",
                  label: "This PC",
                  disabled: busy,
                  style: { minHeight: 44 },
                },
                {
                  value: "openrouter",
                  label: "OpenRouter",
                  disabled: busy,
                  style: { minHeight: 44 },
                },
                {
                  value: "custom",
                  label: "Other",
                  disabled: busy,
                  style: { minHeight: 44 },
                },
              ]}
            />
          ) : null}
          <ConnectionDetails
            folded={
              phone &&
              !editing &&
              ((kind === "compatible" &&
                endpoint.replace(/\/$/, "") === thisPcEndpoint) ||
                kind === "openrouter")
            }
            title="Connection settings"
          >
            <NativeDropdown
              label="Provider type"
              value={
                kind === "compatible" &&
                endpoint.replace(/\/$/, "") === thisPcEndpoint
                  ? "this-pc"
                  : kind
              }
              options={[
                { value: "this-pc", label: "This PC · local coder" },
                ...CHAT_PROVIDER_KINDS.filter(
                  (value) => !nativeKinds.includes(value),
                ).map((value) => ({ value, label: kindLabel(value) })),
              ]}
              onChange={chooseKind}
              disabled={busy}
            />
            <NativeInput
              label={phone ? "Connection name" : "Provider name"}
              accessibilityLabel="Provider name"
              value={label}
              onChangeText={setLabel}
              editable={!busy}
              placeholder="My OxCoder, OpenRouter…"
            />
            <NativeInput
              label={phone ? "Server address" : "Provider endpoint URL"}
              accessibilityLabel="Provider endpoint URL"
              value={endpoint}
              onChangeText={setEndpoint}
              editable={!busy && kind !== "openrouter"}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="http://192.168.1.213:35961/v1"
            />
            {kind !== "openrouter" ? (
              <NativeInput
                label={
                  editing?.credentialRef &&
                  editing.endpoint &&
                  new URL(editing.endpoint).origin ===
                    (() => {
                      try {
                        return new URL(endpoint).origin;
                      } catch {
                        return "";
                      }
                    })() &&
                  !credentialProblems[editing.id]
                    ? "API key · blank keeps saved key"
                    : localServerKinds.includes(kind)
                      ? "API key (optional)"
                      : `${kindLabel(kind)} API key`
                }
                accessibilityLabel="Provider API key"
                value={key}
                onChangeText={setKey}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
              />
            ) : null}
          </ConnectionDetails>
          {kind === "compatible" &&
          endpoint.replace(/\/$/, "") === thisPcEndpoint ? (
            <Text
              variant="bodyMedium"
              style={{ color: theme.colors.onSurfaceVariant }}
            >
              Your phone and PC need the same Wi-Fi network. Choose the model
              currently running on your PC.
            </Text>
          ) : null}
          {kind === "openrouter" ? (
            <NativeInput
              label={
                editing?.credentialRef && !credentialProblems[editing.id]
                  ? "API key · blank keeps saved key"
                  : "OpenRouter API key"
              }
              accessibilityLabel="Provider API key"
              value={key}
              onChangeText={setKey}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
            />
          ) : null}
          {kind !== "openrouter" ? (
            <View
              style={{ flexDirection: "row", gap: 10, alignItems: "center" }}
            >
              <Switch
                accessibilityLabel="Authorize local HTTP origin"
                value={cleartext}
                onValueChange={setCleartext}
                disabled={busy}
              />
              <Text style={{ flex: 1 }}>
                {phone
                  ? "Allow this local connection"
                  : "Allow this local HTTP origin"}
              </Text>
            </View>
          ) : (
            <View style={{ gap: 8 }}>
              <Text>
                Model browsing needs no key. Chat uses your OpenRouter account
                and may use credits.
              </Text>
              <Text
                accessibilityRole="link"
                accessibilityLabel="Create an OpenRouter API key"
                style={{ color: theme.colors.primary, paddingVertical: 10 }}
                onPress={() =>
                  void Linking.openURL(
                    "https://openrouter.ai/settings/keys",
                  ).catch((cause) =>
                    reportFailure(
                      cause,
                      "Open OpenRouter key settings",
                      "Open https://openrouter.ai/settings/keys in your browser.",
                    ),
                  )
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
              if (!availableModels.length && endpoint.trim())
                void queryModels();
            }}
            emptyText="Load models from your endpoint, or enter a custom ID below. Endpoint failures are shown above."
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
              mode={phone ? "contained-tonal" : "text"}
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
          {phone ? (
            <NativeButton
              accessibilityLabel="Save and use provider"
              disabled={busy}
              mode="contained"
              onPress={() => void save()}
            >
              Save & chat
            </NativeButton>
          ) : null}
          <ConnectionDetails folded={phone} title="More actions">
            <LanConnectionDiscovery
              onError={setError}
              disabled={busy}
              onChoose={(value) => {
                setKind("compatible");
                setEndpoint(value);
                setCleartext(true);
                if (!label.trim()) setLabel("Local server");
              }}
            />
            {localServerKinds.includes(kind) ? (
              <View style={{ gap: 12 }}>
                <Text variant="titleSmall">Custom request headers</Text>
                <Text variant="bodySmall">
                  For servers that require an extra header. Values are saved
                  securely with this connection.
                </Text>
                {editing?.headerRefs?.length ? (
                  <>
                    <Text>
                      {dropHeaders
                        ? "Saved custom headers will be removed when you save."
                        : `${editing.headerRefs.length} custom header(s) saved.`}
                    </Text>
                    <NativeButton
                      accessibilityLabel="Clear saved custom headers"
                      disabled={busy}
                      onPress={() => setDropHeaders(!dropHeaders)}
                    >
                      {dropHeaders
                        ? "Keep saved headers"
                        : "Clear saved headers"}
                    </NativeButton>
                  </>
                ) : null}
                <NativeInput
                  label="Custom header name"
                  accessibilityLabel="Custom header name"
                  value={headerName}
                  onChangeText={setHeaderName}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  placeholder="X-API-Key"
                />
                <NativeInput
                  label="Custom header value"
                  accessibilityLabel="Custom header value"
                  value={headerValue}
                  onChangeText={setHeaderValue}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                />
              </View>
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
            </View>
          </ConnectionDetails>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {!phone ? (
              <NativeButton
                accessibilityLabel="Save and use provider"
                disabled={busy}
                mode="contained"
                style={phone ? { flex: 1 } : undefined}
                onPress={() => void save()}
              >
                Save & chat
              </NativeButton>
            ) : null}
          </View>
        </NativeSurface>
      ) : null}
      {!phone ? (
        <NativeButton accessibilityLabel="Back to chat" onPress={props.onClose}>
          Back to chat
        </NativeButton>
      ) : null}
    </ScrollView>
  );
}

function ConnectionDetails({
  folded,
  title,
  children,
}: {
  folded: boolean;
  title: string;
  children: import("react").ReactNode;
}) {
  const theme = useTheme();
  if (!folded) return <>{children}</>;
  return (
    <List.Accordion
      title={title}
      theme={{ colors: { background: theme.colors.surface } }}
      titleStyle={{ fontSize: 15 }}
      style={{ backgroundColor: "transparent" }}
    >
      <View style={{ gap: 12, paddingBottom: 12 }}>{children}</View>
    </List.Accordion>
  );
}
