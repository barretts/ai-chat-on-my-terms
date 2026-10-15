import { z } from "zod";

export const BEHAVIOR_SCHEMA_VERSION = 1;

export type LowBatteryMode = "off" | "auto" | "on";

/** Durable appearance-behavior preferences (v1, versioned data). */
export interface AppearanceBehaviorV1 {
  version: 1;
  glassEnabled: boolean;
  lowBatteryMode: LowBatteryMode;
  fullWidthReplies: boolean;
}

/** Runtime battery observation; `level` is 0..1. `null` = unknown source. */
export interface BatterySnapshot {
  level: number;
  charging: boolean;
}

export const LOW_BATTERY_LEVEL = 0.2;

export const DEFAULT_APPEARANCE_BEHAVIOR: AppearanceBehaviorV1 = {
  version: BEHAVIOR_SCHEMA_VERSION,
  glassEnabled: true,
  lowBatteryMode: "auto",
  fullWidthReplies: true,
};

const behaviorSchema = z.strictObject({
  version: z.literal(BEHAVIOR_SCHEMA_VERSION),
  glassEnabled: z.boolean(),
  lowBatteryMode: z.enum(["off", "auto", "on"]),
  fullWidthReplies: z.boolean(),
});

export type BehaviorImportResult =
  | { ok: true; behavior: AppearanceBehaviorV1 }
  | { ok: false; reason: string };

/** Strict versioned import: unknown keys, out-of-range values, and wrong
 * types are rejected; imports never silently rewrite numeric values. */
export function parseBehaviorImport(raw: unknown): BehaviorImportResult {
  const parsed = behaviorSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, reason: formatIssues(parsed.error.issues) };
  return { ok: true, behavior: parsed.data };
}

/** Clamp-and-default for live UI paths (never for imports). */
export function normalizeBehavior(raw: unknown): AppearanceBehaviorV1 {
  const value =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  return {
    version: BEHAVIOR_SCHEMA_VERSION,
    glassEnabled: value.glassEnabled === true,
    lowBatteryMode:
      value.lowBatteryMode === "off" ||
      value.lowBatteryMode === "on" ||
      value.lowBatteryMode === "auto"
        ? value.lowBatteryMode
        : DEFAULT_APPEARANCE_BEHAVIOR.lowBatteryMode,
    fullWidthReplies: value.fullWidthReplies !== false,
  };
}

/** True when the low-battery profile is currently in force. `auto` only
 * engages on a known, unplugged, at-or-below-threshold reading. */
export function lowBatteryActive(
  behavior: AppearanceBehaviorV1,
  battery: BatterySnapshot | null,
): boolean {
  if (behavior.lowBatteryMode === "on") return true;
  if (behavior.lowBatteryMode === "off") return false;
  return battery !== null && !battery.charging && battery.level <= LOW_BATTERY_LEVEL;
}

export type EffectLevel = "glass" | "plain" | "reduced";

/** Which visual effect tier is active: low battery always reduces effects,
 * regardless of the glass toggle. */
export function effectiveEffects(
  behavior: AppearanceBehaviorV1,
  battery: BatterySnapshot | null,
): EffectLevel {
  if (lowBatteryActive(behavior, battery)) return "reduced";
  return behavior.glassEnabled ? "glass" : "plain";
}

/** Low-battery mode switches streaming replies to plain text. */
export function plainStreamEnabled(
  behavior: AppearanceBehaviorV1,
  battery: BatterySnapshot | null,
): boolean {
  return lowBatteryActive(behavior, battery);
}

export interface SendPortLike {
  send(payload: unknown, requestId: string): Promise<void>;
}

export interface DeferringSendPort {
  /** Wrap a send port; while deferred, sends are buffered in order. */
  send(payload: unknown, requestId: string): Promise<void>;
  /** Start deferring new sends. */
  defer(): void;
  /** Stop deferring and flush buffered sends in order; resolves once the
   * queue is empty ("deferred sync completion"). */
  resume(): Promise<void>;
  readonly deferred: boolean;
  pendingCount(): number;
}

/** Sync deferral gate: while the low-battery profile is active, sync sends
 * are queued locally instead of hitting the radio; resuming flushes them in
 * FIFO order without loss. */
export function createDeferringSendPort(inner: SendPortLike): DeferringSendPort {
  let deferred = false;
  const queue: { payload: unknown; requestId: string }[] = [];
  let flushing = false;
  return {
    async send(payload, requestId) {
      if (deferred) {
        queue.push({ payload, requestId });
        return;
      }
      await inner.send(payload, requestId);
    },
    defer() {
      deferred = true;
    },
    async resume() {
      deferred = false;
      if (flushing) return;
      flushing = true;
      try {
        const batch = queue.splice(0);
        for (const item of batch)
          await inner.send(item.payload, item.requestId);
      } finally {
        flushing = false;
      }
    },
    get deferred() {
      return deferred;
    },
    pendingCount() {
      return queue.length;
    },
  };
}

function formatIssues(issues: { path: (string | number | symbol)[]; message: string }[]) {
  return issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}
