import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

/**
 * A file transcript the user imported in Voice Studio (VO-16). The audio
 * file is copied into the app's document directory first, so the recording
 * still plays after the picker's cache entry is gone.
 */
export interface ImportedTranscription {
  readonly id: string;
  readonly name: string;
  readonly audioUri: string;
  readonly text: string;
  readonly createdAt: number;
}

const TABLE = "voice_transcription_imports";

function entityToken(value: string): string {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(value))
    throw new Error("Transcription id is invalid.");
  return value;
}

/** Newest-first list of retained transcripts and their playable copies. */
export class SQLiteTranscriptionImportStore {
  constructor(private readonly database: SQLiteDatabasePort) {}
  private ready: Promise<void> | null = null;
  private ensureSchema(): Promise<void> {
    this.ready ??= this.database
      .execAsync(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           audio_path TEXT NOT NULL,
           transcript TEXT NOT NULL,
           created_at INTEGER NOT NULL
         )`,
      )
      .then(() => {});
    return this.ready;
  }
  async list(): Promise<ImportedTranscription[]> {
    await this.ensureSchema();
    const rows = await this.database.getAllAsync<ImportedTranscription>(
      `SELECT id, name, audio_path AS audioUri, transcript AS text,
              created_at AS createdAt
         FROM ${TABLE} ORDER BY created_at DESC`,
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      audioUri: row.audioUri,
      text: row.text,
      createdAt: row.createdAt,
    }));
  }
  async add(record: ImportedTranscription): Promise<void> {
    await this.ensureSchema();
    const name = record.name.trim().slice(0, 200);
    if (!name) throw new Error("Transcription name is required.");
    if (!record.audioUri.trim())
      throw new Error("Transcription audio path is required.");
    await this.database.runAsync(
      `INSERT INTO ${TABLE} (id, name, audio_path, transcript, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name,
         audio_path = excluded.audio_path, transcript = excluded.transcript,
         created_at = excluded.created_at`,
      entityToken(record.id),
      name,
      record.audioUri,
      record.text,
      record.createdAt,
    );
  }
  /** Removes the row only; the caller deletes the audio file. */
  async remove(id: string): Promise<void> {
    await this.ensureSchema();
    await this.database.runAsync(
      `DELETE FROM ${TABLE} WHERE id = ?`,
      entityToken(id),
    );
  }
}
