# Memory extraction

This package implements ME-01, ME-02, ME-03 and ER-08. It uses an injected generation provider; it never substitutes inferred facts when generation fails.

## Composition

1. Construct `SQLiteMemoryStore` with the shared SQLite port, initialize it, and call `recoverInterruptedExtractions()` once at startup. The port must serialize transactions across all feature owners. Transaction callbacks use the passed scoped port for every nested read/write; consent callbacks can call `store.preferences(transaction)`.
2. Resolve saved preferences and Persona/conversation privacy into a `MemoryPolicy`. `extract` and `inject` are explicit consent decisions. Private Persona policies use that Persona's scope ID and `includeGlobal: false`; they never write into the global pool.
3. Resolve `store.promptContext(policy)` before preparing a foreground prompt. It returns a bounded system context containing facts labeled as untrusted reference data, or `null`.
4. Construct `ProviderMemoryExtractor` from the exact selected `ProviderPort`, provider connection ID and model ID. Credentials remain inside the provider adapter.
5. After consuming the foreground run's **completed** terminal event, enqueue its persisted `runId`, original `userMessageId`, and `conversationId` with `MemoryExtractionCoordinator.enqueueCompleted`. Supply `isStillAllowed` to recheck consent after background generation.
6. Await `coordinator.cancelPending()` before a foreground send or runtime/provider switch. It cancels durable jobs and waits up to five seconds for actual provider cleanup; an exported `MemoryResourcesBusyError` prevents foreground admission when cleanup is still pending. Timing out does not release the resource gate. On suspension use `cancelPending({ waitForResources: false })` to settle durable cancellation promptly. Await `coordinator.dispose()` before closing the database; disposal waits for actual resource drainage.

`ProviderMemoryExtractor.resourcesDrained` settles only after its in-flight `next()` and iterator cleanup both end. A canceled extraction result can settle earlier. The coordinator retains the raw extraction operation and any declared drainage, so another queued background extraction cannot occupy the same runtime prematurely. Its `resourcesDrained` property covers the current queue and retained provider work. Custom extraction ports can expose an additional `resourcesDrained` promise; without one, their raw `extract()` promise is the cleanup boundary, even when an abortable durable wait has already settled.

Completed eligibility is checked again before the transaction commits. Canceled, failed, queued/running, empty visible replies and oversized turns are ineligible. Regenerated runs retain their original user message ID in durable run metadata. Legacy runs are accepted only when their user message belongs to that run.

## Storage and sync

The existing `memory_items` columns remain the projection. `metadata_json` version 1 contains `contentKey`, revision, scope, scope ID, frozen provenance, and a local source descriptor `{ conversationId, messageId, runId, quote, extractor }`. Source links are resolved against actual local message rows.

`MEMORY_EXTRACTION_SCHEMA_SQL` adds an indexed content key, durable extraction claims, local preferences, a persistent HLC clock and a revision journal. The coordinator registers this SQL with the shared migration allocator. Valid legacy saved entries retain their ID and content when upgraded. Known Persona/conversation namespaces or explicit old scope metadata retain their scope. Unknown named pools and old entries marked private without a known scope remain stored, excluded from prompts, and listed separately for explicit review or deletion under Data / Memory. `adoptLegacy` assigns the scope chosen by the user while preserving the original identity; it never runs automatically.

Each create/edit/delete records a frozen `MemoryEntrySchema` or `TombstoneSchema` revision in the same transaction. `listChanges` exposes bounded cursor batches for an authorized sync transport. `applyChange` preserves peer identities and revisions, rejects creation-time/scope mutation, and applies equal-revision tombstones before updates. Tombstones received before a missing entity also prevent older resurrection. Sync transport and opt-in selection remain the coordinator's responsibility.

## Bounds and grounding

Only persisted `text` parts from the eligible user and final assistant are sent to extraction. Reasoning, tools, sources, files and logs are excluded. Input is bounded to 16,000 turn characters and 64 existing facts within 8,000 content characters. Each fact is at most 1,024 characters. Extraction accepts at most eight candidates, 24,000 generated output characters, 20,000 stream events, and a 45-second default timeout. Each accepted candidate must name the original user message and quote its visible text exactly. Recognizable credential values are rejected. A four-item, serial background queue prevents unbounded provider work.

Exact normalized duplicates are suppressed using the indexed content key. The extraction model is responsible for semantic redundancy decisions. Deleted facts remain local tombstones and are excluded from both prompt injection and the extraction provider's existing-facts input. Local duplicate lookup prevents them from being automatically recreated in the same scope. Prompt resolution deduplicates permitted content and caps it at 24 facts / 8,000 content characters.

## Evidence

Run `tools/run-pnpm.ps1 --filter @locallab/memory-extraction test` and `typecheck` from the workspace root. Fixtures verify orchestration and wire behavior; they do not establish extraction quality on a live model. Native UI/device and live local/remote model evidence are recorded separately.
