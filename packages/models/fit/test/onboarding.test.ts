import { describe, expect, it } from "vitest";
import {
  getStartedRecovery,
  raceModelSetup,
  SQLiteOnboardingRepository,
} from "../../../../apps/mobile/features/onboarding/index.js";

class MemoryDatabase {
  row: {
    completed: number;
    mode: "beginner" | "power";
    theme: "system" | "light" | "dark";
    model_id: string | null;
    completed_at: string | null;
  } | null = null;
  async execAsync() {}
  async runAsync(
    _sql: string,
    ...params: (string | number | null | Uint8Array)[]
  ): Promise<unknown> {
    const [mode, theme, modelId, timestamp] = params as [
      string,
      string,
      string | null,
      string,
    ];
    this.row = {
      completed: 1,
      mode: mode as "beginner" | "power",
      theme: theme as "system" | "light" | "dark",
      model_id: modelId,
      completed_at: timestamp,
    };
    return undefined;
  }
  async getFirstAsync<T>(): Promise<T | null> {
    return this.row as T | null;
  }
  async getAllAsync<T>(): Promise<T[]> {
    return [];
  }
  async withTransactionAsync(work: () => Promise<void>) {
    await work();
  }
}

describe("first-run onboarding", () => {
  it("reopens saved onboarding preferences without creating chat data", async () => {
    const db = new MemoryDatabase();
    await new SQLiteOnboardingRepository(db).save({
      mode: "power",
      theme: "dark",
      modelId: null,
    });
    const state = await new SQLiteOnboardingRepository(db).get();
    expect(state).toMatchObject({
      completed: true,
      mode: "power",
      theme: "dark",
      modelId: null,
    });
    expect(getStartedRecovery(state.modelId !== null)).toBe("onboarding");
    expect(getStartedRecovery(true)).toBe("chat");
  });

  it("cancels optional setup candidates when one succeeds and permits skipping", async () => {
    const result = await raceModelSetup([
      { id: "first", run: async () => "ready" },
      {
        id: "second",
        run: (signal) =>
          new Promise<string>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          ),
      },
    ]);
    expect(result).toEqual({ id: "first", value: "ready" });
    const controller = new AbortController();
    controller.abort();
    expect(
      await raceModelSetup(
        [{ id: "never", run: async () => "ready" }],
        controller.signal,
      ),
    ).toBeNull();
  });
});
