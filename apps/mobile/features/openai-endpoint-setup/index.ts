import { EntityIdSchema } from "@locallab/contracts/identity";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
const DEFAULT_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

export interface OpenAIEndpointSetup {
  readonly connectionId: string;
  readonly endpointUrl: string;
  readonly modelId: string;
  /** Opaque secure-store reference only. */
  readonly apiKeyRef: SecretRef;
}

export interface OpenAIEndpointSetupRepository {
  get(connectionId: string): Promise<OpenAIEndpointSetup | null>;
  save(setup: OpenAIEndpointSetup): Promise<void>;
}

/** Adapter factory callback shape: passing the run's connection ID loads only that saved host/model/ref. */
export async function resolveOpenAIEndpointConnection(
  repository: OpenAIEndpointSetupRepository,
  connectionId: string,
): Promise<{ endpointUrl: string; modelId: string; apiKeyRef: SecretRef }> {
  const setup = await repository.get(connectionId);
  if (!setup) throw new Error("OpenAI endpoint is not configured");
  return {
    endpointUrl: setup.endpointUrl,
    modelId: setup.modelId,
    apiKeyRef: setup.apiKeyRef,
  };
}

type SetupRow = {
  connection_id: string;
  endpoint_url: string;
  model_id: string;
  api_key_ref: string;
};
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS openai_first_run_setup (
  connection_id TEXT PRIMARY KEY NOT NULL,
  endpoint_url TEXT NOT NULL,
  model_id TEXT NOT NULL,
  api_key_ref TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

/** Small durable setup repository; credential bytes remain in the OS secure store. */
export class SQLiteOpenAIEndpointSetupRepository
  implements OpenAIEndpointSetupRepository
{
  private ready: Promise<void> | undefined;
  constructor(private readonly db: SQLiteDatabasePort) {}

  async get(connectionId: string): Promise<OpenAIEndpointSetup | null> {
    EntityIdSchema.parse(connectionId);
    await this.ensureSchema();
    const row = await this.db.getFirstAsync<SetupRow>(
      "SELECT connection_id, endpoint_url, model_id, api_key_ref FROM openai_first_run_setup WHERE connection_id = ?",
      connectionId,
    );
    return row ? decodeRow(row) : null;
  }

  async save(setup: OpenAIEndpointSetup): Promise<void> {
    EntityIdSchema.parse(setup.connectionId);
    const endpoint = validateEndpoint(setup.endpointUrl).toString();
    const model = setup.modelId.trim();
    if (!model || model.length > 200) throw new Error("Enter a valid model ID");
    if (!/^sec_[0-9a-f-]{36}$/i.test(setup.apiKeyRef))
      throw new Error("A secure API key reference is required");
    await this.ensureSchema();
    await this.db.withTransactionAsync(async (transaction) => {
      const scopedDb = transaction ?? this.db;
      await scopedDb.runAsync(
        `INSERT INTO openai_first_run_setup (connection_id, endpoint_url, model_id, api_key_ref, updated_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(connection_id) DO UPDATE SET
         endpoint_url=excluded.endpoint_url, model_id=excluded.model_id,
         api_key_ref=excluded.api_key_ref, updated_at=excluded.updated_at`,
        setup.connectionId,
        endpoint,
        model,
        setup.apiKeyRef,
        new Date().toISOString(),
      );
    });
  }

  private ensureSchema(): Promise<void> {
    this.ready ??= this.db.execAsync(CREATE_TABLE);
    return this.ready;
  }
}

function decodeRow(row: SetupRow): OpenAIEndpointSetup {
  const endpoint = validateEndpoint(row.endpoint_url).toString();
  if (!row.model_id.trim() || !/^sec_[0-9a-f-]{36}$/i.test(row.api_key_ref))
    throw new Error("Saved OpenAI setup is invalid");
  return {
    connectionId: row.connection_id,
    endpointUrl: endpoint,
    modelId: row.model_id,
    apiKeyRef: row.api_key_ref as SecretRef,
  };
}

export async function saveOpenAIEndpointSetup(input: {
  readonly connectionId: string;
  readonly endpointUrl: string;
  readonly modelId: string;
  readonly apiKey: string;
  readonly repository: OpenAIEndpointSetupRepository;
  readonly secrets: SecretStore;
}): Promise<OpenAIEndpointSetup> {
  const endpoint = validateEndpoint(input.endpointUrl);
  const modelId = input.modelId.trim();
  if (!modelId || modelId.length > 200)
    throw new Error("Enter a valid model ID");
  const previous = await input.repository.get(input.connectionId);
  let ref = previous?.apiKeyRef;
  let createdRef: SecretRef | undefined;
  if (input.apiKey.trim()) {
    createdRef = (
      await input.secrets.put(
        endpoint.origin,
        "Authorization",
        input.apiKey.trim(),
      )
    ).ref;
    ref = createdRef;
  } else if (ref) {
    // A host change invalidates the old host-scoped ref; do not silently keep an unusable credential.
    await input.secrets.resolveHeaders(endpoint.origin, [ref]);
  }
  if (!ref) throw new Error("Enter an API key to save this endpoint");
  const setup = {
    connectionId: input.connectionId,
    endpointUrl: endpoint.toString(),
    modelId,
    apiKeyRef: ref,
  };
  try {
    await input.repository.save(setup);
  } catch (error) {
    if (createdRef)
      await input.secrets.remove(createdRef).catch(() => undefined);
    throw error;
  }
  if (previous?.apiKeyRef && previous.apiKeyRef !== ref)
    await input.secrets.remove(previous.apiKeyRef).catch(() => undefined);
  return setup;
}

export function newOpenAISetupDefaults(
  connectionId: string,
): Omit<OpenAIEndpointSetup, "apiKeyRef"> {
  EntityIdSchema.parse(connectionId);
  return {
    connectionId,
    endpointUrl: DEFAULT_RESPONSES_ENDPOINT,
    modelId: "gpt-4.1-mini",
  };
}

function validateEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid HTTPS Responses endpoint");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/\/responses\/?$/i.test(url.pathname)
  )
    throw new Error(
      "Responses endpoint must be an HTTPS URL ending in /responses",
    );
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}
