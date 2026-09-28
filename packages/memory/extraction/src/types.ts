import type { z } from "zod";
import type {
  MemoryEntrySchema,
  TombstoneSchema,
} from "@locallab/contracts/entities";

export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
export type MemoryTombstone = z.infer<typeof TombstoneSchema>;
export interface MemoryScope {
  scope: MemoryEntry["scope"];
  scopeId: string | null;
}
/** The caller resolves conversation and Persona consent before creating this policy. */
export interface MemoryPolicy {
  extract: boolean;
  inject: boolean;
  scope: MemoryScope;
  includeGlobal: boolean;
  selectedMemoryIds?: readonly string[];
}
export interface MemoryPreferences {
  extractionEnabled: boolean;
  injectionEnabled: boolean;
}
export interface MemorySource {
  conversationId: string;
  messageId: string;
  runId: string;
  quote: string;
  extractor: string;
}
export interface SavedMemory {
  entry: MemoryEntry;
  sourceConversationId: string | null;
  source: MemorySource | null;
  deletedAt: string | null;
}
/** Existing named namespaces without a known frozen scope require user review. */
export interface LegacyMemory {
  id: string;
  namespace: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}
export interface MemoryChange {
  sequence: number;
  operation: "upsert" | "tombstone";
  entity: MemoryEntry | MemoryTombstone;
}
export interface EligibleTurn {
  runId: string;
  conversationId: string;
  user: { messageId: string; text: string };
  assistant: { messageId: string; text: string };
}
export interface MemoryCandidate {
  content: string;
  sourceMessageId: string;
  quote: string;
}
export interface MemoryExtractionPort {
  readonly identity: string;
  /** A canceled result may settle before provider cleanup. This promise must retain that work. */
  readonly resourcesDrained?: Promise<void>;
  extract(input: {
    turn: EligibleTurn;
    existing: readonly MemoryEntry[];
    maximumCandidates: number;
    signal: AbortSignal;
  }): Promise<readonly MemoryCandidate[]>;
}
export type MemoryExtractionResult =
  | { status: "completed"; saved: readonly SavedMemory[] }
  | {
      status: "skipped";
      reason: "disabled" | "ineligible" | "already-processed" | "queue-full";
    }
  | { status: "canceled" }
  | { status: "failed"; message: string };

export const MEMORY_LIMITS = Object.freeze({
  turnCharacters: 16_000,
  outputCharacters: 24_000,
  candidates: 8,
  contentCharacters: 1_024,
  quoteCharacters: 2_048,
  existingEntries: 64,
  promptCharacters: 8_000,
  promptEntries: 24,
  pendingExtractions: 4,
  resourceAdmissionMs: 5_000,
});
