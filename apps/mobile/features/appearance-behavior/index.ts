import {
  DEFAULT_APPEARANCE_BEHAVIOR,
  createDeferringSendPort,
  effectiveEffects,
  lowBatteryActive,
  parseBehaviorImport,
  plainStreamEnabled,
  type AppearanceBehaviorV1,
  type BatterySnapshot,
  type EffectLevel,
  type SendPortLike,
} from "@locallab/appearance-behavior";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

export const behaviorSql = `CREATE TABLE IF NOT EXISTS appearance_behavior (
  scope TEXT PRIMARY KEY NOT NULL,
  doc TEXT NOT NULL
)`;

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface BehaviorWriteResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface AppearanceBehaviorStore {
  load(): Promise<AppearanceBehaviorV1>;
  save(behavior: AppearanceBehaviorV1): Promise<BehaviorWriteResult>;
}

export function createAppearanceBehaviorStore(
  db: SQLiteDatabasePort,
): AppearanceBehaviorStore {
  return {
    async load() {
      const row = await db.getFirstAsync<{ doc: string }>(
        "SELECT doc FROM appearance_behavior WHERE scope = ?",
        "global",
      );
      if (row === null) return { ...DEFAULT_APPEARANCE_BEHAVIOR };
      const parsed = parseBehaviorImport(safeJson(row.doc));
      return parsed.ok ? parsed.behavior : { ...DEFAULT_APPEARANCE_BEHAVIOR };
    },
    async save(behavior) {
      const parsed = parseBehaviorImport(behavior);
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
      await db.runAsync(
        "INSERT INTO appearance_behavior(scope, doc) VALUES(?, ?) ON CONFLICT(scope) DO UPDATE SET doc=excluded.doc",
        "global",
        JSON.stringify(parsed.behavior),
      );
      return { ok: true };
    },
  };
}

export interface BatterySource {
  read(): Promise<BatterySnapshot | null>;
  subscribe(onChange: (battery: BatterySnapshot | null) => void): () => void;
}

export const inertBatterySource: BatterySource = {
  async read() {
    return null;
  },
  subscribe() {
    return () => undefined;
  },
};

/** Battery + settings state machine shared by the UI provider and tests. */
export interface BehaviorController {
  start(): Promise<void>;
  stop(): void;
  update(behavior: AppearanceBehaviorV1): Promise<BehaviorWriteResult>;
  registerGate(inner: SendPortLike): DeferringGate;
  readonly behavior: AppearanceBehaviorV1;
  readonly battery: BatterySnapshot | null;
  readonly active: boolean;
  effects(): EffectLevel;
  plainStream(): boolean;
}

export type DeferringGate = ReturnType<typeof createDeferringSendPort>;

export function createBehaviorController(
  store: AppearanceBehaviorStore,
  batterySource: BatterySource = inertBatterySource,
): BehaviorController {
  let behavior = { ...DEFAULT_APPEARANCE_BEHAVIOR };
  let battery: BatterySnapshot | null = null;
  let unsubscribe: (() => void) | null = null;
  const gates = new Set<DeferringGate>();
  const syncGating = () => {
    if (lowBatteryActive(behavior, battery)) {
      for (const gate of gates) gate.defer();
      return;
    }
    for (const gate of gates) void gate.resume();
  };
  return {
    async start() {
      behavior = await store.load();
      battery = await batterySource.read();
      syncGating();
      unsubscribe = batterySource.subscribe((next) => {
        battery = next;
        syncGating();
      });
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
    },
    async update(next) {
      const normalized: AppearanceBehaviorV1 = {
        version: 1,
        glassEnabled: next.glassEnabled,
        lowBatteryMode: next.lowBatteryMode,
        fullWidthReplies: next.fullWidthReplies,
      };
      const result = await store.save(normalized);
      if (!result.ok) return result;
      behavior = normalized;
      syncGating();
      return result;
    },
    registerGate(inner) {
      const gate = createDeferringSendPort(inner);
      gates.add(gate);
      if (lowBatteryActive(behavior, battery)) gate.defer();
      return gate;
    },
    get behavior() {
      return behavior;
    },
    get battery() {
      return battery;
    },
    get active() {
      return lowBatteryActive(behavior, battery);
    },
    effects() {
      return effectiveEffects(behavior, battery);
    },
    plainStream() {
      return plainStreamEnabled(behavior, battery);
    },
  };
}

export type { AppearanceBehaviorV1, BatterySnapshot, EffectLevel, SendPortLike };
