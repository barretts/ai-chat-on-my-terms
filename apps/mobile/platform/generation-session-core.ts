import type { ChatGenerationOwner } from "@locallab/chat-engine-core";

export type OrphanedOwnerResult<T> =
  | { orphaned: false }
  | { orphaned: true; value: T };
export interface GenerationSession {
  readonly owner: ChatGenerationOwner;
  assertActive(): void;
  withOrphanedOwner<T>(
    owner: ChatGenerationOwner,
    work: () => Promise<T>,
  ): Promise<OrphanedOwnerResult<T>>;
  dispose(): Promise<void>;
}

// One registry for the running native JavaScript process, shared across route mounts.
const nativeOwners = new Set<string>();
export function createNativeGenerationSession(id: string): GenerationSession {
  if (nativeOwners.has(id))
    throw new Error("Generation session is already active");
  nativeOwners.add(id);
  let disposed = false;
  const assertActive = () => {
    if (disposed)
      throw new Error(
        "Generation session is closed. Reopen chat before sending.",
      );
  };
  return {
    owner: { id, scope: "mobile-chat", platform: "native" },
    assertActive,
    async withOrphanedOwner(owner, work) {
      assertActive();
      if (
        owner.scope !== "mobile-chat" ||
        owner.platform !== "native" ||
        nativeOwners.has(owner.id)
      )
        return { orphaned: false };
      nativeOwners.add(owner.id);
      try {
        return { orphaned: true, value: await work() };
      } finally {
        nativeOwners.delete(owner.id);
      }
    },
    async dispose() {
      disposed = true;
      nativeOwners.delete(id);
    },
  };
}
