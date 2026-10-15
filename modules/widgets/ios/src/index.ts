/**
 * T114 (AU-01, AU-02) — WidgetKit / Control Center / Live Activities
 * bridge contracts. The Swift side (WidgetKit extensions, ActivityKit
 * attributes, App Group container) compiles inside the Apple build and
 * is proven at T159E; everything here is the frozen data shape both
 * sides share.
 *
 * Invariant (card step 2): the App Group snapshot the extensions render
 * carries ONLY model classes, phases and numbers — every schema below is
 * strict, so a chat transcript, prompt, or secret key cannot be written
 * into the shared container even by mistake.
 */
import { z } from "zod";

/* ---------------- AU-01: quick-entry widgets and their routes ---------------- */

export const WidgetEntryKindSchema = z.enum(["new-chat", "camera", "news"]);
export type WidgetEntryKind = z.infer<typeof WidgetEntryKindSchema>;

/** Deep links the widgets open; the app registers the `locallab` scheme. */
export function widgetRouteUrl(kind: WidgetEntryKind): string {
  return `locallab://widget/${kind}`;
}

export function parseWidgetRouteUrl(
  url: string,
): { kind: WidgetEntryKind } | null {
  const parsed = z
    .string()
    .regex(/^locallab:\/\/widget\/(new-chat|camera|news)$/)
    .safeParse(url);
  if (!parsed.success) return null;
  return { kind: parsed.data.split("/").pop() as WidgetEntryKind };
}

/* ---------------- AU-02: Lock Screen / Dynamic Island progress ---------------- */

const slug = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/);
const percent = z.number().int().min(0).max(100);

/** Download progress shown on the Lock Screen / Dynamic Island. Only the
 * model CLASS (a public catalog identifier) is displayed — never a file
 * path, URL or key. */
export const DownloadActivityStateSchema = z
  .object({
    kind: z.literal("download"),
    activityId: slug,
    startedAt: z.string().datetime(),
    modelClass: slug,
    percent,
    finished: z.boolean(),
  })
  .strict();
export type DownloadActivityState = z.infer<
  typeof DownloadActivityStateSchema
>;

/** Live Activity for an in-app generation. `preview` deliberately does
 * not exist: a generation activity shows only that a generation of some
 * model class is running. */
export const GenerationActivityStateSchema = z
  .object({
    kind: z.literal("generation"),
    activityId: slug,
    startedAt: z.string().datetime(),
    modelClass: slug,
    finished: z.boolean(),
  })
  .strict();
export type GenerationActivityState = z.infer<
  typeof GenerationActivityStateSchema
>;

export const ActivityStateSchema = z.discriminatedUnion("kind", [
  DownloadActivityStateSchema,
  GenerationActivityStateSchema,
]);
export type ActivityState = z.infer<typeof ActivityStateSchema>;

/* ---------------- App Group snapshot (step 2) ---------------- */

export const WidgetSnapshotSchema = z
  .object({
    generatedAt: z.string().datetime(),
    /** Model classes the user pinned for the news/new-chat widgets. */
    pinnedModelClasses: z.array(slug).max(8),
    /** Latest visible activity per kind, or null when nothing runs. */
    download: DownloadActivityStateSchema.nullable(),
    generation: GenerationActivityStateSchema.nullable(),
    /** True when an update is available (badge only; no URLs). */
    updateAvailable: z.boolean(),
  })
  .strict();
export type WidgetSnapshot = z.infer<typeof WidgetSnapshotSchema>;

/* ---------------- bridge implemented by the native side ---------------- */

export interface WidgetsBridge {
  /** Writes the App Group snapshot every widget extension reads. */
  writeSnapshot(snapshot: unknown): Promise<void>;
  startActivity(state: unknown): Promise<string | null>;
  updateActivity(state: unknown): Promise<void>;
  endActivity(activityId: string): Promise<void>;
  /** ActivityKit's live activities as {id, state} rows. */
  listActivities(): Promise<{ id: string; state: unknown }[]>;
}

export function parseWidgetSnapshot(raw: unknown): WidgetSnapshot {
  return WidgetSnapshotSchema.parse(raw);
}

export function parseActivityStates(
  raw: readonly unknown[],
): ActivityState[] {
  return raw.map((item) => ActivityStateSchema.parse(item));
}

/* ---------------- step 3: reconcile after foreground/relaunch ---------------- */

export interface ReconcileResult {
  keep: ActivityState[];
  end: string[];
}

/**
 * After the app returns to foreground (or relaunches), finish any live
 * activity whose job has already completed or whose state is no longer
 * knowable, and keep genuinely running ones. `now` bounds staleness: a
 * live activity older than `maxAgeMs` that never reported `finished`
 * belonged to a dead process and must end, otherwise the Lock Screen
 * would lie forever.
 */
export function reconcileActivities(
  activities: readonly ActivityState[],
  options: { now: Date; maxAgeMs: number },
): ReconcileResult {
  const keep: ActivityState[] = [];
  const end: string[] = [];
  for (const activity of activities) {
    if (activity.finished) {
      end.push(activity.activityId);
      continue;
    }
    const ageMs =
      options.now.getTime() - new Date(activity.startedAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs > options.maxAgeMs)
      end.push(activity.activityId);
    else keep.push(activity);
  }
  return { keep, end };
}
