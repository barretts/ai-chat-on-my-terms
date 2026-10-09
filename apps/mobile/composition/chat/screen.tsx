import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { chatStartupError } from "./startup-errors";
import { ErrorNotice } from "../../features/diagnostics/error-notice";
import { describeError } from "../../features/diagnostics/errors";
import { DiagnosticsScreen } from "../../features/diagnostics/screen";
import { traceLog } from "../../features/diagnostics/trace-log";
import {
  AccessibilityInfo,
  ActivityIndicator,
  AppState,
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import {
  Link,
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import {
  chatPageLabels,
  chatPageParam,
  readChatPage,
  type ChatPage,
} from "./navigation";
import { openConnectionCatalog } from "./connection-catalog";
import {
  discoverRegisteredModelContext,
  modelContextKey,
  supportsContextDiscovery,
} from "./model-context";
import { openMobileDatabase } from "../../platform/database-open";
import { retryMobileDatabaseOpen } from "../../platform/database-retry";
import { memoryModelControlPrompt } from "./persona-memory";
import { createLocalChatPort } from "../../platform/local-chat-provider";
import { createId as createChatId } from "../../platform/crypto";
import { providerFetch } from "../../platform/provider-fetch";
import { writeClipboardMarkdown } from "../../platform/clipboard";
import { SpeechPanel } from "../../features/speech/screen";
import { mobileSpeech } from "../../platform/speech";
import { listInstalledModels } from "../../platform/model-download";
import {
  createGenerationSession,
  type GenerationSession,
} from "../../platform/generation-session";
import { recoverInterruptedChatRuns } from "./recovery";
import {
  Appbar,
  Button,
  Dialog,
  Divider,
  Icon,
  IconButton,
  List,
  Modal,
  Portal,
  SegmentedButtons,
  Text,
  useTheme,
  type MD3Theme,
} from "react-native-paper";
import {
  NativeButton,
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";
import { SQLiteOnboardingRepository } from "../../features/onboarding";
import type { CapabilityMap, ProviderPort } from "@locallab/contracts/ports";
import type { FetchLike } from "@locallab/network-http";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { AdvancedChatEngine } from "@locallab/chat-engine-advanced";
import {
  ToolLoopEngine,
  ToolRegistry,
  SQLiteToolInvocationStore,
} from "@locallab/tools-engine";
import { conservativeTokenCount, ContextBudgetError } from "@locallab/context";
import {
  SQLiteWorkspaceFiles,
  createWorkspaceTools,
  validateWorkspacePath,
} from "../../features/workspace-files";
import { WorkspaceFilesScreen } from "../../features/workspace-files/screen";
import {
  WORKSPACE_FILES_TOOL,
  workspaceFileIntent,
  requestsWorkspaceTools,
  workspaceDocumentInstruction,
} from "./workspace-file-intent";
import {
  withWorkspaceFileOutput,
  withVerifiedWorkspaceFileSave,
} from "./workspace-file-output";
import { mobileArchiveZip } from "./archives/zip";
import {
  createSQLiteChatFeatureBindings,
  toRecoverableChatError,
  chatFailureCause,
  ChatAttachmentIntakeError,
} from "@locallab/chat-integration";
import { SQLiteGenerationLifecycle } from "@locallab/generation-lifecycle-ios";
import type { ContextPolicy } from "@locallab/context";
import { SQLiteChatHistory } from "@locallab/chat-history";
import { createOpenAIResponsesProvider } from "@locallab/provider-openai-first-run";
import type { BlobStore } from "@locallab/storage-blobs";
import { createNativeMobileSecretStore } from "../../platform/secrets";
import { openMobileBlobStore } from "../../platform/files";
import { AdvancedComposer } from "../../features/composer/advanced/composer";
import {
  SQLiteComposerPreferenceStore,
  type ComposerSendPayload,
} from "../../features/composer/advanced";
import { Transcript } from "../../features/transcript/core/transcript";
import { OpenAIEndpointSetupScreen } from "../../features/openai-endpoint-setup/screen";
import {
  resolveOpenAIEndpointConnection,
  SQLiteOpenAIEndpointSetupRepository,
} from "../../features/openai-endpoint-setup";
import type { FirstRunMode } from "../first-run-chat";
import {
  allocateChatConversation,
  createProviderBinding,
  initializeFirstRunChat,
  managedBlobIdFromModelId,
  readTranscript,
} from "../first-run-chat";
import type {
  AssistantTranscriptMessage,
  UserTranscriptMessage,
} from "../../features/transcript/core";
import {
  initializeMobileChatComposition,
  createMobileChatIntegration,
  initializePersonaMemoryChat,
  personaMemoryPolicy,
  personaSystemPrompt,
} from "./index";
import {
  DEFAULT_PERSONA_ID,
  type PersonaRecord,
} from "@locallab/personas-library";
import { ProviderMemoryExtractor } from "@locallab/memory-extraction";
import { PersonaScreen } from "../../features/personas/screen";
import { createManagedPersonaAvatarPort } from "../../features/personas/avatar";
import { MemoryScreen } from "../../features/memory/screen";
import { ChatPanels } from "./panels";
import {
  createMobileChatAttachmentIntake,
  type MobileChatAttachmentIntake,
} from "./attachments";
import {
  createNativeMobileArchivePorts,
  nativeArchiveFiles,
} from "./archives/native";
import { ArchivesScreen } from "../../features/archives/screen";
import {
  SQLiteChatProviderRegistry,
  createRegisteredChatProvider,
  safeChatProvider,
  selectedCapabilities,
  type ChatProviderRegistration,
} from "./providers";
import { ProviderSetupPanel } from "./provider-setup";
import { HistoryScreen } from "../../features/history/screen";
import {
  DraftShelf,
  historyDisplayTitle,
  planNewChat,
} from "../../features/history";
import {
  deleteConversation,
  runConversationCleanups,
  type ConversationCleanupPorts,
} from "./conversation-lifecycle";
import {
  readActiveChat,
  readFallbackChatSelection,
  saveActiveChat,
} from "./selection";
import { ForegroundRunAdmission } from "./foreground";
import { useAppTheme } from "../../features/themes/provider";
import { SafeAreaView } from "react-native-safe-area-context";
import { webAccessFetch } from "../../platform/web-access";
import { braveSearchFetch } from "../../platform/brave-search-fetch";
import {
  SQLiteWebResearchSettings,
  createConfiguredWebResearchClient,
} from "./web-research-settings";
import { WebResearchSettingsPanel } from "./web-research-settings-panel";
import {
  createWebResearchClient,
  resolveWebResearchIntent,
  withWebResearch,
  WEB_FETCH_TOOL,
} from "./web-research";
import {
  EMPTY_PRESETS,
  resolveSettings,
  type ChatAppearance,
} from "../../features/chat-settings";

type ChatRuntime = {
  generationSession: GenerationSession;
  db: SQLiteDatabasePort;
  history: SQLiteChatHistory;
  engine: AdvancedChatEngine;
  blobs: BlobStore;
  connectionId: string;
  fallbackModelId: string | null;
  conversationId: string;
  secrets: ReturnType<typeof createNativeMobileSecretStore>;
  setup: SQLiteOpenAIEndpointSetupRepository;
  composition: Awaited<ReturnType<typeof initializeMobileChatComposition>>;
  intake: MobileChatAttachmentIntake;
  features: ReturnType<typeof createSQLiteChatFeatureBindings>;
  lifecycle: SQLiteGenerationLifecycle;
  registry: SQLiteChatProviderRegistry;
  webSettings: SQLiteWebResearchSettings;
  preferences: SQLiteComposerPreferenceStore;
  toolInvocations: SQLiteToolInvocationStore;
  identities: Awaited<ReturnType<typeof initializePersonaMemoryChat>>;
};
type LocalModel = { id: string; label: string; sha256: string };
type PendingLeave = { kind: "new" } | { kind: "open"; conversationId: string };

function conversationCleanupPorts(
  intake: MobileChatAttachmentIntake,
  blobs: BlobStore,
): ConversationCleanupPorts {
  return {
    releaseAttachment: (ownerId, attachmentId) =>
      intake.attachments.release(ownerId, attachmentId),
    removeBlobReference: (blobId, owner) =>
      blobs.removeReference(blobId, owner),
  };
}

const announce = (text: string) =>
  AccessibilityInfo.announceForAccessibility(text);

export default function CompleteChatScreen() {
  const speechState = useSyncExternalStore(
    mobileSpeech.subscribe,
    mobileSpeech.snapshot,
    mobileSpeech.snapshot,
  );
  const theme = useTheme();
  const layout = useWorkspaceLayout();
  const workspace = useAppTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ panel?: string | string[] }>();
  const panel = readChatPage(params.panel);
  const setPanel = useCallback(
    (
      next: ChatPage | null | ((current: ChatPage | null) => ChatPage | null),
    ) => {
      router.setParams({
        panel: chatPageParam(typeof next === "function" ? next(panel) : next),
      });
    },
    [router, panel],
  );
  const [phoneMenuOpen, setPhoneMenuOpen] = useState(false);
  useEffect(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      if (phoneMenuOpen) {
        setPhoneMenuOpen(false);
        return true;
      }
      if (panel) {
        setPanel(null);
        return true;
      }
      return false;
    });
    return () => listener.remove();
  }, [phoneMenuOpen, panel, setPanel]);
  const styles = useMemo(
    () => createStyles(theme.colors, theme.dark),
    [theme.colors, theme.dark],
  );
  const [openAttempt, setOpenAttempt] = useState(0);
  const [setupStyle, setSetupStyle] = useState<"beginner" | "power">(
    "beginner",
  );
  const [showAdvancedTools, setShowAdvancedTools] = useState(false);
  const [runtime, setRuntime] = useState<ChatRuntime | null>(null);
  const [mode, setMode] = useState<FirstRunMode>("local");
  const [models, setModels] = useState<LocalModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [users, setUsers] = useState<UserTranscriptMessage[]>([]);
  const [assistants, setAssistants] = useState<AssistantTranscriptMessage[]>(
    [],
  );
  const [working, setWorking] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [configuredModel, setConfiguredModel] = useState("");
  const [error, setError] = useState("");
  const [serverContext, setServerContext] = useState<{
    key: string;
    status: "checking" | "available" | "unavailable";
    tokens?: number;
    toolsSupported?: true;
  } | null>(null);
  useEffect(() => {
    if (error) Keyboard.dismiss();
  }, [error]);
  const [attachmentNotice, setAttachmentNotice] = useState("");
  const [clipboardResult, setClipboardResult] = useState<{
    message: string;
    failed: boolean;
  } | null>(null);
  const [activeStop, setActiveStop] = useState<(() => Promise<void>) | null>(
    null,
  );
  const [conversationTitle, setConversationTitle] = useState<string | null>(
    null,
  );
  const [pendingLeave, setPendingLeave] = useState<PendingLeave | null>(null);
  const [headerNotice, setHeaderNotice] = useState("");
  const drafts = useRef(new DraftShelf()).current;
  const [persona, setPersona] = useState<PersonaRecord | null>(null);
  const [sourceMessageId, setSourceMessageId] = useState<string | undefined>();
  const [registration, setRegistration] = useState<
    ChatProviderRegistration | undefined
  >();
  const [capabilities, setCapabilities] = useState<CapabilityMap>({});
  const [appearance, setAppearance] = useState<ChatAppearance>({});
  const [contextPolicy, setContextPolicy] = useState<ContextPolicy>("roll");
  const [contextProgress, setContextProgress] = useState("");
  const activeRun = useRef<{ runId: string; stop(): Promise<void> } | null>(
    null,
  );
  const runSettled = useRef<Promise<void> | null>(null);
  const sendPending = useRef(false);
  const navigationPending = useRef(false);
  const pendingSettingsWrites = useRef(Promise.resolve());
  const trackSettingsWrites = useCallback((completion: Promise<void>) => {
    pendingSettingsWrites.current = completion;
  }, []);
  const screenMounted = useRef(true);
  const foregroundAdmission = useRef(
    new ForegroundRunAdmission(
      () => screenMounted.current && AppState.currentState === "active",
    ),
  ).current;
  const liveRuntime = useRef<ChatRuntime | null>(null);
  const lastPayload = useRef<ComposerSendPayload | null>(null);
  const lastUserMessageId = useRef<string | undefined>(undefined);
  const providerCache = useRef(new Map<string, ProviderPort>());
  const workspaceFiles = useMemo(
    () =>
      runtime
        ? new SQLiteWorkspaceFiles(runtime.db, runtime.conversationId)
        : undefined,
    [runtime?.db, runtime?.conversationId],
  );
  const selectedContextKey = registration
    ? modelContextKey(registration)
    : null;
  const currentContextKey = useRef(selectedContextKey);
  currentContextKey.current = selectedContextKey;
  const activeServerContext =
    serverContext?.key === selectedContextKey ? serverContext : undefined;

  useEffect(() => {
    if (!runtime || !registration || !supportsContextDiscovery(registration)) {
      setServerContext(null);
      return;
    }
    const key = modelContextKey(registration);
    const controller = new AbortController();
    setServerContext((previous) => ({
      key,
      status: "checking",
      ...(previous?.key === key && previous.tokens
        ? { tokens: previous.tokens }
        : {}),
    }));
    void discoverRegisteredModelContext(
      registration,
      { fetch: providerFetch as FetchLike, secrets: runtime.secrets },
      controller.signal,
    ).then((detected) => {
      if (controller.signal.aborted || currentContextKey.current !== key)
        return;
      setServerContext({
        key,
        status: detected ? "available" : "unavailable",
        ...(detected
          ? {
              tokens: detected.contextWindowTokens,
              ...(detected.toolsSupported
                ? { toolsSupported: true as const }
                : {}),
            }
          : {}),
      });
    });
    return () => controller.abort();
  }, [runtime, selectedContextKey]);

  useEffect(() => {
    setClipboardResult(null);
    setAttachmentNotice("");
  }, [runtime?.conversationId]);

  useEffect(() => {
    screenMounted.current = true;
    let mounted = true;
    let closed = false;
    let generationSession: GenerationSession | undefined;
    const close = async () => {
      if (closed) return;
      closed = true;
      try {
        await activeRun.current?.stop();
        await mobileSpeech.stop();
        await runSettled.current;
        await liveRuntime.current?.identities.memoryExtraction.dispose();
        liveRuntime.current?.intake.dispose?.();
      } finally {
        await generationSession?.dispose();
      }
    };
    setError("");
    void openMobileDatabase()
      .then(async (database) => {
        if (!mounted) return;
        generationSession = await createGenerationSession();
        const onboarding = await new SQLiteOnboardingRepository(database).get();
        if (mounted) setSetupStyle(onboarding.mode);
        const history = await initializeFirstRunChat(database);
        const toolInvocations = new SQLiteToolInvocationStore(
          database,
          "00000000-0000-7000-8000-000000000076",
        );
        await toolInvocations.initialize();
        const conversation = await allocateChatConversation(
          history,
          "local",
          createChatId,
        );
        const activeConversationId =
          (await readActiveChat(database)) ?? conversation.conversation.id;
        await saveActiveChat(database, activeConversationId);
        await new SQLiteWorkspaceFiles(
          database,
          activeConversationId,
        ).initialize();
        const fallback = await readFallbackChatSelection(
          database,
          activeConversationId,
        );
        if (mounted && fallback) setMode(fallback.mode);
        const connectionId = "00000000-0000-7000-8000-000000000158";
        const secretStore = createNativeMobileSecretStore();
        const setup = new SQLiteOpenAIEndpointSetupRepository(database);
        const blobs = await openMobileBlobStore(database);
        await blobs.recoverImports();
        const composition = await initializeMobileChatComposition(database);
        const identities = await initializePersonaMemoryChat(
          database,
          createChatId,
        );
        const intake = await createMobileChatAttachmentIntake({
          db: database,
          blobs,
          createId: createChatId,
        });
        // Finish file cleanup for chats deleted before the app last closed.
        void runConversationCleanups(
          database,
          conversationCleanupPorts(intake, blobs),
        ).catch((cause) => {
          if (mounted)
            setError(
              describeError(cause, {
                operation: "Clean up unused chat files",
                recovery:
                  "Your saved chats remain available. Reopen LocalLab to retry cleaning unused files.",
              }),
            );
        });
        const lifecycle = new SQLiteGenerationLifecycle(database);
        await lifecycle.initialize();
        const features = createSQLiteChatFeatureBindings({
          db: database,
          attachments: intake.attachments,
          lifecycle,
        });
        const registry = await openConnectionCatalog(database);
        const webSettings = new SQLiteWebResearchSettings(database);
        await database.execAsync(
          "CREATE TABLE IF NOT EXISTS phone_model_choice_local (singleton INTEGER PRIMARY KEY CHECK(singleton=1), provider_id TEXT NOT NULL)",
        );
        if (!(await registry.selected(activeConversationId))) {
          const phoneChoice = await database.getFirstAsync<{
            provider_id: string;
          }>(
            "SELECT provider_id FROM phone_model_choice_local WHERE singleton=1",
          );
          if (phoneChoice && (await registry.get(phoneChoice.provider_id)))
            await registry.select(
              activeConversationId,
              phoneChoice.provider_id,
            );
        }
        const recovery = await recoverInterruptedChatRuns(
          database,
          generationSession,
        );
        if (!mounted) {
          await identities.memoryExtraction.dispose();
          intake.dispose?.();
          await generationSession.dispose();
          await close();
          return;
        }
        setRuntime({
          generationSession,
          db: database,
          history,
          engine: new AdvancedChatEngine({
            db: database,
            createId: createChatId,
            generationOwner: generationSession.owner,
            context: {
              tokenBudget: 4096,
              reservedOutputTokens: 512,
              policy: "roll",
            },
          }),
          blobs,
          connectionId: fallback?.connectionId ?? connectionId,
          fallbackModelId: fallback?.modelId ?? null,
          conversationId: activeConversationId,
          secrets: secretStore,
          setup,
          composition,
          intake,
          lifecycle,
          features,
          registry,
          webSettings,
          preferences: new SQLiteComposerPreferenceStore(database),
          toolInvocations,
          identities,
        });
        if (
          recovery.recovered.some(
            (run) => run.conversationId === activeConversationId,
          )
        )
          setError(
            "A response was interrupted when the app closed. Its saved text remains in this chat.",
          );
      })
      .catch(async (cause: unknown) => {
        await close().catch((cleanupCause) => {
          traceLog.event("Clean up failed chat startup", "failed", {
            errorName:
              cleanupCause instanceof Error ? cleanupCause.name : "Error",
          });
        });
        if (mounted)
          setError(
            describeError(cause, {
              operation: "Open chat storage",
              recovery: chatStartupError(cause, Platform.OS),
            }),
          );
      });
    return () => {
      mounted = false;
      screenMounted.current = false;
      foregroundAdmission.suspend();
      void close().catch((cause) => {
        traceLog.event("Close chat runtime", "failed", {
          errorName: cause instanceof Error ? cause.name : "Error",
        });
      });
      for (const port of providerCache.current.values())
        void Promise.resolve()
          .then(() => port.dispose?.())
          .catch((cause) => {
            traceLog.event("Close model connection", "failed", {
              errorName: cause instanceof Error ? cause.name : "Error",
            });
          });
    };
  }, [openAttempt]);

  useEffect(() => {
    liveRuntime.current = runtime;
  }, [runtime]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") return;
      void mobileSpeech.stop().catch((cause) => {
        traceLog.event("Suspend voice playback", "failed", {
          errorName: cause instanceof Error ? cause.name : "Error",
        });
      });
      foregroundAdmission.suspend();
      const currentRuntime = liveRuntime.current;
      if (!currentRuntime) return;
      void currentRuntime.identities.memoryExtraction
        .cancelPending({ waitForResources: false })
        .catch((cause) => {
          traceLog.event("Suspend memory extraction", "failed", {
            errorName: cause instanceof Error ? cause.name : "Error",
          });
        });
      const active = activeRun.current;
      if (active) {
        void active.stop().catch((cause) => {
          traceLog.event("Suspend response", "failed", {
            errorName: cause instanceof Error ? cause.name : "Error",
          });
        });
        void currentRuntime.lifecycle.suspend(active.runId).catch((cause) => {
          traceLog.event("Save suspended response", "failed", {
            errorName: cause instanceof Error ? cause.name : "Error",
          });
          void active.stop().catch((stopCause) => {
            traceLog.event("Stop suspended response", "failed", {
              errorName: stopCause instanceof Error ? stopCause.name : "Error",
            });
          });
        });
      }
    });
    return () => subscription.remove();
  }, []);

  const loadModels = useCallback(async () => {
    if (!runtime) return;
    try {
      const installed = await listInstalledModels();
      const available = (await runtime.blobs.list())
        .filter((blob) => /gguf/i.test(blob.mimeType))
        .map((blob) => ({
          id: blob.id,
          label:
            installed.find((model) => model.blobId === blob.id)?.name ??
            `GGUF  -  ${formatBytes(blob.byteLength)}`,
          sha256: blob.sha256,
        }));
      setModels(available);
      const saved = await runtime.db.getFirstAsync<{ model_id: string }>(
        "SELECT model_id FROM first_run_chat_settings WHERE mode='local'",
      );
      const savedBlobId = managedBlobIdFromModelId(saved?.model_id);
      setSelectedModel((current) =>
        available.some((model) => model.id === current)
          ? current
          : available.some((model) => model.id === savedBlobId)
            ? savedBlobId
            : (available[0]?.id ?? ""),
      );
    } catch (cause) {
      setError(
        describeError(cause, {
          operation: "Read installed models",
          recovery:
            "Open Models and retry. Your saved conversations remain available.",
        }),
      );
    }
  }, [runtime]);

  const loadTranscript = useCallback(async () => {
    if (!runtime) return;
    try {
      const transcript = await readTranscript(
        runtime.db,
        runtime.engine,
        runtime.conversationId,
      );
      setUsers(transcript.users);
      setAssistants(transcript.assistants);
    } catch (cause) {
      setError(
        describeError(cause, {
          operation: "Reopen conversation",
          recovery:
            "Choose the chat again in Recent chats. Your saved data was not changed.",
        }),
      );
    }
  }, [runtime]);

  useEffect(() => {
    void loadModels();
    void loadTranscript();
    if (runtime)
      void Promise.all([
        runtime.registry.selected(runtime.conversationId).then(setRegistration),
        runtime.identities.personas
          .selected(runtime.conversationId)
          .then(setPersona),
        runtime.composition
          .settingsForConversation(runtime.conversationId)
          .loadAppearance(runtime.conversationId)
          .then(setAppearance),
        runtime.composition
          .settingsForConversation(runtime.conversationId)
          .loadContextPolicy()
          .then(setContextPolicy),
      ]).catch((cause) =>
        setError(
          describeError(cause, {
            operation: "Load saved chat settings",
            recovery: "Reopen Settings and retry before sending.",
          }),
        ),
      );
    if (runtime)
      void runtime.setup
        .get(runtime.connectionId)
        .then((saved) => {
          setConfigured(!!saved);
          setConfiguredModel(saved?.modelId ?? "");
        })
        .catch((cause) =>
          setError(
            describeError(cause, {
              operation: "Load saved endpoint",
              recovery:
                "Open Connections to review or save the endpoint again.",
            }),
          ),
        );
  }, [loadModels, loadTranscript, runtime]);

  useEffect(() => {
    if (!runtime) return;
    let live = true;
    void runtime.history
      .getConversation(runtime.conversationId)
      .then((conversation) => {
        if (live) setConversationTitle(conversation?.title?.trim() || null);
      })
      .catch((cause) => {
        if (live)
          setError(
            describeError(cause, {
              operation: "Load chat title",
              recovery:
                "Reopen this conversation from Recent chats. Its saved messages remain available.",
            }),
          );
      });
    return () => {
      live = false;
    };
  }, [runtime, users.length, assistants.length]);

  useFocusEffect(
    useCallback(() => {
      if (runtime) {
        void loadModels();
        void runtime.registry
          .selected(runtime.conversationId)
          .then(setRegistration)
          .catch((cause) =>
            setError(
              describeError(cause, {
                operation: "Reopen selected connection",
                recovery:
                  "Open Connections, choose the saved connection, and retry.",
              }),
            ),
          );
      }
      return undefined;
    }, [loadModels, runtime]),
  );

  useEffect(() => {
    if (!runtime) return;
    let live = true;
    void (async () => {
      let caps: CapabilityMap = { streaming: "yes" };
      if (registration) {
        const toolsEnabled = activeServerContext?.toolsSupported === true;
        const ninferThinkingControl =
          activeServerContext?.toolsSupported === true;
        const cacheKey = JSON.stringify([
          registration,
          toolsEnabled,
          ninferThinkingControl,
        ]);
        const port =
          providerCache.current.get(cacheKey) ??
          createRegisteredChatProvider(registration, {
            toolsEnabled,
            ninferThinkingControl,
            fetch: providerFetch as FetchLike,
            secrets: runtime.secrets,
            nativePort: (value) =>
              value.kind === "local-gguf"
                ? createLocalChatPort(runtime.blobs)
                : undefined,
          });
        providerCache.current.set(cacheKey, port);
        caps = await selectedCapabilities(port, registration.modelId);
      } else if (mode === "openai") {
        const saved = await runtime.setup.get(runtime.connectionId);
        if (saved)
          caps = await selectedCapabilities(
            createOpenAIResponsesProvider({
              fetch: providerFetch as FetchLike,
              secrets: runtime.secrets,
              resolveConnection: (id) =>
                resolveOpenAIEndpointConnection(runtime.setup, id),
            }),
            runtime.fallbackModelId ?? saved.modelId,
          );
        else caps = {};
      }
      if (live)
        setCapabilities({
          ...caps,
          "chat.systemPrompt": "yes",
          "parameter.contextWindow": "yes",
        });
    })().catch((cause) => {
      if (live) {
        setError(
          describeError(cause, {
            operation: "Read model capabilities",
            recovery:
              "Check the selected model in Connections. Basic controls remain available.",
          }),
        );
        setCapabilities({
          "chat.systemPrompt": "yes",
          "parameter.contextWindow": "yes",
        });
      }
    });
    return () => {
      live = false;
    };
  }, [
    runtime,
    registration,
    mode,
    selectedModel,
    activeServerContext?.toolsSupported,
  ]);

  const selectMode = async (next: FirstRunMode) => {
    if (sendPending.current || activeRun.current) return;
    sendPending.current = true;
    setWorking(true);
    try {
      await runtime?.identities.memoryExtraction.cancelPending();
      setMode(next);
      setError("");
      setShowSetup(false);
      lastPayload.current = null;
      lastUserMessageId.current = undefined;
      if (!runtime) return;
      const conversation = await allocateChatConversation(
        runtime.history,
        next,
        createChatId,
      );
      await runtime.registry.clearSelection(conversation.conversation.id);
      await saveActiveChat(runtime.db, conversation.conversation.id);
      setRegistration(undefined);
      setRuntime((current) =>
        current
          ? {
              ...current,
              conversationId: conversation.conversation.id,
              fallbackModelId: null,
            }
          : current,
      );
      const settings = await runtime.db.getFirstAsync<{ model_id: string }>(
        "SELECT model_id FROM first_run_chat_settings WHERE mode=?",
        next,
      );
      if (next === "local")
        setSelectedModel(managedBlobIdFromModelId(settings?.model_id));
      const transcript = await readTranscript(
        runtime.db,
        runtime.engine,
        conversation.conversation.id,
      );
      setUsers(transcript.users);
      setAssistants(transcript.assistants);
    } finally {
      sendPending.current = false;
      setWorking(false);
    }
  };

  const send = useCallback(
    async (
      payload: ComposerSendPayload,
      retryUserMessageId?: string,
      requestedPolicy?: ContextPolicy,
    ) => {
      if (!runtime) throw new Error("Chat is still starting.");
      if (sendPending.current || activeRun.current)
        throw new Error(
          "Stop the current response before sending another message.",
        );
      const admission = foregroundAdmission.begin();
      sendPending.current = true;
      setAttachmentNotice("");
      setWorking(true);
      let finishRun!: () => void;
      runSettled.current = new Promise<void>((resolve) => {
        finishRun = resolve;
      });
      try {
        await pendingSettingsWrites.current;
        runtime.generationSession.assertActive();
        await runtime.identities.memoryExtraction.cancelPending();
        admission.assertActive();
        const identity = await runtime.identities.personas.snapshotForNextRun(
          runtime.conversationId,
        );
        const memoryPolicy = personaMemoryPolicy(
          identity,
          await runtime.identities.memory.preferences(),
        );
        const memoryPrompt =
          await runtime.identities.memory.promptContext(memoryPolicy);
        const text = payload.text;
        setError("");
        let modelId: string;
        let modelRecordId: string;
        let providerId: string;
        let connectionId: string;
        let port: ProviderPort<any>;
        const selected = await runtime.registry.selected(
          runtime.conversationId,
        );
        // Refresh each send: the same model can be restarted with a different limit.
        const detectedContext = selected
          ? await discoverRegisteredModelContext(selected, {
              fetch: providerFetch as FetchLike,
              secrets: runtime.secrets,
            })
          : undefined;
        if (
          selected &&
          supportsContextDiscovery(selected) &&
          screenMounted.current &&
          currentContextKey.current === modelContextKey(selected)
        ) {
          setServerContext({
            key: modelContextKey(selected),
            status: detectedContext ? "available" : "unavailable",
            ...(detectedContext
              ? {
                  tokens: detectedContext.contextWindowTokens,
                  ...(detectedContext.toolsSupported
                    ? { toolsSupported: true as const }
                    : {}),
                }
              : {}),
          });
        }
        const fileIntent =
          workspaceFileIntent(text) ??
          (payload.toolIds.includes(WORKSPACE_FILES_TOOL)
            ? { path: "notes.md" }
            : undefined);
        const wantsFiles =
          !!fileIntent ||
          requestsWorkspaceTools(text) ||
          payload.toolIds.includes(WORKSPACE_FILES_TOOL);
        const toolsEnabled =
          detectedContext?.toolsSupported === true && wantsFiles;
        const fileStore = workspaceFiles!;
        const existingFile = fileIntent
          ? await fileStore.read(validateWorkspacePath(fileIntent.path))
          : undefined;
        const webPlan = resolveWebResearchIntent({
          text,
          searchEnabled: payload.searchEnabled,
          fetchPagesEnabled: payload.toolIds.includes(WEB_FETCH_TOOL),
          previousUserMessages: users.map((message) => message.text),
        });
        if (selected) {
          if (selected.modelId === "model-discovery") {
            setError("Choose a model in Connections before sending.");
            throw new Error("Choose a model in Connections before sending.");
          }
          const refs = [
            ...(selected.credentialRef ? [selected.credentialRef] : []),
            ...(selected.headerRefs ?? []),
          ];
          if (selected.endpoint && refs.length) {
            try {
              await runtime.secrets.resolveHeaders(
                new URL(selected.endpoint).origin,
                refs,
              );
            } catch (cause) {
              const message = describeError(cause, {
                operation: "Read connection credentials",
                recovery:
                  "Open Connections and enter the key again. Your draft is still here.",
              });
              setError(message);
              throw new Error(message);
            }
          }
          modelId = selected.modelId;
          providerId = selected.id;
          connectionId = selected.id;
          const ninferThinkingControl =
            detectedContext?.toolsSupported === true;
          const cacheKey = JSON.stringify([
            selected,
            toolsEnabled,
            ninferThinkingControl,
          ]);
          port =
            providerCache.current.get(cacheKey) ??
            createRegisteredChatProvider(selected, {
              toolsEnabled,
              ninferThinkingControl,
              fetch: providerFetch as FetchLike,
              secrets: runtime.secrets,
              nativePort: (value) =>
                value.kind === "local-gguf"
                  ? createLocalChatPort(runtime.blobs)
                  : undefined,
            });
          providerCache.current.set(cacheKey, port);
          modelRecordId = await ensureModel(
            runtime.db,
            providerId,
            `chat:${selected.id}`,
            modelId,
            selected.kind === "local-gguf" ? "llama.rn" : "remote",
            selected.kind,
          );
        } else if (mode === "local") {
          if (!selectedModel)
            throw new Error(
              "Install a compatible GGUF from Models before starting offline chat.",
            );
          modelId = `blob:${selectedModel}`;
          providerId = "00000000-0000-7000-8000-000000000026";
          connectionId = "00000000-0000-7000-8000-000000000026";
          port = createLocalChatPort(runtime.blobs);
          modelRecordId = await ensureModel(
            runtime.db,
            providerId,
            "local-gguf",
            modelId,
            "llama.rn",
            "gguf",
          );
          await runtime.db.runAsync(
            "INSERT INTO first_run_chat_settings(mode,conversation_id,model_id,model_record_id,connection_id) VALUES(?,?,?,?,?) ON CONFLICT(mode) DO UPDATE SET conversation_id=excluded.conversation_id,model_id=excluded.model_id,model_record_id=excluded.model_record_id,connection_id=excluded.connection_id,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            mode,
            runtime.conversationId,
            modelId,
            modelRecordId,
            connectionId,
          );
        } else {
          const saved = await runtime.setup.get(runtime.connectionId);
          if (!saved) {
            setShowSetup(true);
            throw new Error("Set up your OpenAI endpoint before sending.");
          }
          modelId = runtime.fallbackModelId ?? saved.modelId;
          providerId = "00000000-0000-7000-8000-000000000021";
          connectionId = runtime.connectionId;
          port = createOpenAIResponsesProvider({
            secrets: runtime.secrets,
            resolveConnection: async (id: string) => {
              const connection = await resolveOpenAIEndpointConnection(
                runtime.setup,
                id,
              );
              return { ...connection, modelId };
            },
            fetch: providerFetch as FetchLike,
          });
          modelRecordId = await ensureModel(
            runtime.db,
            providerId,
            "OpenAI Responses",
            modelId,
            "cloud",
            "openai-responses",
          );
          await runtime.db.runAsync(
            "INSERT INTO first_run_chat_settings(mode,conversation_id,model_id,model_record_id,connection_id) VALUES(?,?,?,?,?) ON CONFLICT(mode) DO UPDATE SET conversation_id=excluded.conversation_id,model_id=excluded.model_id,model_record_id=excluded.model_record_id,connection_id=excluded.connection_id,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            mode,
            runtime.conversationId,
            modelId,
            modelRecordId,
            connectionId,
          );
        }
        const binding = createProviderBinding({
          connectionId,
          providerId,
          modelRecordId,
          modelId,
          port,
        });
        port = safeChatProvider(port);
        const providerCapabilities = await selectedCapabilities(port, modelId);
        const appCapabilities = {
          ...providerCapabilities,
          "chat.systemPrompt": "yes" as const,
          "parameter.contextWindow": "yes" as const,
        };
        setCapabilities(appCapabilities);
        const settingsStore = runtime.composition.settingsForConversation(
          runtime.conversationId,
        );
        const presets = await settingsStore.loadPresets({
          modelId,
          personaId: identity.personaId,
        });
        const settings = resolveSettings({
          presets: { ...EMPTY_PRESETS, ...presets },
          personaEnabled: identity.personaId !== DEFAULT_PERSONA_ID,
          capabilities: appCapabilities,
          ...(detectedContext
            ? { serverContextWindow: detectedContext.contextWindowTokens }
            : {}),
        });
        const transport =
          selected?.kind === "openai" || (!selected && mode === "openai")
            ? ("openai-responses" as const)
            : ("text" as const);
        const prepared = await runtime.intake.prepare({
          refs: payload.attachments.map((item) => item.id),
          text,
          capabilities: providerCapabilities,
          transport,
        });
        if (selected?.kind === "gemini" || selected?.kind === "mistral") {
          const upstream = port;
          // This route prepares document text in context; these adapters reserve refs for images.
          port = {
            ...upstream,
            startRun: (request, signal) =>
              upstream.startRun({ ...request, attachmentRefs: [] }, signal),
          };
        }
        const nativeGguf =
          selected?.kind === "local-gguf" || (!selected && mode === "local");
        const webEnabled = webPlan.search || webPlan.fetchPages;
        const fileTools = toolsEnabled ? createWorkspaceTools(fileStore) : [];
        const toolReservation = fileTools.length
          ? conservativeTokenCount([
              {
                id: "workspace-tool-definitions",
                role: "system",
                parts: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      fileTools.map(({ name, description, parameters }) => ({
                        name,
                        description,
                        parameters,
                      })),
                    ),
                  },
                ],
              },
            ]) + 64
          : 0;
        const requestedBudget =
          typeof settings.outbound.contextWindow === "number"
            ? Math.max(
                256,
                Math.min(
                  nativeGguf ? 8192 : 2_000_000,
                  settings.outbound.contextWindow,
                ),
              )
            : 4096;
        const budget = Math.min(
          requestedBudget,
          detectedContext?.contextWindowTokens ?? requestedBudget,
        );
        const webReservation = webEnabled
          ? Math.min(2000, Math.floor(budget / 3))
          : 0;
        const chatBudget = budget - webReservation - toolReservation;
        if (chatBudget < 2)
          throw new ContextBudgetError(
            `Web research and file tools need more room than this ${budget}-token context allows. Increase Context window to match your model or turn these options off. Your draft is preserved.`,
          );
        const reservation =
          typeof settings.outbound.max_output_tokens === "number"
            ? Math.min(
                chatBudget - 1,
                Math.max(1, settings.outbound.max_output_tokens),
              )
            : Math.min(
                settings.outbound.reasoning === true
                  ? 4096
                  : wantsFiles
                    ? 2048
                    : 512,
                chatBudget - 1,
              );
        let documentPort = port;
        if (fileTools.length) {
          const registry = new ToolRegistry();
          for (const tool of fileTools) registry.register(tool);
          documentPort = new ToolLoopEngine({
            registry,
            store: runtime.toolInvocations,
            createId: createChatId,
          }).wrap(port, () => ({
            globalEnabled: true,
            capabilities: providerCapabilities,
            roundLimit: 6,
            maxToolCalls: 12,
            deadlineMs: 300_000,
            maxArgumentBytes: 1_000_000,
            maxResultBytes: 256 * 1024,
            maxContextBytes: 8 * 1024 * 1024,
            maxEventBytes: 1024 * 1024,
            maxTotalEventBytes: 8 * 1024 * 1024,
            tokenBudget: budget,
            reservedOutputTokens: reservation,
          }));
          if (fileIntent)
            documentPort = withVerifiedWorkspaceFileSave(documentPort, {
              path: fileIntent.path,
            });
        } else if (fileIntent) {
          documentPort = withWorkspaceFileOutput(port, {
            store: fileStore,
            path: fileIntent.path,
            ...(existingFile
              ? { expectedRevision: existingFile.revision }
              : {}),
            createId: createChatId,
          });
        } else if (wantsFiles) {
          throw new Error(
            "This model has not reported support for reading or listing workspace files. Open Files to preview them, or select a model with file tool support. You can still ask this model to write a Markdown or text file.",
          );
        }
        const generationPort = withWebResearch(documentPort, {
          client: webEnabled
            ? await createConfiguredWebResearchClient({
                settings: runtime.webSettings,
                secrets: runtime.secrets,
                publicFetch: webAccessFetch,
                searchApiFetch: braveSearchFetch,
              })
            : createWebResearchClient(webAccessFetch),
          text,
          search: webPlan.search,
          fetchPages: webPlan.fetchPages,
          ...(webPlan.searchQuery !== undefined
            ? { searchQuery: webPlan.searchQuery }
            : {}),
          maxContextCharacters: Math.max(256, webReservation * 2),
          maxContextBytes: Math.max(0, webReservation * 4 - 64),
          createId: createChatId,
        });
        const engine = new AdvancedChatEngine({
          db: runtime.db,
          createId: createChatId,
          generationOwner: runtime.generationSession.owner,
          context: {
            tokenBudget: chatBudget,
            reservedOutputTokens: reservation,
            policy: requestedPolicy ?? contextPolicy,
          },
          resolveContextParts: async (parts) => {
            return Promise.all(
              parts.map(async (part) => {
                if (typeof part.attachmentId !== "string") return part;
                const item = await runtime.intake.attachments.get(
                  part.attachmentId,
                );
                if (!item)
                  throw new Error("A saved attachment is unavailable.");
                return item.kind === "image"
                  ? {
                      type: "image",
                      attachmentId: item.id,
                      byteLength: item.byteLength,
                    }
                  : {
                      type: "text",
                      attachmentId: item.id,
                      text: `[Attachment: ${item.name}]\n${item.extractedText?.slice(0, 64_000) ?? ""}`,
                    };
              }),
            );
          },
          resolveProviderContext: async (message) => {
            const refs = message.parts.flatMap((part) =>
              typeof part.attachmentId === "string" ? [part.attachmentId] : [],
            );
            const text = message.parts
              .filter((part) => part.type === "text" && !part.attachmentId)
              .map((part) => part.text ?? "")
              .join("\n");
            if (!refs.length) return [{ kind: message.role, value: text }];
            return (
              await runtime.intake.prepare({
                refs,
                text,
                capabilities: providerCapabilities,
                transport,
              })
            ).providerContext;
          },
        });
        const integration = createMobileChatIntegration(
          retryUserMessageId
            ? {
                send: (input) =>
                  engine.regenerate({
                    ...input,
                    userMessageId: retryUserMessageId,
                  }),
              }
            : engine,
          runtime.features,
        );
        const handle = await admission.admit(() =>
          integration.send({
            conversationId: runtime.conversationId,
            text,
            binding: { ...binding, port: generationPort },
            parameters: {
              ...settings.outbound,
              max_output_tokens: reservation,
              ...(nativeGguf
                ? { contextWindow: budget, max_output_tokens: reservation }
                : {}),
            },
            userParts: prepared.userParts,
            attachmentRefs: prepared.attachmentRefs,
            ...(fileTools.length
              ? { permittedTools: fileTools.map((tool) => tool.name) }
              : {}),
            contextParts: prepared.contextParts,
            pendingContext: prepared.providerContext,
            systemPrompt: [
              personaSystemPrompt(
                identity,
                settings.outbound.systemPrompt,
                memoryPrompt?.value,
              ),
              fileIntent
                ? workspaceDocumentInstruction(fileIntent, toolsEnabled)
                : fileTools.length
                  ? "Files are saved in this chat workspace. Use workspace_list_files, workspace_read_file and workspace_write_file for file requests. Read the current revision before updating an existing file. Only say a file is saved after a successful write result."
                  : undefined,
              fileIntent && existingFile && !toolsEnabled
                ? `Existing file ${JSON.stringify(existingFile.path)} (revision ${existingFile.revision}) to update:\n${existingFile.content}`
                : undefined,
            ]
              .filter(Boolean)
              .join("\n\n"),
            reasoning: settings.outbound.reasoning === true,
            json: settings.outbound.json_mode === true,
          }),
        );
        lastPayload.current = payload;
        lastUserMessageId.current = handle.userMessageId;
        setAttachmentNotice(
          prepared.truncatedAttachmentIds.length
            ? "Attachment text was shortened to fit this message. Original files remain saved."
            : "",
        );
        setSourceMessageId(undefined);
        activeRun.current = handle;
        if (!screenMounted.current || AppState.currentState !== "active")
          await handle.stop();
        setActiveStop(() => () => handle.stop());
        try {
          const captured = await runtime.identities.personas.captureRun(
            runtime.conversationId,
            handle.runId,
            identity,
          );
          if (captured.photoAttachmentId) {
            await runtime.intake.attachments.retain(
              `persona-run:${handle.runId}`,
              captured.photoAttachmentId,
            );
          }
          await runtime.features.beginRun(
            handle,
            runtime.conversationId,
            selected?.kind === "local-gguf" || (!selected && mode === "local")
              ? "local"
              : "remote",
          );
          const title = payload.text.trim().replace(/\s+/g, " ").slice(0, 60);
          if (title) {
            await runtime.db.runAsync(
              "UPDATE conversations SET title=? WHERE id=? AND (title IS NULL OR title IN ('Offline chat','OpenAI chat'))",
              title,
              runtime.conversationId,
            );
          }
          for (const ref of prepared.attachmentRefs) {
            await runtime.intake.attachments.retain(
              `message:${handle.userMessageId}`,
              ref,
            );
            await runtime.intake.attachments.release(
              `draft:${runtime.conversationId}`,
              ref,
            );
          }
          setContextProgress(
            `${handle.contextUsage.inputTokens} / ${handle.contextUsage.tokenBudget} input tokens  -  ${handle.contextUsage.omittedMessageIds.length} messages omitted`,
          );
          let runFailed = false;
          for await (const event of handle.events) {
            if (event.type === "RunFailed") runFailed = true;
            if (event.type === "RunStarted")
              traceLog.event("Generate response", "start");
            if (event.type === "RunCompleted")
              traceLog.event("Generate response", "complete");
            if (event.type === "RunCanceled")
              traceLog.event("Generate response", "cancelled");
            if (event.type === "RunFailed")
              setError(
                describeError(chatFailureCause(event.error), {
                  operation: "Generate response",
                  recovery:
                    "Check the model and connection, then retry your saved message.",
                }),
              );
            const transcript = await readTranscript(
              runtime.db,
              runtime.engine,
              runtime.conversationId,
            );
            setUsers(transcript.users);
            setAssistants(transcript.assistants);
          }
          if (runFailed) return false;
          if (
            memoryPolicy.extract &&
            screenMounted.current &&
            AppState.currentState === "active"
          ) {
            const extractor = new ProviderMemoryExtractor({
              port,
              providerConnectionId: connectionId,
              modelId,
              createId: createChatId,
              modelSystemPrompt: memoryModelControlPrompt(
                settings.outbound.systemPrompt,
              ),
              json: providerCapabilities.structuredOutput === "yes",
            });
            void runtime.identities.memoryExtraction
              .enqueueCompleted({
                runId: handle.runId,
                userMessageId: handle.userMessageId,
                conversationId: runtime.conversationId,
                policy: memoryPolicy,
                extractor,
                isStillAllowed: async (transaction) =>
                  (await runtime.identities.memory.preferences(transaction))
                    .extractionEnabled,
              })
              .then((result) => {
                if (screenMounted.current && result.status === "failed")
                  setError(
                    "The reply is saved, but memory extraction failed. You can add a fact in Memory.",
                  );
              })
              .catch((cause) => {
                if (screenMounted.current)
                  setError(
                    describeError(cause, {
                      operation: "Update memory from reply",
                      recovery:
                        "Your reply is saved. Open Memory to add a fact manually or turn automatic memory off.",
                    }),
                  );
              });
          }
        } catch (cause) {
          await handle.stop();
          try {
            // Setup can fail before iteration; deliver the durable cancellation to feature hooks.
            for await (const _event of handle.events) {
              /* settle cancellation */
            }
          } catch (settleCause) {
            // Preserve the original recoverable error after the engine has settled the run.
            traceLog.event("Settle failed response", "failed", {
              errorName:
                settleCause instanceof Error ? settleCause.name : "Error",
            });
          }
          throw toRecoverableChatError(cause);
        } finally {
          activeRun.current = null;
          setActiveStop(null);
          await loadTranscript();
        }
      } finally {
        sendPending.current = false;
        setWorking(false);
        finishRun();
        runSettled.current = null;
      }
    },
    [
      contextPolicy,
      loadTranscript,
      mode,
      runtime,
      selectedModel,
      users,
      workspaceFiles,
    ],
  );

  const openConversation = async (
    conversationId: string,
    focusMessageId?: string,
    options: { keepPanel?: boolean } = {},
  ) => {
    if (!runtime) return;
    if (sendPending.current || activeRun.current)
      throw new Error(
        "Stop the current response before opening another conversation.",
      );
    if (!(await runtime.history.getConversation(conversationId)))
      throw new Error("Conversation is unavailable.");
    const leftDraft =
      conversationId !== runtime.conversationId &&
      drafts.has(runtime.conversationId);
    await runtime.identities.memoryExtraction.cancelPending();
    await saveActiveChat(runtime.db, conversationId);
    const selected = await runtime.registry.selected(conversationId);
    const fallback = selected
      ? undefined
      : await readFallbackChatSelection(runtime.db, conversationId);
    setRegistration(selected);
    if (fallback) {
      setMode(fallback.mode);
      if (fallback.mode === "local")
        setSelectedModel(managedBlobIdFromModelId(fallback.modelId));
    }
    setRuntime({
      ...runtime,
      conversationId,
      fallbackModelId: fallback?.modelId ?? null,
      connectionId: fallback?.connectionId ?? runtime.connectionId,
    });
    lastPayload.current = null;
    lastUserMessageId.current = undefined;
    setContextProgress("");
    if (!options.keepPanel) setPanel(null);
    setShowSetup(false);
    setError("");
    setSourceMessageId(focusMessageId);
    setPendingLeave(null);
    if (leftDraft) {
      const text =
        "Your unsent message is saved in the previous chat. It will be there when you go back.";
      setHeaderNotice(text);
      announce(text);
    } else setHeaderNotice("");
  };

  /** Stops the streaming reply, if any, and waits until the run has fully settled. */
  const stopActiveReply = async () => {
    const settled = runSettled.current;
    await activeRun.current?.stop();
    await settled;
  };

  const replyInProgress = () => !!(sendPending.current || activeRun.current);

  const createNewChat = async () => {
    if (!runtime || navigationPending.current || replyInProgress()) return;
    navigationPending.current = true;
    setWorking(true);
    try {
      const id = createChatId();
      await runtime.history.allocateConversation({
        id,
        allocationKey: `new-chat:${id}`,
        now: new Date().toISOString(),
      });
      if (registration) await runtime.registry.select(id, registration.id);
      await openConversation(id);
    } finally {
      navigationPending.current = false;
      setWorking(false);
    }
  };

  const requestNewChat = () => {
    if (navigationPending.current) return;
    const plan = planNewChat({
      working: replyInProgress(),
      messageCount: users.length + assistants.length,
    });
    if (plan === "confirm-stop") {
      setPendingLeave({ kind: "new" });
      announce(
        "A reply is still being written. Stop it and start a new chat, or keep waiting.",
      );
      return;
    }
    setPanel(null);
    if (plan === "already-new") {
      const text = "This is already a new chat. Type below to start.";
      setHeaderNotice(text);
      announce(text);
      return;
    }
    void createNewChat().catch((cause) =>
      setError(
        describeError(cause, {
          operation: "Create new chat",
          recovery:
            "Retry New chat. Check available device storage if this keeps failing.",
        }),
      ),
    );
  };

  const openFromHistory = (conversationId: string) => {
    if (!runtime) return;
    if (conversationId === runtime.conversationId) {
      setPanel(null);
      return;
    }
    if (replyInProgress()) {
      setPendingLeave({ kind: "open", conversationId });
      announce(
        "A reply is still being written. Stop it and open the other chat, or keep waiting.",
      );
      return;
    }
    void openConversation(conversationId).catch((cause) =>
      setError(
        describeError(cause, {
          operation: "Open saved chat",
          recovery:
            "Choose the chat again in Recent chats. Its saved data was not changed.",
        }),
      ),
    );
  };

  const confirmLeave = async () => {
    const leave = pendingLeave;
    if (!leave) return;
    setPendingLeave(null);
    await stopActiveReply();
    if (leave.kind === "new") await createNewChat();
    else await openConversation(leave.conversationId);
  };

  /** Throws on failure so History can say nothing was removed. */
  const deleteFromHistory = async (conversationId: string) => {
    if (!runtime) return;
    const current = conversationId === runtime.conversationId;
    if (
      pendingLeave?.kind === "open" &&
      pendingLeave.conversationId === conversationId
    )
      setPendingLeave(null);
    let replacement = runtime.conversationId;
    if (current) {
      // Move to a fresh chat first so the screen never shows a deleted conversation.
      await stopActiveReply();
      const id = createChatId();
      await runtime.history.allocateConversation({
        id,
        allocationKey: `new-chat:${id}`,
        now: new Date().toISOString(),
      });
      if (registration) await runtime.registry.select(id, registration.id);
      await openConversation(id, undefined, { keepPanel: true });
      replacement = id;
    }
    await deleteConversation(runtime.db, conversationId, {
      reassignTo: replacement,
    });
    drafts.forget(conversationId);
    void runConversationCleanups(
      runtime.db,
      conversationCleanupPorts(runtime.intake, runtime.blobs),
    ).catch((cause) =>
      setError(
        describeError(cause, {
          operation: "Clean up deleted chat files",
          recovery:
            "The chat was removed. Reopen LocalLab to retry cleaning its unused files.",
        }),
      ),
    );
  };
  const archives = useMemo(
    () =>
      runtime
        ? createNativeMobileArchivePorts({
            createId: createChatId,
            db: runtime.db,
            blobs: runtime.blobs,
            attachments: runtime.intake.attachments,
            selectedConversationId: () => runtime.conversationId,
          })
        : undefined,
    [runtime],
  );
  const avatarPort = useMemo(
    () =>
      runtime
        ? createManagedPersonaAvatarPort({
            pickImage: (ownerId, signal) =>
              runtime.intake.pickImage(ownerId, signal),
            preview: (id) => runtime.intake.preview(id),
            ...(runtime.intake.isManagedPreviewUri
              ? { isManagedPreviewUri: runtime.intake.isManagedPreviewUri }
              : {}),
            release: (id, ownerId) =>
              runtime.intake.attachments.release(ownerId, id),
          })
        : undefined,
    [runtime],
  );
  const handleSettingsChanged = useCallback(
    (kind: "parameters" | "appearance") => {
      if (!runtime || kind !== "appearance") return;
      void runtime.composition
        .settingsForConversation(runtime.conversationId)
        .loadAppearance(runtime.conversationId)
        .then(setAppearance)
        .catch((cause) =>
          setError(
            describeError(cause, {
              operation: "Load chat appearance",
              recovery:
                "Reopen Settings to retry loading your saved appearance.",
            }),
          ),
        );
    },
    [runtime],
  );

  if (error && !runtime)
    return (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          padding: 24,
          gap: 16,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <ErrorNotice message={error} />
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            retryMobileDatabaseOpen(() =>
              setOpenAttempt((attempt) => attempt + 1),
            )
          }
        >
          <Text style={{ color: theme.colors.primary }}>
            Try opening chat again
          </Text>
        </Pressable>
        <Link href="/onboarding" style={{ color: theme.colors.primary }}>
          Return to setup
        </Link>
      </ScrollView>
    );
  if (!runtime)
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <Text>Opening your private chat...</Text>
      </View>
    );

  const chatTitle = panel
    ? chatPageLabels[panel]
    : historyDisplayTitle({ title: conversationTitle });
  const phoneTitle =
    !panel && ["Offline chat", "OpenAI chat"].includes(chatTitle)
      ? "LocalLab"
      : chatTitle;
  return (
    <View
      style={[
        styles.page,
        { backgroundColor: theme.colors.background },
        appearance.background
          ? { backgroundColor: appearance.background }
          : undefined,
      ]}
    >
      <View
        style={[
          styles.header,
          layout.phone && { padding: 0, borderBottomWidth: 1 },
          { backgroundColor: theme.colors.background },
        ]}
      >
        {layout.phone ? (
          <Appbar.Header
            statusBarHeight={0}
            mode="small"
            style={{ backgroundColor: theme.colors.background }}
          >
            {panel ? (
              <Appbar.BackAction
                style={{ width: 44, height: 44, margin: 4 }}
                accessibilityLabel="Return to conversation"
                onPress={() => setPanel(null)}
              />
            ) : (
              <Appbar.Action
                icon="menu"
                style={{ width: 44, height: 44, margin: 4 }}
                accessibilityLabel="Open chat menu"
                onPress={() => {
                  Keyboard.dismiss();
                  setPhoneMenuOpen(true);
                }}
              />
            )}
            <Appbar.Content
              accessibilityValue={{
                text:
                  registration?.label ??
                  (selectedModel
                    ? "On-device model"
                    : configured
                      ? configuredModel
                      : "No model connected"),
              }}
              disabled={working}
              style={{
                minHeight: 44,
                justifyContent: "center",
                paddingHorizontal: 4,
              }}
              {...(!panel
                ? {
                    accessibilityLabel: "Choose chat connection",
                    onPress: () => {
                      Keyboard.dismiss();
                      setPanel("providers");
                    },
                  }
                : {})}
              title={
                <View style={{ minWidth: 0 }}>
                  <Text
                    numberOfLines={1}
                    variant="titleMedium"
                    style={{ fontSize: 18, fontWeight: "600" }}
                    accessibilityRole="header"
                  >
                    {panel ? chatPageLabels[panel] : phoneTitle}
                  </Text>
                  {!panel ? (
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <Text
                        numberOfLines={1}
                        variant="bodySmall"
                        style={{
                          color: theme.colors.onSurfaceVariant,
                          flexShrink: 1,
                        }}
                      >
                        {registration?.label ??
                          (selectedModel
                            ? "On-device model"
                            : configured
                              ? configuredModel
                              : "Choose a model")}
                      </Text>
                      <Icon
                        source="chevron-down"
                        size={16}
                        color={theme.colors.onSurfaceVariant}
                      />
                    </View>
                  ) : null}
                </View>
              }
            />
            {!panel ? (
              <>
                <Appbar.Action
                  icon="history"
                  style={{ width: 44, height: 44, margin: 4 }}
                  accessibilityLabel={
                    panel === "history"
                      ? "Close chat history"
                      : "Open chat history"
                  }
                  onPress={() =>
                    setPanel(panel === "history" ? null : "history")
                  }
                  testID="header-history"
                />
                <Appbar.Action
                  icon="square-edit-outline"
                  style={{ width: 44, height: 44, margin: 4 }}
                  accessibilityLabel="Start a new chat"
                  onPress={requestNewChat}
                  testID="header-new-chat"
                />
              </>
            ) : (
              <Appbar.Action
                icon="menu"
                accessibilityLabel="Open chat menu"
                onPress={() => {
                  Keyboard.dismiss();
                  setPhoneMenuOpen(true);
                }}
              />
            )}
          </Appbar.Header>
        ) : (
          <View style={styles.titleRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                workspace.layout.chatCollapsed
                  ? "Show chat controls"
                  : "Hide chat controls"
              }
              accessibilityState={{ expanded: !workspace.layout.chatCollapsed }}
              onPress={() => {
                void workspace
                  .setLayoutPreferences({
                    chatCollapsed: !workspace.layout.chatCollapsed,
                  })
                  .catch((cause) =>
                    setError(
                      describeError(cause, {
                        operation: "Save chat layout",
                        recovery:
                          "Try changing the layout again. Reopen Settings if this keeps failing.",
                      }),
                    ),
                  );
              }}
              style={{
                minWidth: 44,
                minHeight: 44,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: theme.colors.primary, fontSize: 18 }}>
                {workspace.layout.chatCollapsed ? "▸" : "▾"}
              </Text>
            </Pressable>
            {appearance.avatar ? (
              <View
                accessible
                accessibilityLabel={`Conversation avatar ${appearance.avatar}`}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: theme.colors.primaryContainer,
                }}
              >
                <Text style={{ color: theme.colors.onPrimaryContainer }}>
                  {appearance.avatar.slice(0, 2).toUpperCase()}
                </Text>
              </View>
            ) : null}
            <Text
              accessibilityRole="header"
              variant="titleMedium"
              numberOfLines={1}
              style={styles.title}
            >
              {panel === "history"
                ? "Chat history"
                : panel
                  ? `${panel[0]!.toUpperCase()}${panel.slice(1)}`
                  : historyDisplayTitle({ title: conversationTitle })}
            </Text>
            <HeaderButton
              glyph="☰"
              label="History"
              accessibilityLabel={
                panel === "history" ? "Close chat history" : "Open chat history"
              }
              selected={panel === "history"}
              onPress={() => setPanel(panel === "history" ? null : "history")}
              testID="header-history"
            />
            <HeaderButton
              glyph="+"
              label="New"
              accessibilityLabel="Start a new chat"
              onPress={requestNewChat}
              testID="header-new-chat"
            />
          </View>
        )}
        {pendingLeave ? (
          <View accessibilityRole="alert" style={styles.headerBar}>
            <Text>
              {working
                ? pendingLeave.kind === "new"
                  ? "A reply is still being written. Stop it and start a new chat?"
                  : "A reply is still being written. Stop it and open the other chat?"
                : "The reply finished."}
            </Text>
            <View style={styles.headerBarActions}>
              <NativeButton
                accessibilityLabel={
                  pendingLeave.kind === "new"
                    ? working
                      ? "Stop reply and start new chat"
                      : "Start new chat"
                    : working
                      ? "Stop reply and open chat"
                      : "Open chat"
                }
                onPress={() =>
                  void confirmLeave().catch((cause) =>
                    setError(
                      describeError(cause, {
                        operation:
                          pendingLeave.kind === "new"
                            ? "Create new conversation"
                            : "Open saved conversation",
                        recovery:
                          "Retry the action. The saved chat remains available in Recent chats.",
                      }),
                    ),
                  )
                }
              >
                {pendingLeave.kind === "new"
                  ? working
                    ? "Stop reply and start new chat"
                    : "Start new chat"
                  : working
                    ? "Stop reply and open chat"
                    : "Open chat"}
              </NativeButton>
              <NativeButton
                accessibilityLabel={working ? "Keep waiting" : "Stay here"}
                mode="text"
                onPress={() => setPendingLeave(null)}
              >
                {working ? "Keep waiting" : "Stay here"}
              </NativeButton>
            </View>
          </View>
        ) : null}
        {headerNotice && !pendingLeave ? (
          <View style={styles.headerBar}>
            <Text style={{ flex: 1 }}>{headerNotice}</Text>
            <NativeButton
              accessibilityLabel="Dismiss message"
              mode="text"
              onPress={() => setHeaderNotice("")}
            >
              OK
            </NativeButton>
          </View>
        ) : null}
        <ChatControlsShell
          phone={layout.phone}
          visible={
            layout.phone ? phoneMenuOpen : !workspace.layout.chatCollapsed
          }
          onClose={() => setPhoneMenuOpen(false)}
        >
          {layout.phone ? (
            <View style={{ gap: 4 }}>
              <List.Item
                title="Connections"
                description={
                  registration
                    ? `${registration.label} · ${registration.modelId}`
                    : "Your PC, OpenRouter, and hosted models"
                }
                descriptionNumberOfLines={2}
                left={(props) => <List.Icon {...props} icon="lan-connect" />}
                right={(props) => <List.Icon {...props} icon="chevron-right" />}
                accessibilityRole="button"
                accessibilityLabel="Connections"
                disabled={working}
                onPress={() => {
                  setPanel("providers");
                  setPhoneMenuOpen(false);
                }}
              />
              <List.Item
                title="Models"
                description="Download a model for your iPhone"
                left={(props) => <List.Icon {...props} icon="cellphone" />}
                accessibilityRole="button"
                accessibilityLabel="Models"
                onPress={() => {
                  setPhoneMenuOpen(false);
                  router.navigate("/models");
                }}
              />
              <List.Item
                title="Voices"
                description="Offline voices and read aloud"
                left={(props) => <List.Icon {...props} icon="volume-high" />}
                accessibilityRole="button"
                accessibilityLabel="Voices"
                disabled={working}
                onPress={() => {
                  setPanel("voices");
                  setPhoneMenuOpen(false);
                }}
              />
              <Divider style={{ marginVertical: 8, marginHorizontal: 16 }} />
              {(
                [
                  "library",
                  "files",
                  "settings",
                  "search",
                  "research",
                  "diagnostics",
                  "archives",
                  "personas",
                  "memory",
                ] as const
              )
                .filter(
                  (value) =>
                    setupStyle === "power" ||
                    showAdvancedTools ||
                    ["library", "files", "settings"].includes(value),
                )
                .map((value) => (
                  <List.Item
                    key={value}
                    title={chatPageLabels[value]}
                    left={(props) => (
                      <List.Icon
                        {...props}
                        icon={
                          (
                            {
                              library: "bookshelf",
                              files: "file-document-outline",
                              settings: "tune",
                              search: "magnify",
                              research: "web",
                              diagnostics: "bug-outline",
                              archives: "archive-outline",
                              personas: "account-outline",
                              memory: "bookmark-outline",
                            } as const
                          )[value]
                        }
                      />
                    )}
                    accessibilityRole="button"
                    accessibilityLabel={chatPageLabels[value]}
                    disabled={working}
                    onPress={() => {
                      setPanel(value);
                      setPhoneMenuOpen(false);
                    }}
                  />
                ))}
              {setupStyle === "beginner" ? (
                <List.Item
                  title={showAdvancedTools ? "Fewer tools" : "More tools"}
                  left={(props) => (
                    <List.Icon
                      {...props}
                      icon={showAdvancedTools ? "chevron-up" : "chevron-down"}
                    />
                  )}
                  accessibilityRole="button"
                  accessibilityLabel={
                    showAdvancedTools ? "Fewer tools" : "More tools"
                  }
                  onPress={() => setShowAdvancedTools((value) => !value)}
                />
              ) : null}
              <Divider style={{ marginVertical: 8, marginHorizontal: 16 }} />
              <View
                style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 12 }}
              >
                <Text variant="labelLarge">Appearance</Text>
                <SegmentedButtons
                  value={workspace.themePreference}
                  onValueChange={(value) =>
                    void workspace
                      .setThemePreference(value as "system" | "light" | "dark")
                      .catch((cause) =>
                        setError(
                          describeError(cause, {
                            operation: "Save app theme",
                            recovery:
                              "Choose the theme again in Settings to retry.",
                          }),
                        ),
                      )
                  }
                  buttons={[
                    {
                      value: "system",
                      label: "System",
                      style: { minHeight: 44 },
                    },
                    {
                      value: "light",
                      label: "Light",
                      style: { minHeight: 44 },
                    },
                    { value: "dark", label: "Dark", style: { minHeight: 44 } },
                  ]}
                />
              </View>
              <List.Accordion
                title="Conversation details"
                theme={{ colors: { background: theme.colors.surface } }}
                left={(props) => (
                  <List.Icon {...props} icon="information-outline" />
                )}
              >
                <View
                  style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 8 }}
                >
                  {persona ? (
                    <Text variant="bodySmall">Persona: {persona.name}</Text>
                  ) : null}
                  {contextProgress ? (
                    <Text variant="bodySmall">{contextProgress}</Text>
                  ) : null}
                  {Platform.OS === "web" ? (
                    <Text variant="bodySmall">
                      Browser keys last for this tab. On-device models run in
                      the iPhone app.
                    </Text>
                  ) : null}
                  {!registration ? (
                    <View
                      style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
                    >
                      <Button
                        mode={mode === "local" ? "contained-tonal" : "text"}
                        disabled={working}
                        onPress={() =>
                          void selectMode("local").catch((cause) =>
                            setError(
                              describeError(cause, {
                                operation: "Open offline chat",
                                recovery:
                                  "Open Models and choose an installed phone model, then retry.",
                              }),
                            ),
                          )
                        }
                      >
                        Offline
                      </Button>
                      <Button
                        mode={mode === "openai" ? "contained-tonal" : "text"}
                        disabled={working}
                        onPress={() =>
                          void selectMode("openai").catch((cause) =>
                            setError(
                              describeError(cause, {
                                operation: "Open OpenAI chat",
                                recovery:
                                  "Check the key and selected model in Connections, then retry.",
                              }),
                            ),
                          )
                        }
                      >
                        OpenAI
                      </Button>
                      {mode === "openai" ? (
                        <Button
                          onPress={() => {
                            setPhoneMenuOpen(false);
                            setShowSetup(true);
                          }}
                        >
                          Edit OpenAI setup
                        </Button>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              </List.Accordion>
            </View>
          ) : (
            <View
              style={[
                styles.headerDetails,
                !layout.phone && layout.keyboardVisible && !panel
                  ? { display: "none" }
                  : undefined,
              ]}
            >
              {Platform.OS === "web" ? (
                <Text variant="bodySmall">
                  {layout.compact
                    ? "Browser preview · Keys stay in this tab"
                    : "Browser preview: provider keys last for this tab. On-device models require the iPhone app."}
                </Text>
              ) : null}
              <ScrollView
                horizontal={!layout.phone}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={[
                  styles.modes,
                  layout.phone && { flexWrap: "wrap" },
                ]}
                style={{ flexGrow: 0 }}
              >
                {(
                  [
                    "library",
                    "settings",
                    "search",
                    "research",
                    "diagnostics",
                    "archives",
                    "providers",
                    "voices",
                    "personas",
                    "memory",
                  ] as const
                )
                  .filter(
                    (value) =>
                      setupStyle === "power" ||
                      showAdvancedTools ||
                      [
                        "library",
                        "files",
                        "settings",
                        "providers",
                        "voices",
                      ].includes(value),
                  )
                  .map((value) =>
                    layout.phone ? (
                      <Button
                        key={value}
                        mode="text"
                        contentStyle={{ minHeight: 44 }}
                        disabled={working}
                        onPress={() => {
                          setPanel(panel === value ? null : value);
                          setPhoneMenuOpen(false);
                        }}
                      >
                        {value[0]!.toUpperCase() + value.slice(1)}
                      </Button>
                    ) : (
                      <Pressable
                        key={value}
                        accessibilityRole="button"
                        disabled={working}
                        onPress={() => setPanel(panel === value ? null : value)}
                      >
                        <Text style={styles.link}>
                          {value[0]!.toUpperCase() + value.slice(1)}
                        </Text>
                      </Pressable>
                    ),
                  )}
                {layout.phone ? (
                  <Button
                    contentStyle={{ minHeight: 44 }}
                    onPress={() => {
                      setPhoneMenuOpen(false);
                      router.navigate("/models");
                    }}
                  >
                    Models
                  </Button>
                ) : (
                  <Link href="/models" style={styles.link}>
                    Models
                  </Link>
                )}
                {setupStyle === "beginner" ? (
                  layout.phone ? (
                    <Button
                      contentStyle={{ minHeight: 44 }}
                      onPress={() => setShowAdvancedTools((value) => !value)}
                    >
                      {showAdvancedTools ? "Fewer tools" : "More tools"}
                    </Button>
                  ) : (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => setShowAdvancedTools((value) => !value)}
                    >
                      <Text style={styles.link}>
                        {showAdvancedTools ? "Fewer tools" : "More tools"}
                      </Text>
                    </Pressable>
                  )
                ) : null}
              </ScrollView>
              {layout.phone ? (
                <View style={{ gap: 8, paddingVertical: 8 }}>
                  <Text variant="labelLarge">Appearance</Text>
                  <SegmentedButtons
                    value={workspace.themePreference}
                    onValueChange={(value) => {
                      void workspace
                        .setThemePreference(
                          value as "system" | "light" | "dark",
                        )
                        .catch((cause) =>
                          setError(
                            describeError(cause, {
                              operation: "Save app theme",
                              recovery:
                                "Choose the theme again in Settings to retry.",
                            }),
                          ),
                        );
                    }}
                    buttons={[
                      { value: "system", label: "System" },
                      { value: "light", label: "Light" },
                      { value: "dark", label: "Dark" },
                    ]}
                  />
                </View>
              ) : null}
              {registration ? (
                <Text>
                  {registration.kind === "local-gguf"
                    ? `On-device · ${registration.label}`
                    : `${registration.label} - ${registration.modelId}`}
                </Text>
              ) : null}
              {persona ? (
                <Text variant="labelSmall">Persona: {persona.name}</Text>
              ) : null}
              {contextProgress ? (
                <Text variant="labelSmall">{contextProgress}</Text>
              ) : null}
              {!panel && !registration ? (
                <View style={styles.modes}>
                  <ModeButton
                    label="Offline"
                    disabled={working}
                    selected={!registration && mode === "local"}
                    onPress={() =>
                      void selectMode("local").catch((cause) =>
                        setError(
                          describeError(cause, {
                            operation: "Open offline chat",
                            recovery:
                              "Choose an installed model in Models, then retry.",
                          }),
                        ),
                      )
                    }
                  />
                  <ModeButton
                    label="OpenAI"
                    disabled={working}
                    selected={!registration && mode === "openai"}
                    onPress={() =>
                      void selectMode("openai").catch((cause) =>
                        setError(
                          describeError(cause, {
                            operation: "Open OpenAI chat",
                            recovery:
                              "Check the key and model in Connections, then retry.",
                          }),
                        ),
                      )
                    }
                  />
                </View>
              ) : null}
              {panel || registration || sourceMessageId ? null : mode ===
                "local" ? (
                <Text variant="bodySmall">
                  {selectedModel
                    ? `On-device  -  ${models.find((model) => model.id === selectedModel)?.label ?? selectedModel.slice(0, 8)}`
                    : "Offline model required"}
                </Text>
              ) : (
                <Text variant="bodySmall">
                  {configured
                    ? Platform.OS === "web"
                      ? "OpenAI Responses  -  key held in this tab"
                      : "OpenAI Responses  -  key stored securely"
                    : "OpenAI endpoint needs setup"}
                </Text>
              )}
              {!panel &&
              !sourceMessageId &&
              !registration &&
              mode === "local" &&
              models.length > 1 ? (
                <View style={styles.modes}>
                  {models.map((model) => (
                    <ModeButton
                      key={model.id}
                      label={model.label}
                      disabled={working}
                      selected={model.id === selectedModel}
                      onPress={() => setSelectedModel(model.id)}
                    />
                  ))}
                </View>
              ) : null}
              {!panel &&
              !sourceMessageId &&
              !registration &&
              mode === "local" &&
              !selectedModel ? (
                <View style={styles.recovery}>
                  <Link href="/models" style={styles.link}>
                    Open Models
                  </Link>
                  <Text variant="bodySmall">
                    Or choose a saved connection in Providers.
                  </Text>
                </View>
              ) : null}
              {!panel &&
              !sourceMessageId &&
              !registration &&
              mode === "local" &&
              selectedModel ? (
                <Text selectable variant="labelSmall">
                  Ready for offline chat.
                </Text>
              ) : null}
              {!sourceMessageId && !registration && mode === "openai" ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={working}
                  onPress={() => setShowSetup((value) => !value)}
                >
                  <Text style={styles.link}>
                    {showSetup
                      ? "Back to chat"
                      : configured
                        ? "Edit OpenAI setup"
                        : "Set up OpenAI"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          )}
        </ChatControlsShell>
      </View>
      {error ? (
        <View style={{ backgroundColor: theme.colors.background }}>
          <View style={{ padding: 12 }}>
            <ErrorNotice message={error} maxTextHeight={160} />
          </View>
          {!panel && /\bcontext-full\b/.test(error) ? (
            <NativeButton
              accessibilityLabel="Adjust context settings"
              onPress={() => setPanel("settings")}
            >
              Open Settings
            </NativeButton>
          ) : !panel && /web|search|Reader|Brave|DuckDuckGo/i.test(error) ? (
            <NativeButton
              accessibilityLabel="Fix web research"
              onPress={() => setPanel("research")}
            >
              Web research settings
            </NativeButton>
          ) : !panel && registration?.endpoint ? (
            <NativeButton
              accessibilityLabel="Fix connection"
              onPress={() => setPanel("providers")}
            >
              Open Connections
            </NativeButton>
          ) : null}
        </View>
      ) : null}
      {clipboardResult ? (
        <View style={{ backgroundColor: theme.colors.background }}>
          <Text
            accessibilityLiveRegion="polite"
            accessibilityRole={clipboardResult.failed ? "alert" : "text"}
            style={clipboardResult.failed ? styles.error : { padding: 12 }}
          >
            {clipboardResult.message}
          </Text>
        </View>
      ) : null}
      {attachmentNotice && !sourceMessageId ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ paddingHorizontal: 12, paddingVertical: 6 }}
        >
          {attachmentNotice}
        </Text>
      ) : null}
      {panel === "files" && workspaceFiles ? (
        <WorkspaceFilesScreen
          store={workspaceFiles}
          files={nativeArchiveFiles}
          zip={mobileArchiveZip}
          refreshKey={assistants.length}
          phoneLayout={layout.phone}
        />
      ) : panel === "research" ? (
        <WebResearchSettingsPanel
          settings={runtime.webSettings}
          secrets={runtime.secrets}
        />
      ) : panel === "voices" ? (
        <SpeechPanel
          {...(!layout.phone ? { onClose: () => setPanel(null) } : {})}
        />
      ) : panel === "providers" ? (
        <ProviderSetupPanel
          registry={runtime.registry}
          secrets={runtime.secrets}
          conversationId={runtime.conversationId}
          onSelected={async (value) => {
            await runtime.identities.memoryExtraction.cancelPending();
            setRegistration(value);
            setShowSetup(false);
            setError("");
          }}
          onClose={() =>
            setPanel((current) => (current === "providers" ? null : current))
          }
        />
      ) : panel === "personas" ? (
        <PersonaScreen
          library={runtime.identities.personas}
          groupUnavailableReason="Group chats are not available in this build."
          createId={createChatId}
          currentConversationId={runtime.conversationId}
          {...(avatarPort ? { avatarPort } : {})}
          {...(!layout.phone ? { onClose: () => setPanel(null) } : {})}
          onProfilesChanged={async () => {
            setPersona(
              await runtime.identities.personas.selected(
                runtime.conversationId,
              ),
            );
          }}
          onSwitch={async () => {
            setPersona(
              await runtime.identities.personas.selected(
                runtime.conversationId,
              ),
            );
            setPanel(null);
          }}
          onLaunchChat={async (intent) => {
            await runtime.history.allocateConversation({
              id: intent.conversationId,
              allocationKey: `persona-chat:${intent.conversationId}`,
              now: new Date().toISOString(),
              title: intent.title,
            });
            await runtime.identities.personas.select(
              intent.conversationId,
              intent.personaId,
            );
            if (registration)
              await runtime.registry.select(
                intent.conversationId,
                registration.id,
              );
            await openConversation(intent.conversationId);
          }}
          onAddToGroup={() => {
            throw new Error("Group chats are not available in this build.");
          }}
        />
      ) : panel === "memory" ? (
        <MemoryScreen
          store={runtime.identities.memory}
          {...(!layout.phone ? { onClose: () => setPanel(null) } : {})}
          onOpenSource={(conversationId, messageId) => {
            void openConversation(conversationId, messageId).catch((cause) =>
              setError(
                describeError(cause, {
                  operation: "Open memory source chat",
                  recovery:
                    "Open the saved conversation from Library. Its messages may have been removed.",
                }),
              ),
            );
          }}
          onPreferencesChanged={(value) => {
            if (!value.extractionEnabled)
              void runtime.identities.memoryExtraction
                .cancelPending({ waitForResources: false })
                .catch((cause) =>
                  setError(
                    describeError(cause, {
                      operation: "Stop automatic memory",
                      recovery:
                        "Turn automatic memory off again in Memory to retry stopping it.",
                    }),
                  ),
                );
          }}
        />
      ) : panel === "diagnostics" ? (
        <DiagnosticsScreen />
      ) : panel === "history" ? (
        <HistoryScreen
          hideBackButton={layout.phone}
          history={runtime.composition.library}
          currentConversationId={runtime.conversationId}
          working={working}
          onOpenConversation={openFromHistory}
          onDeleteConversation={deleteFromHistory}
          onOpenLibrary={() => setPanel("library")}
          onClose={() => setPanel(null)}
        />
      ) : panel === "archives" && archives ? (
        <View style={{ flex: 1, padding: 16, gap: 12 }}>
          <ArchivesScreen
            ports={archives}
            onOpenLibrary={() => setPanel("library")}
          />
          {!layout.phone ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setPanel(null)}
            >
              <Text>Back to chat</Text>
            </Pressable>
          ) : null}
        </View>
      ) : panel && panel !== "archives" && panel !== "files" ? (
        <ChatPanels
          panel={panel}
          hideBackButton={layout.phone}
          db={runtime.db}
          conversationId={runtime.conversationId}
          {...(registration?.modelId ||
          (mode === "local"
            ? selectedModel
            : (runtime.fallbackModelId ?? configuredModel))
            ? {
                modelId:
                  registration?.modelId ??
                  (mode === "local"
                    ? `blob:${selectedModel}`
                    : (runtime.fallbackModelId ?? configuredModel)),
              }
            : {})}
          capabilities={capabilities}
          {...(activeServerContext?.tokens
            ? { serverContextWindow: activeServerContext.tokens }
            : {})}
          {...(activeServerContext
            ? { serverContextStatus: activeServerContext.status }
            : {})}
          {...(persona
            ? {
                personaId: persona.id,
                personaEnabled: persona.id !== DEFAULT_PERSONA_ID,
              }
            : {})}
          createId={createChatId}
          library={runtime.composition.library}
          onOpenConversation={(conversationId, source) =>
            openConversation(conversationId, source?.messageId)
          }
          onClose={() => setPanel(null)}
          contextProgress={contextProgress}
          contextPolicy={contextPolicy}
          refreshKey={assistants.length}
          onSettingsChanged={handleSettingsChanged}
          onPendingSettingsWrites={trackSettingsWrites}
          compactActionLabel={
            lastPayload.current && lastUserMessageId.current
              ? "Compact and retry"
              : "Save context policy"
          }
          summaryUnavailableReason="Summary compaction is not available in this build."
          {...(!lastPayload.current || !lastUserMessageId.current
            ? {
                retryUnavailableReason:
                  "Send a message in this session before retrying its response.",
              }
            : {})}
          onContextReload={() => {
            setContextProgress(
              "Saved context settings will apply to your next message.",
            );
          }}
          onCompact={async (policy) => {
            if (policy === "summarize")
              throw new Error(
                "Summary compaction is not available in this build.",
              );
            await runtime.composition
              .settingsForConversation(runtime.conversationId)
              .saveContextPolicy(policy);
            setContextPolicy(policy);
            setContextProgress(
              "Context packing policy saved for the next message.",
            );
            if (lastPayload.current && lastUserMessageId.current) {
              setPanel(null);
              await send(
                lastPayload.current,
                lastUserMessageId.current,
                policy,
              );
            }
          }}
          onRetry={async () => {
            if (!lastPayload.current || !lastUserMessageId.current) return;
            setPanel(null);
            await send(lastPayload.current, lastUserMessageId.current);
          }}
        />
      ) : !registration && showSetup && mode === "openai" ? (
        <View style={styles.setup}>
          <OpenAIEndpointSetupScreen
            connectionId={runtime.connectionId}
            database={runtime.db}
            secrets={runtime.secrets}
            onSaved={() => {
              setConfigured(true);
              setShowSetup(false);
              setRuntime((current) =>
                current ? { ...current, fallbackModelId: null } : current,
              );
            }}
          />
        </View>
      ) : (
        <>
          <Transcript
            users={users}
            assistants={assistants}
            {...(error && assistants.at(-1)?.status === "failed"
              ? { displayedErrorRunId: assistants.at(-1)!.runId }
              : {})}
            {...(layout.phone
              ? {
                  emptyContent: (
                    <View
                      style={{
                        flex: 1,
                        justifyContent: "center",
                        alignItems: "center",
                        paddingHorizontal: 16,
                        paddingVertical: layout.compact ? 16 : 32,
                        gap: layout.compact ? 12 : 16,
                      }}
                    >
                      <View
                        style={{
                          width: layout.compact ? 48 : 72,
                          height: layout.compact ? 48 : 72,
                          borderRadius: layout.compact ? 16 : 24,
                          backgroundColor: theme.colors.primaryContainer,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Icon
                          source="message-text-outline"
                          size={32}
                          color={theme.colors.onPrimaryContainer}
                        />
                      </View>
                      <Text
                        variant="headlineMedium"
                        accessibilityRole="header"
                        style={{
                          textAlign: "center",
                          fontWeight: "600",
                          ...(layout.compact
                            ? { fontSize: 24, lineHeight: 30 }
                            : {}),
                        }}
                      >
                        {registration ||
                        (mode === "local" ? selectedModel : configured)
                          ? "Where should we start?"
                          : "Make room for a good idea."}
                      </Text>
                      <Text
                        variant="bodyLarge"
                        style={{
                          textAlign: "center",
                          color: theme.colors.onSurfaceVariant,
                          maxWidth: 320,
                          lineHeight: 25,
                          ...(layout.compact
                            ? { fontSize: 15, lineHeight: 22 }
                            : {}),
                        }}
                      >
                        {registration ||
                        (mode === "local" ? selectedModel : configured)
                          ? "Ask a question, work through an idea, or write something together."
                          : "Use your PC, connect an online service, or download a model to your iPhone."}
                      </Text>
                      {!registration &&
                      !(mode === "local" ? selectedModel : configured) ? (
                        <View
                          style={{
                            width: "100%",
                            maxWidth: 320,
                            gap: 8,
                            marginTop: 8,
                          }}
                        >
                          <Button
                            mode="contained"
                            contentStyle={{ minHeight: 48 }}
                            accessibilityLabel="Connect a model"
                            onPress={() => setPanel("providers")}
                          >
                            Connect a model
                          </Button>
                          <Button
                            mode="text"
                            contentStyle={{ minHeight: 44 }}
                            icon="cellphone"
                            onPress={() => router.navigate("/models")}
                          >
                            Browse offline models
                          </Button>
                        </View>
                      ) : null}
                    </View>
                  ),
                }
              : {})}
            onReadAloud={(text) => {
              void mobileSpeech
                .refresh()
                .then(() =>
                  mobileSpeech.speak(
                    text,
                    typeof persona?.profile.speechVoiceId === "string" &&
                      persona.profile.speechVoiceId !== "default"
                      ? persona.profile.speechVoiceId
                      : undefined,
                    typeof persona?.profile.speechRate === "number"
                      ? persona.profile.speechRate
                      : undefined,
                  ),
                )
                .catch((cause: unknown) => {
                  setError(
                    describeError(cause, {
                      operation: "Read response aloud",
                      recovery:
                        "Open Voices and select a fully installed voice, then retry reading aloud.",
                    }),
                  );
                });
            }}
            onCopyMarkdown={(markdown) => {
              setClipboardResult(null);
              void writeClipboardMarkdown(markdown).then(
                () =>
                  setClipboardResult({
                    message: "Markdown copied.",
                    failed: false,
                  }),
                (cause: unknown) =>
                  setClipboardResult({
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "Markdown could not be copied. Try again.",
                    failed: true,
                  }),
              );
            }}
            {...(sourceMessageId ? { focusMessageId: sourceMessageId } : {})}
            {...(activeStop ? { onStop: () => void activeStop() } : {})}
          />
        </>
      )}
      {!panel && speechState.phase === "error" && !error ? (
        <View style={{ padding: 12 }}>
          <ErrorNotice message={speechState.message} maxTextHeight={160} />
        </View>
      ) : null}
      {!panel && !["idle", "error"].includes(speechState.phase) ? (
        <View>
          <Text accessibilityLiveRegion="polite">{speechState.message}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop reading aloud"
            onPress={() => void mobileSpeech.stop()}
          >
            <Text style={styles.link}>Stop reading aloud</Text>
          </Pressable>
        </View>
      ) : null}
      <View
        style={[
          { backgroundColor: theme.colors.background },
          panel || (!registration && showSetup && mode === "openai")
            ? { display: "none" }
            : undefined,
        ]}
      >
        <AdvancedComposer
          {...(layout.phone &&
          !registration &&
          !(mode === "local" ? selectedModel : configured)
            ? { sendUnavailableReason: "Connect a model to send this message." }
            : {})}
          key={runtime.conversationId}
          initialDraft={drafts.get(runtime.conversationId)}
          onDraftChange={(draft) => drafts.put(runtime.conversationId, draft)}
          onSend={send}
          onSendError={setError}
          toolsCollapsed={workspace.layout.composerCollapsed}
          onToolsCollapsedChange={(collapsed) => {
            void workspace
              .setLayoutPreferences({ composerCollapsed: collapsed })
              .catch((cause) =>
                setError(
                  describeError(cause, {
                    operation: "Save composer layout",
                    recovery:
                      "Try the layout option again. It may reset after reopening the app.",
                  }),
                ),
              );
          }}
          starters={[
            {
              id: "explain",
              title: "Explain a concept",
              prompt:
                "Explain a useful programming concept with a short example.",
            },
            {
              id: "code",
              title: "Help with code",
              prompt:
                "Help me write a small function. Ask me what it should do.",
            },
          ]}
          tools={[
            {
              id: WORKSPACE_FILES_TOOL,
              label: "Write files",
              description: "Save Markdown and text in this chat",
            },
            {
              id: WEB_FETCH_TOOL,
              label: layout.phone ? "Read linked pages" : "Fetch pages",
              description: "Include content from links in your message",
            },
          ]}
          onOpenWebSettings={() => setPanel("research")}
          onRemoveAttachment={(item) =>
            runtime.intake.attachments.release(
              `draft:${runtime.conversationId}`,
              item.id,
            )
          }
          isWorking={working}
          {...(activeStop ? { onStop: activeStop } : {})}
          preferences={runtime.preferences}
          onPickAttachment={async () => {
            let item;
            try {
              item = await runtime.intake.pickFile(
                `draft:${runtime.conversationId}`,
              );
            } catch (cause) {
              if (
                cause instanceof ChatAttachmentIntakeError &&
                cause.attachment
              ) {
                item = cause.attachment;
                setError(
                  describeError(cause, {
                    operation: "Prepare attached file",
                    recovery:
                      "The original file is saved. Remove it before sending, or choose another file.",
                  }),
                );
              } else {
                setError(
                  describeError(cause, {
                    operation: "Add attachment",
                    recovery:
                      "Choose the file again. Check that LocalLab can read the file and has enough storage.",
                  }),
                );
                return null;
              }
            }
            if (!item) return null;
            let preview;
            try {
              preview = await runtime.intake.preview(item.id);
            } catch (cause) {
              setError(
                describeError(cause, {
                  operation: "Preview attachment",
                  recovery:
                    "The file is saved. Remove it and choose a supported file if you need a preview.",
                }),
              );
              return null;
            }
            return {
              id: item.id,
              name: item.name,
              uri: preview.uri,
              mediaType: item.mimeType,
              sizeBytes: item.byteLength,
            };
          }}
        />
      </View>
    </View>
  );
}

function ChatControlsShell({
  phone,
  visible,
  onClose,
  children,
}: {
  phone: boolean;
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const theme = useTheme();
  if (!phone) return visible ? <>{children}</> : null;
  return (
    <Portal>
      <Modal
        testID="chat-menu"
        visible={visible}
        onDismiss={onClose}
        overlayAccessibilityLabel="Dismiss chat menu"
        style={{ marginTop: 0, marginBottom: 0, alignItems: "flex-start" }}
        contentContainerStyle={{
          height: "100%",
          width: "88%",
          maxWidth: 380,
          backgroundColor: theme.colors.surface,
          borderTopRightRadius: 28,
          borderBottomRightRadius: 28,
          overflow: "hidden",
        }}
      >
        <SafeAreaView
          testID="phone-navigation-safe-area"
          edges={["top", "bottom", "left", "right"]}
          style={{ flex: 1 }}
        >
          <View
            style={{
              paddingLeft: 24,
              paddingRight: 12,
              paddingVertical: 16,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Text
              variant="titleLarge"
              accessibilityRole="header"
              style={{ flex: 1, fontWeight: "600" }}
            >
              LocalLab
            </Text>
            <IconButton
              icon="close"
              accessibilityLabel="Close chat menu"
              style={{ width: 44, height: 44, margin: 0 }}
              onPress={onClose}
            />
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 24 }}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </Portal>
  );
}

function HeaderButton(props: {
  glyph: string;
  label: string;
  accessibilityLabel: string;
  selected?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const theme = useTheme();
  const styles = useMemo(
    () => createStyles(theme.colors, theme.dark),
    [theme.colors, theme.dark],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      {...(props.selected !== undefined
        ? { accessibilityState: { selected: props.selected } }
        : {})}
      hitSlop={4}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.headerButton,
        (props.selected || pressed) && styles.headerButtonSelected,
      ]}
      {...(props.testID ? { testID: props.testID } : {})}
    >
      <Text importantForAccessibility="no" style={styles.headerButtonGlyph}>
        {props.glyph}
      </Text>
      <Text style={styles.headerButtonText}>{props.label}</Text>
    </Pressable>
  );
}

function ModeButton(props: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(
    () => createStyles(theme.colors, theme.dark),
    [theme.colors, theme.dark],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{
        selected: props.selected,
        disabled: props.disabled ?? false,
      }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.mode, props.selected && styles.modeSelected]}
    >
      <Text style={props.selected ? styles.modeSelectedText : undefined}>
        {props.label}
      </Text>
    </Pressable>
  );
}

async function ensureModel(
  db: SQLiteDatabasePort,
  providerId: string,
  providerName: string,
  modelId: string,
  runtime: string,
  format: string,
) {
  await db.runAsync(
    "INSERT INTO providers(id,kind,name,config_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
    providerId,
    providerName,
    providerName,
    "{}",
    new Date().toISOString(),
  );
  const existing = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM models WHERE provider_id=? AND name=?",
    providerId,
    modelId,
  );
  if (existing) return existing.id;
  const id = createChatId();
  await db.runAsync(
    "INSERT INTO models(id,provider_id,name,runtime,format,capabilities_json,created_at) VALUES(?,?,?,?,?,?,?)",
    id,
    providerId,
    modelId,
    runtime,
    format,
    JSON.stringify({ streaming: true }),
    new Date().toISOString(),
  );
  return id;
}

function formatBytes(bytes: number) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.ceil(bytes / 1024 ** 2)} MB`;
}

function createStyles(colors: MD3Theme["colors"], dark = false) {
  const bevelLight = dark ? "#756880" : "#ffffff";
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.background },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      padding: 24,
    },
    header: {
      paddingTop: 8,
      paddingHorizontal: 16,
      paddingBottom: 8,
      gap: 6,
      borderBottomWidth: 2,
      borderBottomColor: colors.outlineVariant,
    },
    modes: { flexDirection: "row", gap: 8 },
    titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    title: { flex: 1 },
    headerDetails: { gap: 6 },
    headerBar: {
      gap: 6,
      padding: 10,
      borderWidth: 1,
      borderColor: colors.outline,
      backgroundColor: colors.secondaryContainer,
    },
    headerBarActions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    headerButton: {
      minHeight: 44,
      minWidth: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      paddingHorizontal: 10,
      borderWidth: 2,
      borderTopColor: bevelLight,
      borderLeftColor: bevelLight,
      borderRightColor: "#6a6070",
      borderBottomColor: "#6a6070",
      backgroundColor: colors.surface,
    },
    headerButtonSelected: {
      backgroundColor: colors.secondaryContainer,
      borderTopColor: "#6a6070",
      borderLeftColor: "#6a6070",
      borderRightColor: bevelLight,
      borderBottomColor: bevelLight,
    },
    headerButtonGlyph: {
      fontSize: 18,
      fontWeight: "700",
      color: colors.onSurface,
    },
    headerButtonText: { fontWeight: "700", color: colors.onSurface },
    mode: {
      borderRadius: 0,
      borderWidth: 1,
      borderColor: colors.outline,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    modeSelected: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    modeSelectedText: { color: colors.onPrimary, fontWeight: "600" },
    link: {
      color: colors.primary,
      fontWeight: "600",
      fontSize: 12,
      lineHeight: 18,
      minHeight: 44,
      paddingVertical: 12,
      paddingHorizontal: 7,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.outlineVariant,
    },
    setup: { flex: 1 },
    recovery: { gap: 4 },
    error: { color: colors.error, paddingHorizontal: 16, paddingVertical: 6 },
  });
}
