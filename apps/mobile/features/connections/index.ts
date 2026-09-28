import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { EntityIdSchema } from "@locallab/contracts/identity";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import { normalizeHost } from "@locallab/security-secrets";
import type {
  LanDiscoveryPermissionPort,
  LanProbePort,
  ProbeResult,
} from "../../../../modules/lan-discovery/src";
import {
  discoverLanServers,
  normalizeManualHost,
} from "../../../../modules/lan-discovery/src";

export function modelConnectionKind(
  kind: string,
):
  | "ollama"
  | "compatible"
  | "jan"
  | "omlx"
  | "unsloth"
  | "lmstudio"
  | undefined {
  const normalized = kind.trim().toLowerCase();
  if (["ollama", "jan", "omlx", "unsloth", "lmstudio"].includes(normalized))
    return normalized as "ollama" | "jan" | "omlx" | "unsloth" | "lmstudio";
  if (normalized === "lm-studio") return "lmstudio";
  if (
    [
      "compatible",
      "openai-compatible",
      "llama.cpp",
      "llamacpp",
      "custom",
    ].includes(normalized)
  )
    return "compatible";
  return undefined;
}

export interface SavedConnection {
  id: string;
  name: string;
  kind: string;
  host: string;
  /** Only opaque OS-secret-store references belong in the database. */
  credentialRef: string | null;
  headerRefs: readonly string[];
  customHeadersEnabled: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface SaveConnectionInput {
  id?: string;
  name: string;
  kind: string;
  host: string;
  credentialRef?: string | null;
  headerRefs?: readonly string[];
  customHeadersEnabled?: boolean;
}

export interface ConnectionRepository {
  list(): Promise<SavedConnection[]>;
  save(input: SaveConnectionInput): Promise<SavedConnection>;
  reorder(ids: readonly string[]): Promise<void>;
  delete(id: string): Promise<void>;
}

type ConnectionRow = {
  id: string;
  name: string;
  kind: string;
  host: string;
  credential_ref: string | null;
  header_refs_json: string;
  custom_headers_enabled: number;
  position: number;
  created_at: string;
  updated_at: string;
};

const CREATE_CONNECTIONS = `CREATE TABLE IF NOT EXISTS provider_connections_local (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  host TEXT NOT NULL,
  credential_ref TEXT,
  header_refs_json TEXT NOT NULL,
  custom_headers_enabled INTEGER NOT NULL DEFAULT 0 CHECK (custom_headers_enabled IN (0, 1)),
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

/** Persistent app-local connection CRUD. The row shape deliberately has no raw header value column. */
export class SQLiteConnectionRepository implements ConnectionRepository {
  private ready: Promise<void> | null = null;
  constructor(
    private readonly db: SQLiteDatabasePort,
    private readonly createId: () => string = uuidv7,
  ) {}

  async list(): Promise<SavedConnection[]> {
    await this.ensureSchema();
    const rows = await this.db.getAllAsync<ConnectionRow>(
      "SELECT * FROM provider_connections_local ORDER BY position, created_at, id",
    );
    return rows.map(decodeRow);
  }

  async save(input: SaveConnectionInput): Promise<SavedConnection> {
    await this.ensureSchema();
    const id = input.id ?? this.createId();
    EntityIdSchema.parse(id);
    const name = input.name.trim();
    const kind = input.kind.trim();
    if (!name || !kind)
      throw new Error("Connection name and provider are required");
    const host = normalizeConnectionHost(input.host);
    let result: SavedConnection | null = null;
    await this.db.withTransactionAsync(async (transaction) => {
      const db = transaction ?? this.db;
      const current = input.id
        ? await db.getFirstAsync<ConnectionRow>(
            "SELECT * FROM provider_connections_local WHERE id = ?",
            input.id,
          )
        : null;
      const refs = [
        ...(input.headerRefs ??
          (current ? (JSON.parse(current.header_refs_json) as string[]) : [])),
      ];
      const credentialRef =
        input.credentialRef === undefined
          ? (current?.credential_ref ?? null)
          : input.credentialRef;
      const enabled =
        input.customHeadersEnabled ?? current?.custom_headers_enabled === 1;
      if (credentialRef) validateSecretRef(credentialRef);
      refs.forEach(validateSecretRef);
      if (current && current.host !== host && (refs.length || credentialRef))
        throw new Error(
          "Remove saved credentials before changing the server host. Credentials are bound to their original host.",
        );
      const timestamp = new Date().toISOString();
      const maxRow = await db.getFirstAsync<{ max_position: number | null }>(
        "SELECT MAX(position) AS max_position FROM provider_connections_local",
      );
      const position = current?.position ?? (maxRow?.max_position ?? -1) + 1;
      await db.runAsync(
        `INSERT INTO provider_connections_local (id,name,kind,host,credential_ref,header_refs_json,custom_headers_enabled,position,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,host=excluded.host,
         credential_ref=excluded.credential_ref,header_refs_json=excluded.header_refs_json,
         custom_headers_enabled=excluded.custom_headers_enabled,updated_at=excluded.updated_at`,
        id,
        name,
        kind,
        host,
        credentialRef,
        JSON.stringify(refs),
        enabled ? 1 : 0,
        position,
        current?.created_at ?? timestamp,
        timestamp,
      );
      result = await this.get(id, db);
      if (!result) throw new Error("Saved connection could not be read.");
      await this.syncLinkedProvider(db, result, current?.host);
    });
    return result!;
  }

  async reorder(ids: readonly string[]): Promise<void> {
    await this.ensureSchema();
    const existing = (await this.list()).map((item) => item.id);
    if (
      ids.length !== existing.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !existing.includes(id))
    )
      throw new Error(
        "Reorder must include every saved connection exactly once",
      );
    await this.db.withTransactionAsync(async (transaction) => {
      const scopedDb = transaction ?? this.db;
      for (const [position, id] of ids.entries())
        await scopedDb.runAsync(
          "UPDATE provider_connections_local SET position = ?, updated_at = ? WHERE id = ?",
          position,
          new Date().toISOString(),
          id,
        );
    });
  }

  async delete(id: string): Promise<void> {
    await this.ensureSchema();
    await this.db.withTransactionAsync(async (transaction) => {
      const db = transaction ?? this.db;
      await this.removeLinkedProvider(db, id);
      if (await this.hasTable(db, "model_manager_selections_local"))
        await db.runAsync(
          "DELETE FROM model_manager_selections_local WHERE connection_id=?",
          id,
        );
      await db.runAsync(
        "DELETE FROM provider_connections_local WHERE id=?",
        id,
      );
    });
  }

  private async get(id: string, db = this.db): Promise<SavedConnection | null> {
    const row = await db.getFirstAsync<ConnectionRow>(
      "SELECT * FROM provider_connections_local WHERE id = ?",
      id,
    );
    return row ? decodeRow(row) : null;
  }

  private async hasTable(
    db: SQLiteDatabasePort,
    name: string,
  ): Promise<boolean> {
    return !!(await db.getFirstAsync<{ present: number }>(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?",
      name,
    ));
  }

  private async removeLinkedProvider(
    db: SQLiteDatabasePort,
    id: string,
  ): Promise<void> {
    if (await this.hasTable(db, "chat_provider_selections"))
      await db.runAsync(
        "DELETE FROM chat_provider_selections WHERE connection_id=?",
        id,
      );
    if (await this.hasTable(db, "chat_provider_connections"))
      await db.runAsync("DELETE FROM chat_provider_connections WHERE id=?", id);
  }

  /** Only same-ID registrations created by model selection are linked; historical run snapshots stay intact. */
  private async syncLinkedProvider(
    db: SQLiteDatabasePort,
    connection: SavedConnection,
    previousHost?: string,
  ): Promise<void> {
    if (!(await this.hasTable(db, "chat_provider_connections"))) return;
    const row = await db.getFirstAsync<{ registration_json: string }>(
      "SELECT registration_json FROM chat_provider_connections WHERE id=?",
      connection.id,
    );
    if (!row) return;
    const registration = JSON.parse(row.registration_json) as Record<
      string,
      unknown
    >;
    const kind = modelConnectionKind(connection.kind);
    if (!kind || kind !== registration.kind) {
      await this.removeLinkedProvider(db, connection.id);
      if (await this.hasTable(db, "model_manager_selections_local"))
        await db.runAsync(
          "UPDATE model_manager_selections_local SET model_id=NULL WHERE connection_id=?",
          connection.id,
        );
      return;
    }
    if (
      typeof registration.modelId !== "string" ||
      !registration.modelId.trim()
    )
      throw new Error(
        "The linked chat model is malformed. Choose a model again in Models.",
      );
    const updated = {
      id: connection.id,
      label: connection.name,
      kind,
      modelId: registration.modelId,
      endpoint: connection.host,
      ...(connection.credentialRef
        ? { credentialRef: connection.credentialRef }
        : {}),
      ...(connection.customHeadersEnabled && connection.headerRefs.length
        ? { headerRefs: connection.headerRefs }
        : {}),
      cleartextAuthorized:
        connection.host === previousHost &&
        registration.cleartextAuthorized === true,
      allowCrossProviderRouting:
        registration.allowCrossProviderRouting === true,
    };
    await db.runAsync(
      "UPDATE chat_provider_connections SET registration_json=?,updated_at=? WHERE id=?",
      JSON.stringify(updated),
      connection.updatedAt,
      connection.id,
    );
  }

  private ensureSchema(): Promise<void> {
    this.ready ??= this.db.execAsync(CREATE_CONNECTIONS);
    return this.ready;
  }
}

function decodeRow(row: ConnectionRow): SavedConnection {
  const refs = JSON.parse(row.header_refs_json) as unknown;
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string"))
    throw new Error("Saved connection header references are malformed");
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    host: row.host,
    credentialRef: row.credential_ref,
    headerRefs: refs as string[],
    customHeadersEnabled: row.custom_headers_enabled === 1,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function normalizeConnectionHost(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Connection URL must contain only scheme and host");
    return normalizeHost(url.origin);
  }
  const host = normalizeManualHost(trimmed);
  return normalizeHost(`http://${host}`);
}

function validateSecretRef(ref: string): asserts ref is SecretRef {
  if (!/^sec_[0-9a-f-]{36}$/i.test(ref))
    throw new Error("Credentials must be stored as an opaque secret reference");
}

function uuidv7(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const timestamp = Date.now();
  let remaining = BigInt(timestamp);
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface ConnectionRequestPort {
  /** Implementations must use manual redirect handling and never replay headers on a redirect. */
  request(
    url: string,
    headers: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<{ status: number; finalUrl: string }>;
}

/** A fetch adapter with redirects disabled, so credentials cannot follow a server supplied Location. */
export function createManualRedirectConnectionRequest(
  fetcher: typeof fetch,
): ConnectionRequestPort {
  return {
    async request(url, headers, signal) {
      const response = await fetcher(url, {
        method: "GET",
        headers,
        ...(signal ? { signal } : {}),
        redirect: "manual",
      });
      const location = response.headers.get("location");
      return {
        status: response.status,
        finalUrl: location
          ? new URL(location, url).toString()
          : response.url || url,
      };
    },
  };
}

/** Resolves secrets only at explicit connect/test time and blocks cross-origin redirects. */
export async function testConnection(input: {
  connection: SavedConnection;
  secrets: SecretStore;
  request: ConnectionRequestPort;
}): Promise<"connected" | "auth-required" | "failed"> {
  const origin = normalizeHost(input.connection.host);
  let headers: Readonly<Record<string, string>> = Object.freeze({});
  if (
    input.connection.customHeadersEnabled &&
    input.connection.headerRefs.length
  )
    headers = await input.secrets.resolveHeaders(
      origin,
      input.connection.headerRefs as SecretRef[],
    );
  if (input.connection.credentialRef) {
    const credentialHeaders = await input.secrets.resolveHeaders(origin, [
      input.connection.credentialRef as SecretRef,
    ]);
    headers = Object.freeze({ ...headers, ...credentialHeaders });
  }
  const response = await input.request.request(`${origin}/v1/models`, headers);
  try {
    const finalUrl = new URL(response.finalUrl);
    if (
      (finalUrl.protocol !== "http:" && finalUrl.protocol !== "https:") ||
      finalUrl.username ||
      finalUrl.password ||
      finalUrl.origin !== origin
    )
      return "failed";
  } catch {
    return "failed";
  }
  if (response.status === 401 || response.status === 403)
    return "auth-required";
  return response.status >= 200 && response.status < 300
    ? "connected"
    : "failed";
}

export interface ConnectionHelp {
  title: string;
  steps: readonly string[];
}

const PROVIDER_HELP: Readonly<Record<string, ConnectionHelp>> = Object.freeze({
  "llama.cpp": {
    title: "llama.cpp server",
    steps: [
      "Start the model server with its HTTP API enabled.",
      "Enter the server origin, for example http://127.0.0.1:35961, without /v1.",
      "Use Models to choose an exact model ID returned by /v1/models, then choose the saved provider in chat.",
      "On an iPhone, use the computer's LAN address. localhost and 127.0.0.1 refer to the phone itself.",
    ],
  },
  "lm-studio": {
    title: "LM Studio on your local network",
    steps: [
      "Enable the local server in LM Studio.",
      "Allow LAN access in the server settings.",
      "Enter the computer’s LAN IP and server port, then use discovery or test the connection.",
    ],
  },
  ollama: {
    title: "Ollama",
    steps: [
      "Start Ollama on the computer.",
      "Allow access from your local network in its server configuration.",
      "Enter the computer’s LAN IP and port 11434.",
    ],
  },
  openai: {
    title: "OpenAI",
    steps: [
      "Create an API key in your OpenAI account.",
      "Store it in the device secure store when adding the connection.",
      "Choose the model ID exposed by your account.",
    ],
  },
  anthropic: {
    title: "Anthropic",
    steps: [
      "Create an API key in your Anthropic account.",
      "Store the key in the device secure store.",
      "Choose a model available to your account.",
    ],
  },
});

export function getProviderHelp(kind: string): ConnectionHelp {
  return (
    PROVIDER_HELP[kind.toLowerCase()] ?? {
      title: "OpenAI-compatible server",
      steps: [
        "Enable the server API.",
        "Enter the full server origin without a path or credentials.",
        "Add any required auth header in secure storage and enable custom headers only when ready.",
      ],
    }
  );
}

export interface ConnectionFeatureDependencies {
  repository: ConnectionRepository;
  secrets: SecretStore;
  permission: LanDiscoveryPermissionPort;
  probe: LanProbePort;
  connectivity: ConnectionRequestPort;
  discoveryAvailable?: boolean;
}

export async function discoverConnections(
  hosts: readonly string[],
  permission: LanDiscoveryPermissionPort,
  probe: LanProbePort,
  signal?: AbortSignal,
): Promise<ProbeResult[]> {
  return discoverLanServers({
    hosts,
    permission,
    probe,
    ...(signal ? { signal } : {}),
  });
}
