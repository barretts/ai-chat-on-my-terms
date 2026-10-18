# R008 — Asynchronous acknowledgements leave later sync batches unsent

- **Priority:** P1
- **Original tasks:** T098, T098C
- **Suggested owner:** T098C transport and T098 composition
- **Status:** Follow-up implemented in working tree; runtime verification not run. See [implementation handoff](../blocker-fixes-follow-up.md).
- **Dependencies:** [R023](./R023-acknowledgements-of-old-sync-records-suppress-later-updates-with-the-same-identity.md)

## Outcome

Pump the next batch after an acknowledgement and schedule a bounded acknowledgement timeout/retry without overlapping send pumps.

## Evidence and failure scenario

**Source:** [packages/sync/core/composition/src/index.ts:190](../../../../packages/sync/core/composition/src/index.ts#L190)

**Trigger:** Enqueue 600 valid records, let sendBatch resolve before the WebSocket acknowledgement arrives, then deliver the acknowledgement for the first 500.

**Impact:** sendPending returns after the first unacknowledged send. onFrame handles the acknowledgement and returns without pumping the remaining batch. No acknowledgement timer is scheduled. The remaining 100 rows stay pending indefinitely and initialSyncDone may already be recorded.

**Review evidence:** transport/src/index.ts:167 returns when head is not yet acknowledged; composition/src/index.ts:190 calls handleAck and immediately returns; neither implementation schedules acknowledgement retries. The 600-record fixture invokes handleAck inside send, hiding asynchronous delivery. Follow-up: T103 syncOneConversation pumps after acknowledgements in its separate integration helper; the core SyncEngine onFrame path identified here remains unchanged. This finding is scoped to that core composition path.

**Evidence limit:** Confirmed by source control flow and fixture structure; real WebSocket scenario not executed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T098, T098C) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Fix the core SyncEngine acknowledgement path, not only the T103 helper.
3. Resume queued batches after asynchronous acknowledgements; implement bounded acknowledgement timeout/retry with one active send pump.
4. Make initial-sync completion depend on the actual required delivery state.
5. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] 600 records delivered with delayed acknowledgements send both the 500-record and 100-record batches.
- [ ] Lost acknowledgements retry within bounds; duplicate/late acknowledgements do not start overlapping pumps or lose work.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
