import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { EntityIdSchema } from "@locallab/contracts/identity";

export interface SavedModelSelection {
  connectionId: string;
  modelId: string | null;
}

/** App-local exact server/model choice, persisted independently of chat history. */
export class SQLiteModelSelectionRepository {
  constructor(private readonly db: SQLiteDatabasePort) {}

  async initialize(): Promise<void> {
    await this.db
      .execAsync(`CREATE TABLE IF NOT EXISTS model_manager_selections_local (
      connection_id TEXT PRIMARY KEY NOT NULL, model_id TEXT,
      active INTEGER NOT NULL CHECK(active IN (0,1))
    ); CREATE UNIQUE INDEX IF NOT EXISTS model_manager_one_active_local
      ON model_manager_selections_local(active) WHERE active=1`);
  }

  async active(): Promise<SavedModelSelection | null> {
    const row = await this.db.getFirstAsync<{
      connection_id: string;
      model_id: string | null;
    }>(
      "SELECT connection_id,model_id FROM model_manager_selections_local WHERE active=1",
    );
    return row
      ? { connectionId: row.connection_id, modelId: row.model_id }
      : null;
  }

  async modelForConnection(connectionId: string): Promise<string | null> {
    const row = await this.db.getFirstAsync<{ model_id: string | null }>(
      "SELECT model_id FROM model_manager_selections_local WHERE connection_id=?",
      connectionId,
    );
    return row?.model_id ?? null;
  }

  async chooseConnection(connectionId: string): Promise<void> {
    EntityIdSchema.parse(connectionId);
    await this.db.withTransactionAsync(async (transaction) => {
      const scoped = transaction ?? this.db;
      await scoped.runAsync(
        "UPDATE model_manager_selections_local SET active=0 WHERE active=1",
      );
      await scoped.runAsync(
        "INSERT INTO model_manager_selections_local(connection_id,model_id,active) VALUES(?,NULL,1) ON CONFLICT(connection_id) DO UPDATE SET active=1",
        connectionId,
      );
    });
  }

  /** The caller may bind this repository to its transaction facade for atomic registry saves. */
  async selectModel(connectionId: string, modelId: string): Promise<void> {
    EntityIdSchema.parse(connectionId);
    if (!modelId.trim()) throw new TypeError("An exact model ID is required.");
    await this.db.runAsync(
      "UPDATE model_manager_selections_local SET model_id=? WHERE connection_id=?",
      modelId,
      connectionId,
    );
  }
}
