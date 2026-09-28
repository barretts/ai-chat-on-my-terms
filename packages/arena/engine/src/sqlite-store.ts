import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { EntityIdSchema, type Revision } from "@locallab/contracts/identity";
import {
  ArenaContestantSchema,
  ArenaRunSchema,
  type ArenaContestant,
  type ArenaResult,
  type ArenaRun,
} from "./types";

/** Additive migration proposal. Legacy arena_sessions and their rows are untouched. */
export const ARENA_SQL = `
CREATE TABLE IF NOT EXISTS arena_runs (
  id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','completed','canceled','interrupted')),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision_wall_ms INTEGER NOT NULL CHECK (revision_wall_ms >= 0),
  revision_counter INTEGER NOT NULL CHECK (revision_counter >= 0),
  revision_device_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS arena_contestants (
  id TEXT PRIMARY KEY NOT NULL,
  arena_run_id TEXT NOT NULL REFERENCES arena_runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 3),
  state TEXT NOT NULL CHECK (state IN ('queued','running','completed','failed','canceled','interrupted')),
  provider_connection_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision_wall_ms INTEGER NOT NULL CHECK (revision_wall_ms >= 0),
  revision_counter INTEGER NOT NULL CHECK (revision_counter >= 0),
  revision_device_id TEXT NOT NULL,
  UNIQUE (arena_run_id, position)
);
CREATE INDEX IF NOT EXISTS arena_runs_state_updated ON arena_runs(state, updated_at);
CREATE INDEX IF NOT EXISTS arena_contestants_run_position ON arena_contestants(arena_run_id, position);
`;

type RecordRow = { record_json: string };
type Stamped = { updatedAt: string; revision: Revision };
const terminal = new Set<ArenaContestant["state"]>([
  "completed",
  "failed",
  "canceled",
  "interrupted",
]);

/** Serializes transactions within this store; stream deltas apply backpressure
 * rather than accumulating an unbounded write queue. Use one store per DB owner. */
export class SQLiteArenaStore {
  private writes: Promise<unknown> = Promise.resolve();
  private clock: Revision | undefined;
  constructor(
    private readonly db: SQLiteDatabasePort,
    private readonly options: { deviceId: string; now?: () => Date },
  ) {
    EntityIdSchema.parse(options.deviceId);
  }

  initialize(): Promise<void> {
    return this.serialize(async () => {
      await this.db.execAsync(ARENA_SQL);
      const latest = await this.db.getFirstAsync<{
        revision_wall_ms: number;
        revision_counter: number;
      }>(
        "SELECT revision_wall_ms,revision_counter FROM (SELECT revision_wall_ms,revision_counter FROM arena_runs UNION ALL SELECT revision_wall_ms,revision_counter FROM arena_contestants) ORDER BY revision_wall_ms DESC,revision_counter DESC LIMIT 1",
      );
      if (latest)
        this.clock = {
          wallMs: latest.revision_wall_ms,
          counter: latest.revision_counter,
          deviceId: this.options.deviceId,
        };
    });
  }

  create(
    run: ArenaRun,
    contestants: readonly ArenaContestant[],
  ): Promise<void> {
    ArenaRunSchema.parse(run);
    contestants.forEach((contestant) =>
      ArenaContestantSchema.parse(contestant),
    );
    if (
      contestants.length !== run.contestantIds.length ||
      contestants.some(
        (contestant, index) =>
          contestant.arenaRunId !== run.id ||
          contestant.id !== run.contestantIds[index] ||
          contestant.position !== index,
      )
    )
      throw new Error(
        "Arena contestants must match their run and unique positions",
      );
    return this.serialize(() =>
      this.db.withTransactionAsync(async (transaction) => {
        const db = transaction ?? this.db;
        await db.runAsync(
          "INSERT INTO arena_runs(id,state,record_json,created_at,updated_at,revision_wall_ms,revision_counter,revision_device_id) VALUES (?,?,?,?,?,?,?,?)",
          run.id,
          run.state,
          JSON.stringify(run),
          run.createdAt,
          run.updatedAt,
          run.revision.wallMs,
          run.revision.counter,
          run.revision.deviceId,
        );
        for (const contestant of contestants) {
          await db.runAsync(
            "INSERT INTO arena_contestants(id,arena_run_id,position,state,provider_connection_id,model_id,record_json,created_at,updated_at,revision_wall_ms,revision_counter,revision_device_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            contestant.id,
            run.id,
            contestant.position,
            contestant.state,
            contestant.providerConnectionId,
            contestant.modelId,
            JSON.stringify(contestant),
            contestant.createdAt,
            contestant.updatedAt,
            contestant.revision.wallMs,
            contestant.revision.counter,
            contestant.revision.deviceId,
          );
        }
      }),
    );
  }

  async read(id: string): Promise<ArenaResult | null> {
    await this.writes;
    const row = await this.db.getFirstAsync<RecordRow>(
      "SELECT record_json FROM arena_runs WHERE id=?",
      id,
    );
    if (!row) return null;
    const contestants = await this.db.getAllAsync<RecordRow>(
      "SELECT record_json FROM arena_contestants WHERE arena_run_id=? ORDER BY position",
      id,
    );
    return {
      run: ArenaRunSchema.parse(JSON.parse(row.record_json)),
      contestants: contestants.map((item) =>
        ArenaContestantSchema.parse(JSON.parse(item.record_json)),
      ),
    };
  }

  async list(limit = 100): Promise<readonly ArenaRun[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new RangeError("Arena history limit must be from 1 to 1000");
    await this.writes;
    const rows = await this.db.getAllAsync<RecordRow>(
      "SELECT record_json FROM arena_runs ORDER BY created_at DESC, id DESC LIMIT ?",
      limit,
    );
    return rows.map((row) => ArenaRunSchema.parse(JSON.parse(row.record_json)));
  }

  updateContestant(
    id: string,
    change: (current: ArenaContestant) => ArenaContestant,
  ): Promise<ArenaContestant> {
    return this.serialize(async () => {
      let result: ArenaContestant | undefined;
      await this.db.withTransactionAsync(async (transaction) => {
        const db = transaction ?? this.db;
        const row = await db.getFirstAsync<RecordRow>(
          "SELECT record_json FROM arena_contestants WHERE id=?",
          id,
        );
        if (!row) throw new Error("Arena contestant does not exist");
        const current = ArenaContestantSchema.parse(
          JSON.parse(row.record_json),
        );
        // Late provider deltas cannot overwrite canceled, failed, or completed output.
        if (terminal.has(current.state)) {
          result = current;
          return;
        }
        const next = ArenaContestantSchema.parse({
          ...change(current),
          ...this.stamp(current.revision),
        });
        if (
          next.id !== current.id ||
          next.arenaRunId !== current.arenaRunId ||
          next.modelId !== current.modelId ||
          next.providerConnectionId !== current.providerConnectionId ||
          next.position !== current.position ||
          next.createdAt !== current.createdAt
        )
          throw new Error("Arena binding identity is immutable");
        await db.runAsync(
          "UPDATE arena_contestants SET state=?,record_json=?,updated_at=?,revision_wall_ms=?,revision_counter=?,revision_device_id=? WHERE id=?",
          next.state,
          JSON.stringify(next),
          next.updatedAt,
          next.revision.wallMs,
          next.revision.counter,
          next.revision.deviceId,
          id,
        );
        result = next;
      });
      return result!;
    });
  }

  finish(id: string, state: ArenaRun["state"]): Promise<ArenaRun> {
    return this.serialize(async () => {
      const row = await this.db.getFirstAsync<RecordRow>(
        "SELECT record_json FROM arena_runs WHERE id=?",
        id,
      );
      if (!row) throw new Error("Arena run does not exist");
      const current = ArenaRunSchema.parse(JSON.parse(row.record_json));
      if (current.state !== "running") return current;
      const stamp = this.stamp(current.revision);
      const next = ArenaRunSchema.parse({
        ...current,
        ...stamp,
        state,
        finishedAt: stamp.updatedAt,
      });
      await this.db.runAsync(
        "UPDATE arena_runs SET state=?,record_json=?,updated_at=?,revision_wall_ms=?,revision_counter=?,revision_device_id=? WHERE id=?",
        next.state,
        JSON.stringify(next),
        next.updatedAt,
        next.revision.wallMs,
        next.revision.counter,
        next.revision.deviceId,
        id,
      );
      return next;
    });
  }

  /** Interrupted HTTP/local streams are not replayed after reopen. A new race is
   * an explicit action, so an uncertain old request never causes duplicate spend. */
  recover(): Promise<readonly string[]> {
    return this.serialize(async () => {
      const rows = await this.db.getAllAsync<RecordRow>(
        "SELECT record_json FROM arena_runs WHERE state='running'",
      );
      const ids: string[] = [];
      for (const row of rows) {
        const run = ArenaRunSchema.parse(JSON.parse(row.record_json));
        await this.db.withTransactionAsync(async (transaction) => {
          const db = transaction ?? this.db;
          const contestants = await db.getAllAsync<RecordRow>(
            "SELECT record_json FROM arena_contestants WHERE arena_run_id=? AND state IN ('queued','running')",
            run.id,
          );
          for (const contestantRow of contestants) {
            const current = ArenaContestantSchema.parse(
              JSON.parse(contestantRow.record_json),
            );
            const stamp = this.stamp(current.revision);
            const next = ArenaContestantSchema.parse({
              ...current,
              ...stamp,
              state: "interrupted",
              finishedAt: stamp.updatedAt,
              error: {
                code: "host-stopped",
                message:
                  "The arena stream was interrupted. Start a new race to run it again.",
                recoverable: true,
              },
            });
            await db.runAsync(
              "UPDATE arena_contestants SET state=?,record_json=?,updated_at=?,revision_wall_ms=?,revision_counter=?,revision_device_id=? WHERE id=?",
              next.state,
              JSON.stringify(next),
              next.updatedAt,
              next.revision.wallMs,
              next.revision.counter,
              next.revision.deviceId,
              next.id,
            );
          }
          const stamp = this.stamp(run.revision);
          const next = ArenaRunSchema.parse({
            ...run,
            ...stamp,
            state: "interrupted",
            finishedAt: stamp.updatedAt,
          });
          await db.runAsync(
            "UPDATE arena_runs SET state=?,record_json=?,updated_at=?,revision_wall_ms=?,revision_counter=?,revision_device_id=? WHERE id=?",
            next.state,
            JSON.stringify(next),
            next.updatedAt,
            next.revision.wallMs,
            next.revision.counter,
            next.revision.deviceId,
            next.id,
          );
        });
        ids.push(run.id);
      }
      return ids;
    });
  }

  stamp(previous?: Revision): Stamped {
    const now = (this.options.now ?? (() => new Date()))();
    const wallMs = Math.max(
      0,
      now.getTime(),
      previous?.wallMs ?? 0,
      this.clock?.wallMs ?? 0,
    );
    const counter =
      Math.max(
        previous?.wallMs === wallMs ? previous.counter : -1,
        this.clock?.wallMs === wallMs ? this.clock.counter : -1,
      ) + 1;
    this.clock = { wallMs, counter, deviceId: this.options.deviceId };
    return { updatedAt: now.toISOString(), revision: { ...this.clock } };
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writes.then(work);
    this.writes = result.catch(() => undefined);
    return result;
  }
}
