import { createId } from "./crypto";
import {
  createNativeGenerationSession,
  type GenerationSession,
} from "./generation-session-core";
export type {
  GenerationSession,
  OrphanedOwnerResult,
} from "./generation-session-core";

export async function createGenerationSession(): Promise<GenerationSession> {
  return createNativeGenerationSession(createId());
}
