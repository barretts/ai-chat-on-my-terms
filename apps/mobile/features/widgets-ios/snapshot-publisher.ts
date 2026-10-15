/** Device-side snapshot publishing for the iOS widgets (AU-01/AU-02).
 * On non-Apple builds no bridge is wired and every operation is a no-op.
 * Everything written to the App Group container passes the strict
 * contract from `@locallab/widgets-ios` first, so chat text, prompts and
 * keys are structurally excluded (card step 2). */

import {
  ActivityStateSchema,
  WidgetSnapshotSchema,
  reconcileActivities,
  type ActivityState,
  type WidgetSnapshot,
  type WidgetsBridge,
} from "@locallab/widgets-ios";

export interface WidgetSnapshotPublisher {
  publishSnapshot(snapshot: unknown): Promise<boolean>;
  startActivity(state: unknown): Promise<string | null>;
  finishActivity(state: unknown): Promise<void>;
  reconcile(options?: { maxAgeMs?: number }): Promise<number>;
}

export function createWidgetSnapshotPublisher(options: {
  bridge?: WidgetsBridge;
  now?: () => Date;
}): WidgetSnapshotPublisher {
  const bridge = options.bridge;
  const now = options.now ?? (() => new Date());

  return {
    async publishSnapshot(snapshot) {
      if (bridge === undefined) return false;
      const parsed = WidgetSnapshotSchema.safeParse(snapshot);
      if (!parsed.success) return false;
      await bridge.writeSnapshot(parsed.data satisfies WidgetSnapshot);
      return true;
    },
    async startActivity(state) {
      if (bridge === undefined) return null;
      const parsed = ActivityStateSchema.safeParse(state);
      if (!parsed.success) return null;
      return await bridge.startActivity(parsed.data satisfies ActivityState);
    },
    async finishActivity(state) {
      if (bridge === undefined) return;
      const parsed = ActivityStateSchema.safeParse(state);
      if (!parsed.success) return;
      await bridge.endActivity(parsed.data.activityId);
    },
    async reconcile({ maxAgeMs = 2 * 60 * 60 * 1000 } = {}) {
      if (bridge === undefined) return 0;
      const listed = await bridge.listActivities();
      const states: ActivityState[] = [];
      const staleIds: string[] = [];
      for (const row of listed) {
        const parsed = ActivityStateSchema.safeParse(row.state);
        if (parsed.success) states.push(parsed.data);
        // Anything the contract cannot read belongs to an older app
        // version; end it so the Lock Screen never shows a frozen row.
        else staleIds.push(row.id);
      }
      const plan = reconcileActivities(states, { now: now(), maxAgeMs });
      for (const id of [...plan.end, ...staleIds])
        await bridge.endActivity(id);
      return plan.end.length + staleIds.length;
    },
  };
}
