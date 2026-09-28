import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type { FitMode } from "@locallab/models-fit";

export type OnboardingTheme = "system" | "light" | "dark";
export interface OnboardingState {
  readonly completed: boolean;
  readonly mode: FitMode;
  readonly theme: OnboardingTheme;
  readonly modelId: string | null;
  readonly completedAt: string | null;
}

const CREATE_STATE = `CREATE TABLE IF NOT EXISTS onboarding_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
  mode TEXT NOT NULL CHECK (mode IN ('beginner', 'power')),
  theme TEXT NOT NULL CHECK (theme IN ('system', 'light', 'dark')),
  model_id TEXT,
  completed_at TEXT
)`;

export class SQLiteOnboardingRepository {
  private ready: Promise<void> | null = null;
  constructor(private readonly db: SQLiteDatabasePort) {}

  async get(): Promise<OnboardingState> {
    await this.ensureSchema();
    const row = await this.db.getFirstAsync<{
      completed: number;
      mode: FitMode;
      theme: OnboardingTheme;
      model_id: string | null;
      completed_at: string | null;
    }>(
      "SELECT completed, mode, theme, model_id, completed_at FROM onboarding_state WHERE singleton = 1",
    );
    return row
      ? {
          completed: row.completed === 1,
          mode: row.mode,
          theme: row.theme,
          modelId: row.model_id,
          completedAt: row.completed_at,
        }
      : {
          completed: false,
          mode: "beginner",
          theme: "system",
          modelId: null,
          completedAt: null,
        };
  }

  async save(input: {
    mode: FitMode;
    theme: OnboardingTheme;
    modelId?: string | null;
  }): Promise<void> {
    await this.ensureSchema();
    const timestamp = new Date().toISOString();
    await this.db.runAsync(
      `INSERT INTO onboarding_state (singleton, completed, mode, theme, model_id, completed_at)
       VALUES (1, 1, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET completed=1, mode=excluded.mode, theme=excluded.theme,
       model_id=excluded.model_id, completed_at=excluded.completed_at`,
      input.mode,
      input.theme,
      input.modelId ?? null,
      timestamp,
    );
  }

  /** Preview preferences survive navigation without marking setup complete. */
  async updatePreferences(input: {
    mode?: FitMode;
    theme?: OnboardingTheme;
  }): Promise<void> {
    await this.ensureSchema();
    await this.db.runAsync(
      `INSERT INTO onboarding_state (singleton, completed, mode, theme, model_id, completed_at)
       VALUES (1, 0, ?, ?, NULL, NULL)
       ON CONFLICT(singleton) DO UPDATE SET
       mode=COALESCE(?, onboarding_state.mode), theme=COALESCE(?, onboarding_state.theme)`,
      input.mode ?? "beginner",
      input.theme ?? "system",
      input.mode ?? null,
      input.theme ?? null,
    );
  }

  private ensureSchema(): Promise<void> {
    this.ready ??= this.db.execAsync(CREATE_STATE);
    return this.ready;
  }
}

export interface RaceCandidate<T> {
  readonly id: string;
  readonly run: (signal: AbortSignal) => Promise<T>;
}

/** Optional race: caller only invokes after an explicit opt-in; first success cancels the others. */
export async function raceModelSetup<T>(
  candidates: readonly RaceCandidate<T>[],
  signal?: AbortSignal,
): Promise<{ id: string; value: T } | null> {
  if (!candidates.length || signal?.aborted) return null;
  const controller = new AbortController();
  let settle!: (value: { id: string; value: T } | null) => void;
  const output = new Promise<{ id: string; value: T } | null>((resolve) => {
    settle = resolve;
  });
  const abort = () => {
    controller.abort(signal?.reason);
    settle(null);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    let remaining = candidates.length;
    for (const candidate of candidates) {
      void candidate
        .run(controller.signal)
        .then((value) => {
          if (controller.signal.aborted) return;
          controller.abort(
            new DOMException("Another setup candidate completed", "AbortError"),
          );
          settle({ id: candidate.id, value });
        })
        .catch(() => {
          remaining -= 1;
          if (!remaining) settle(null);
        });
    }
    if (signal?.aborted) abort();
    return await output;
  } finally {
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

export function getStartedRecovery(
  hasConfiguredModel: boolean,
): "chat" | "onboarding" {
  return hasConfiguredModel ? "chat" : "onboarding";
}
