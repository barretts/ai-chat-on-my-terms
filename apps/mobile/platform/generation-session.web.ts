import { createId } from "./crypto.web";
import type { GenerationSession } from "./generation-session-core";
export type {
  GenerationSession,
  OrphanedOwnerResult,
} from "./generation-session-core";

const lockName = (id: string) => `locallab:mobile-chat:generation-owner:${id}`;

/** The browser releases this owner lease on document destruction, including hard reload/crash. */
export async function createGenerationSession(): Promise<GenerationSession> {
  const locks = globalThis.navigator?.locks;
  if (!locks)
    throw new Error(
      "This browser cannot safely recover interrupted chat. Open the preview in Chrome or Edge.",
    );
  const owner = {
    id: createId(),
    scope: "mobile-chat",
    platform: "web",
  } as const;
  let resolveHold!: () => void;
  const hold = new Promise<void>((resolve) => {
    resolveHold = resolve;
  });
  let resolveAcquired!: () => void;
  let rejectAcquired!: (error: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });
  const held = locks.request(lockName(owner.id), async () => {
    resolveAcquired();
    await hold;
  });
  void held.catch(rejectAcquired);
  await acquired;
  let disposed = false;
  const assertActive = () => {
    if (disposed)
      throw new Error(
        "Generation session is closed. Reopen chat before sending.",
      );
  };
  return {
    owner,
    assertActive,
    async withOrphanedOwner(oldOwner, work) {
      assertActive();
      if (oldOwner.scope !== "mobile-chat" || oldOwner.platform !== "web")
        return { orphaned: false };
      return locks.request(
        lockName(oldOwner.id),
        { ifAvailable: true },
        async (lock) => {
          if (!lock) return { orphaned: false };
          return { orphaned: true, value: await work() };
        },
      );
    },
    async dispose() {
      disposed = true;
      resolveHold();
      await held;
    },
  };
}
