import type { CapabilityMap, ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent } from "@locallab/contracts/run-events";
import { EntityIdSchema } from "@locallab/contracts/identity";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import { createHttpTransport, type FetchLike } from "@locallab/network-http";
import { createOllamaChatProvider } from "@locallab/provider-ollama-chat";
import { createLMStudioAdapter } from "@locallab/provider-lmstudio";
import { createCompatibleLocalProvider } from "@locallab/provider-compatible-local";
import { createOpenAIAdvancedProvider } from "@locallab/provider-openai-advanced";
import { createAnthropicProvider } from "@locallab/provider-anthropic";
import { createGeminiProvider } from "@locallab/provider-gemini";
import { createMistralProvider } from "@locallab/provider-mistral";
import { createCloudCompatibleProvider } from "@locallab/provider-cloud-compatible";
import { toRecoverableChatError } from "@locallab/chat-integration";

export const CHAT_PROVIDER_KINDS = [
  "local-gguf",
  "mlx-ios",
  "mac-gguf",
  "mac-mlx",
  "ollama",
  "lmstudio",
  "jan",
  "omlx",
  "unsloth",
  "compatible",
  "openai",
  "anthropic",
  "gemini",
  "mistral",
  "openrouter",
  "deepseek",
  "zai",
  "vercel-gateway",
  "cloud-compatible",
] as const;
export type ChatProviderKind = (typeof CHAT_PROVIDER_KINDS)[number];

export interface ChatProviderRegistration {
  id: string;
  label: string;
  kind: ChatProviderKind;
  modelId: string;
  endpoint?: string;
  credentialRef?: SecretRef;
  headerRefs?: readonly SecretRef[];
  /** Saving an HTTP endpoint does not itself authorize cleartext LAN traffic. */
  cleartextAuthorized?: boolean;
  allowCrossProviderRouting?: boolean;
  favorite?: boolean;
}

export class SQLiteChatProviderRegistry {
  constructor(private readonly db: SQLiteDatabasePort) {}

  async initialize() {
    await this.db
      .execAsync(`CREATE TABLE IF NOT EXISTS chat_provider_connections (
      id TEXT PRIMARY KEY NOT NULL, registration_json TEXT NOT NULL CHECK(json_valid(registration_json)),
      updated_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS chat_provider_selections (
      conversation_id TEXT PRIMARY KEY NOT NULL, connection_id TEXT NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY(connection_id) REFERENCES chat_provider_connections(id) ON DELETE RESTRICT
    )`);
  }

  async save(input: ChatProviderRegistration) {
    EntityIdSchema.parse(input.id);
    if (
      [input.credentialRef, ...(input.headerRefs ?? [])].some(
        (ref) =>
          ref &&
          !/^sec_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            ref,
          ),
      )
    )
      throw new TypeError("Use an opaque secure-store credential reference.");
    if (
      !input.id.trim() ||
      !input.label.trim() ||
      !input.modelId.trim() ||
      !CHAT_PROVIDER_KINDS.includes(input.kind)
    )
      throw new TypeError("A provider, label and exact model ID are required.");
    if (input.endpoint) checkedUrl(input.endpoint);
    // Project only allowed fields; caller-supplied credentials cannot enter SQLite.
    const registration: ChatProviderRegistration = {
      id: input.id,
      label: input.label,
      kind: input.kind,
      modelId: input.modelId,
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
      ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
      ...(input.headerRefs?.length
        ? { headerRefs: [...input.headerRefs] }
        : {}),
      cleartextAuthorized: input.cleartextAuthorized === true,
      allowCrossProviderRouting: input.allowCrossProviderRouting === true,
      favorite: input.favorite === true,
    };
    await this.db.runAsync(
      "INSERT INTO chat_provider_connections(id,registration_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET registration_json=excluded.registration_json,updated_at=excluded.updated_at",
      input.id,
      JSON.stringify(registration),
      new Date().toISOString(),
    );
  }

  async list(): Promise<ChatProviderRegistration[]> {
    return (
      await this.db.getAllAsync<{ registration_json: string }>(
        "SELECT registration_json FROM chat_provider_connections ORDER BY COALESCE(json_extract(registration_json, '$.favorite'), 0) DESC, updated_at DESC",
      )
    ).map(
      (row) => JSON.parse(row.registration_json) as ChatProviderRegistration,
    );
  }

  async get(id: string): Promise<ChatProviderRegistration | undefined> {
    const row = await this.db.getFirstAsync<{ registration_json: string }>(
      "SELECT registration_json FROM chat_provider_connections WHERE id=?",
      id,
    );
    return row
      ? (JSON.parse(row.registration_json) as ChatProviderRegistration)
      : undefined;
  }

  async select(conversationId: string, connectionId: string) {
    if (!(await this.get(connectionId)))
      throw new Error("Provider connection is unavailable.");
    await this.db.runAsync(
      "INSERT INTO chat_provider_selections(conversation_id,connection_id) VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET connection_id=excluded.connection_id",
      conversationId,
      connectionId,
    );
  }

  async selected(conversationId: string) {
    const row = await this.db.getFirstAsync<{ connection_id: string }>(
      "SELECT connection_id FROM chat_provider_selections WHERE conversation_id=?",
      conversationId,
    );
    return row ? this.get(row.connection_id) : undefined;
  }

  async clearSelection(conversationId: string) {
    await this.db.runAsync(
      "DELETE FROM chat_provider_selections WHERE conversation_id=?",
      conversationId,
    );
  }

  /** Remove a saved connection and its selections; conversation history survives. */
  async remove(id: string, currentConversationId: string): Promise<void> {
    await this.db.withTransactionAsync(async (transaction) => {
      const db = transaction ?? this.db;
      const active = await db.getFirstAsync<{ connection_id: string }>(
        "SELECT connection_id FROM chat_provider_selections WHERE conversation_id=?",
        currentConversationId,
      );
      if (active?.connection_id === id)
        throw new Error(
          "Choose another provider in this chat before removing this one.",
        );
      await db.runAsync(
        "DELETE FROM chat_provider_selections WHERE connection_id=?",
        id,
      );
      await db.runAsync("DELETE FROM chat_provider_connections WHERE id=?", id);
    });
  }
}

export interface ChatProviderFactoryOptions {
  fetch: FetchLike;
  secrets: SecretStore;
  nativePort?: (
    registration: ChatProviderRegistration,
  ) => ProviderPort | undefined;
  resolveMedia?: (id: string) => Promise<{ mimeType: string; base64: string }>;
}

/** Binds each adapter to the saved exact connection; no provider fallback is introduced. */
export function createRegisteredChatProvider(
  registration: ChatProviderRegistration,
  options: ChatProviderFactoryOptions,
): ProviderPort {
  const r = registration;
  if (["local-gguf", "mlx-ios", "mac-gguf", "mac-mlx"].includes(r.kind)) {
    const native = options.nativePort?.(r);
    if (!native)
      throw Object.assign(
        new Error(
          "Selected native runtime is unavailable. Start or install it before retrying.",
        ),
        { code: "host-stopped" },
      );
    return bindSelectedRegistration(native, r);
  }
  const endpoint = checkedUrl(r.endpoint ?? defaultEndpoint(r.kind));
  if (
    ["jan", "omlx", "unsloth", "compatible"].includes(r.kind) &&
    !["/", "/v1", "/v1/"].includes(endpoint.pathname)
  )
    throw new TypeError(
      "Use the compatible server origin or its /v1 API base.",
    );
  const resolve = async (id: string) => {
    if (id !== r.id)
      throw new Error(
        "Provider binding does not match the selected connection.",
      );
  };
  const credential = () => {
    if (!r.credentialRef)
      throw Object.assign(new Error("Saved provider credential is required."), {
        code: "unauthorized",
      });
    return r.credentialRef;
  };
  const transport = createHttpTransport({
    fetch: options.fetch,
    policy: {
      authorizedOrigins: [endpoint.origin],
      cleartextLanOrigins:
        endpoint.protocol === "http:" && r.cleartextAuthorized
          ? [endpoint.origin]
          : [],
    },
  });
  let port: ProviderPort;
  if (r.kind === "ollama") {
    const connection = { baseUrl: endpoint.toString() };
    const resolveOllama = async () => ({
      ...connection,
      ...(r.credentialRef || r.headerRefs?.length
        ? {
            headers: await options.secrets.resolveHeaders(endpoint.origin, [
              ...(r.credentialRef ? [r.credentialRef] : []),
              ...(r.headerRefs ?? []),
            ]),
          }
        : {}),
    });
    const adapter = createOllamaChatProvider({
      transport,
      resolveConnection: async (id) => {
        await resolve(id);
        return resolveOllama();
      },
    });
    port = {
      ...bindConnection(adapter, connection),
      listModels: async (_ignored, signal) =>
        adapter.listModels(await resolveOllama(), signal),
    };
  } else if (
    ["jan", "omlx", "unsloth", "compatible", "lmstudio"].includes(r.kind)
  ) {
    const provider =
      r.kind === "jan" || r.kind === "omlx" || r.kind === "unsloth"
        ? r.kind
        : "custom";
    const connection = {
      provider,
      origin: endpoint.origin,
      ...(r.credentialRef ? { credentialRef: r.credentialRef } : {}),
      ...(r.headerRefs?.length ? { headerRefs: r.headerRefs } : {}),
    } as const;
    const compatible = createCompatibleLocalProvider({
      transport,
      secretStore: options.secrets,
      resolveConnection: async (id) => {
        await resolve(id);
        return connection;
      },
    });
    const bound = bindConnection(compatible, connection);
    if (r.kind !== "lmstudio") port = bound;
    else {
      let native: ReturnType<typeof createLMStudioAdapter> | undefined;
      port = {
        ...bound,
        async *startRun(request, signal) {
          await resolve(request.providerConnectionId);
          if (!native) {
            const headers =
              r.credentialRef || r.headerRefs?.length
                ? await options.secrets.resolveHeaders(endpoint.origin, [
                    ...(r.credentialRef ? [r.credentialRef] : []),
                    ...(r.headerRefs ?? []),
                  ])
                : {};
            native = createLMStudioAdapter({
              baseUrl: endpoint.toString(),
              http: {
                request: (url, init, policy) =>
                  transport.request(
                    url,
                    {
                      ...init,
                      headers: {
                        ...headers,
                        ...Object.fromEntries(new Headers(init?.headers)),
                      },
                    },
                    policy,
                  ),
                streamSse: (url, init, policy) =>
                  transport.streamSse(
                    url,
                    {
                      ...init,
                      headers: {
                        ...headers,
                        ...Object.fromEntries(new Headers(init?.headers)),
                      },
                    },
                    policy,
                  ),
              },
              ...(headers.authorization
                ? { token: headers.authorization.replace(/^Bearer\s+/i, "") }
                : {}),
            });
          }
          yield* native.startRun(request, signal);
        },
        dispose: () => native?.dispose(),
      };
    }
  } else if (r.kind === "openai") {
    const connection = {
      endpointUrl: endpoint.toString(),
      modelId: r.modelId,
      apiKeyRef: credential(),
    };
    port = bindConnection(
      createOpenAIAdvancedProvider({
        fetch: options.fetch,
        secrets: options.secrets,
        resolveConnection: async (id) => {
          await resolve(id);
          return connection;
        },
      }),
      connection,
    );
  } else if (r.kind === "anthropic") {
    const connection = {
      endpointUrl: endpoint.toString(),
      modelId: r.modelId,
      apiKeyRef: credential(),
    };
    port = bindConnection(
      createAnthropicProvider({
        fetch: options.fetch,
        secrets: options.secrets,
        resolveConnection: async (id) => {
          await resolve(id);
          return connection;
        },
      }),
      connection,
    );
  } else if (r.kind === "gemini" || r.kind === "mistral") {
    const connection = {
      endpointOrigin: endpoint.origin,
      modelId: r.modelId,
      apiKeyRef: credential(),
    };
    const providerOptions = {
      fetch: options.fetch,
      secrets: options.secrets,
      resolveConnection: async (id: string) => {
        await resolve(id);
        return connection;
      },
      ...(options.resolveMedia ? { resolveMedia: options.resolveMedia } : {}),
    };
    port =
      r.kind === "gemini"
        ? bindConnection(createGeminiProvider(providerOptions), connection)
        : bindConnection(createMistralProvider(providerOptions), connection);
  } else {
    const provider = r.kind === "cloud-compatible" ? "custom" : r.kind;
    if (
      !["custom", "openrouter", "deepseek", "zai", "vercel-gateway"].includes(
        provider,
      )
    )
      throw new Error("Unknown chat provider.");
    const connection = {
      provider: provider as
        | "custom"
        | "openrouter"
        | "deepseek"
        | "zai"
        | "vercel-gateway",
      endpointOrigin: endpoint.origin,
      modelId: r.modelId,
      apiKeyRef: credential(),
      allowCrossProviderRouting: r.allowCrossProviderRouting === true,
    };
    port = bindConnection(
      createCloudCompatibleProvider({
        fetch: options.fetch,
        secrets: options.secrets,
        resolveConnection: async (id) => {
          await resolve(id);
          return connection;
        },
      }),
      connection,
    );
  }
  return bindSelectedRegistration(port, r);
}

function bindSelectedRegistration(
  port: ProviderPort,
  registration: ChatProviderRegistration,
): ProviderPort {
  return safeChatProvider({
    ...port,
    async *startRun(request, signal) {
      if (
        request.providerConnectionId !== registration.id ||
        request.modelId !== registration.modelId
      )
        throw Object.assign(
          new Error(
            "The request does not match the selected provider and model.",
          ),
          { code: "missing-model" },
        );
      yield* port.startRun(request, signal);
    },
  });
}

function bindConnection<C>(port: ProviderPort<C>, connection: C): ProviderPort {
  return {
    listModels: (_ignored, signal) => port.listModels(connection, signal),
    getCapabilities: (_ignored, modelId, signal) =>
      port.getCapabilities(connection, modelId, signal),
    startRun: (request, signal) => port.startRun(request, signal),
    dispose: () => port.dispose?.(),
  };
}

/** Redact failures before ChatEngine persists or displays provider events. */
export function safeChatProvider(port: ProviderPort): ProviderPort {
  return {
    ...port,
    async *startRun(request, signal): AsyncIterable<RunEvent> {
      try {
        for await (const event of port.startRun(request, signal)) {
          if (event.type !== "RunFailed") {
            yield event;
            continue;
          }
          const safe = toRecoverableChatError(
            Object.assign(new Error(event.error.message), {
              code: event.error.code,
            }),
          );
          yield {
            ...event,
            error: { ...event.error, code: safe.code, message: safe.message },
          };
        }
      } catch (error) {
        throw toRecoverableChatError(error);
      }
    },
  };
}

export async function selectedCapabilities(
  port: ProviderPort,
  modelId: string,
): Promise<CapabilityMap> {
  const result = await port.getCapabilities(undefined, modelId);
  return result.ok ? result.value : {};
}

function checkedUrl(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new TypeError(
      "Use an HTTP(S) endpoint without credentials, query, or fragment.",
    );
  return url;
}
function defaultEndpoint(kind: ChatProviderKind): string {
  const values: Partial<Record<ChatProviderKind, string>> = {
    openai: "https://api.openai.com/v1/responses",
    anthropic: "https://api.anthropic.com/v1/messages",
    gemini: "https://generativelanguage.googleapis.com",
    mistral: "https://api.mistral.ai",
    openrouter: "https://openrouter.ai/api/v1",
    deepseek: "https://api.deepseek.com/v1",
    zai: "https://open.bigmodel.cn/api/paas/v4",
    "vercel-gateway": "https://ai-gateway.vercel.sh/v1",
  };
  const value = values[kind];
  if (!value)
    throw new TypeError("An explicitly configured endpoint is required.");
  return value;
}
