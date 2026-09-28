import { EntityIdSchema, type Revision } from "@locallab/contracts/identity";
import { ToolInvocationSchema } from "@locallab/contracts/entities";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type {
  ToolInvocationRecord,
  ToolInvocationStore,
  ToolInvocationTerminalState,
} from "./index";

export type StoredToolInvocation = ToolInvocationRecord;
export const TOOL_ENGINE_SQL = [
  "CREATE TABLE IF NOT EXISTS tool_engine_invocations (id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, conversation_id TEXT NOT NULL, entity_json TEXT NOT NULL CHECK(json_valid(entity_json)));",
  "CREATE INDEX IF NOT EXISTS tool_engine_invocations_run ON tool_engine_invocations(run_id);",
  "CREATE TABLE IF NOT EXISTS tool_engine_clock (device_id TEXT PRIMARY KEY NOT NULL, wall_ms INTEGER NOT NULL, counter INTEGER NOT NULL);",
].join("\n");
const storeWrites = new WeakMap<SQLiteDatabasePort, Promise<void>>();

/** Durable invocation identities prevent re-execution after a completed result is replayed. */
export class SQLiteToolInvocationStore implements ToolInvocationStore {
  constructor(
    private readonly db: SQLiteDatabasePort,
    private readonly deviceId: string,
    private readonly now = () => new Date().toISOString(),
  ) {
    EntityIdSchema.parse(deviceId);
  }
  async initialize() {
    await this.db.execAsync(TOOL_ENGINE_SQL);
    for (const record of await this.list()) {
      if (record.state === "pending" || record.state === "running")
        await this.finish(record.id, "failed", {
          error: {
            code: "interrupted",
            message:
              "The tool invocation was interrupted. Review it before retrying.",
            recoverable: true,
          },
        });
    }
  }
  async get(id: string): Promise<ToolInvocationRecord | undefined> {
    return this.read(this.db, id);
  }
  private async read(
    db: SQLiteDatabasePort,
    id: string,
  ): Promise<ToolInvocationRecord | undefined> {
    const row = await db.getFirstAsync<{ entity_json: string }>(
      "SELECT entity_json FROM tool_engine_invocations WHERE id=?",
      id,
    );
    return row ? decode(row.entity_json) : undefined;
  }
  async list(runId?: string): Promise<ToolInvocationRecord[]> {
    const rows = await this.db.getAllAsync<{ entity_json: string }>(
      "SELECT entity_json FROM tool_engine_invocations" +
        (runId ? " WHERE run_id=?" : "") +
        " ORDER BY rowid",
      ...(runId ? [runId] : []),
    );
    return rows.map((row) => decode(row.entity_json));
  }
  async begin(
    input: Parameters<ToolInvocationStore["begin"]>[0],
  ): Promise<ToolInvocationRecord> {
    let result!: ToolInvocationRecord;
    await this.write(async (db) => {
      const existing = await this.read(db, input.id);
      if (existing) {
        if (
          existing.runId !== input.runId ||
          existing.conversationId !== input.conversationId ||
          existing.toolName !== input.toolName ||
          existing.serverId !== input.serverId ||
          existing.participantId !== input.participantId ||
          JSON.stringify(existing.input) !== JSON.stringify(input.input)
        )
          throw new Error(
            "Tool invocation identity conflicts with its saved binding.",
          );
        result = existing;
        return;
      }
      const timestamp = this.now();
      result = {
        ...input,
        state: "pending",
        output: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: await this.revision(db, timestamp),
      };
      validate(result);
      await db.runAsync(
        "INSERT INTO tool_engine_invocations(id,run_id,conversation_id,entity_json) VALUES(?,?,?,?)",
        result.id,
        result.runId,
        result.conversationId,
        JSON.stringify(result),
      );
    });
    return result;
  }
  async claimExecution(id: string): Promise<{
    claimed: boolean;
    record: ToolInvocationRecord;
  }> {
    let result!: { claimed: boolean; record: ToolInvocationRecord };
    await this.write(async (db) => {
      const existing = await this.read(db, id);
      if (!existing) throw new Error("Tool invocation is unavailable.");
      if (existing.state !== "pending") {
        result = { claimed: false, record: existing };
        return;
      }
      const timestamp = this.now();
      const record: ToolInvocationRecord = {
        ...existing,
        state: "running",
        updatedAt: timestamp,
        revision: await this.revision(db, timestamp),
      };
      validate(record);
      await db.runAsync(
        "UPDATE tool_engine_invocations SET entity_json=? WHERE id=?",
        JSON.stringify(record),
        id,
      );
      result = { claimed: true, record };
    });
    return result;
  }
  async finish(
    id: string,
    state: ToolInvocationTerminalState,
    output: unknown | null,
  ): Promise<ToolInvocationRecord> {
    if (!["completed", "failed", "canceled"].includes(state))
      throw new Error("Tool invocation completion requires a terminal state.");
    let result!: ToolInvocationRecord;
    await this.write(async (db) => {
      const existing = await this.read(db, id);
      if (!existing) throw new Error("Tool invocation is unavailable.");
      if (["completed", "failed", "canceled"].includes(existing.state)) {
        result = existing;
        return;
      }
      const timestamp = this.now();
      result = {
        ...existing,
        state,
        output,
        updatedAt: timestamp,
        revision: await this.revision(db, timestamp),
      };
      validate(result);
      await db.runAsync(
        "UPDATE tool_engine_invocations SET entity_json=? WHERE id=?",
        JSON.stringify(result),
        id,
      );
    });
    return result;
  }
  private async revision(
    db: SQLiteDatabasePort,
    timestamp: string,
  ): Promise<Revision> {
    const existing = await db.getFirstAsync<{
      wall_ms: number;
      counter: number;
    }>(
      "SELECT wall_ms,counter FROM tool_engine_clock WHERE device_id=?",
      this.deviceId,
    );
    const wallMs = Math.max(Date.parse(timestamp), existing?.wall_ms ?? 0);
    const counter =
      existing && existing.wall_ms === wallMs ? existing.counter + 1 : 0;
    await db.runAsync(
      "INSERT INTO tool_engine_clock(device_id,wall_ms,counter) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET wall_ms=excluded.wall_ms,counter=excluded.counter",
      this.deviceId,
      wallMs,
      counter,
    );
    return { wallMs, counter, deviceId: this.deviceId };
  }
  private async write(work: (db: SQLiteDatabasePort) => Promise<void>) {
    const previous = storeWrites.get(this.db) ?? Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(() =>
        this.db.withTransactionAsync((transaction?: SQLiteDatabasePort) =>
          work(transaction ?? this.db),
        ),
      );
    storeWrites.set(this.db, pending);
    await pending;
  }
}
function validate(record: ToolInvocationRecord) {
  const { participantId, ...entity } = record;
  ToolInvocationSchema.parse(entity);
  if (participantId) EntityIdSchema.parse(participantId);
}
function decode(json: string) {
  const record = JSON.parse(json) as ToolInvocationRecord;
  validate(record);
  return record;
}
