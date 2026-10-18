# R006 — Initial copy tombstones the source records it must retain

- **Priority:** P1
- **Original tasks:** T098, T098B
- **Suggested owner:** T098 sync composition
- **Status:** Follow-up implemented in working tree; runtime verification not run. See [implementation handoff](../blocker-fixes-follow-up.md).
- **Dependencies:** [R008](./R008-asynchronous-acknowledgements-leave-later-sync-batches-unsent.md), [R023](./R023-acknowledgements-of-old-sync-records-suppress-later-updates-with-the-same-identity.md)

## Outcome

Coordinate the copy using a source snapshot/membership manifest and atomically replace the target with those members, deleting only rows absent from the source.

## Evidence and failure scenario

**Source:** [packages/sync/core/composition/src/index.ts:248](../../../../packages/sync/core/composition/src/index.ts#L248)

**Trigger:** Choose copy-phone or copy-mac when both stores share entity IDs, or let the source deliver before the target calls runInitialSync.

**Impact:** replaceLocalSet tombstones every live target row with a new wall-clock revision. Source rows retain their older revisions, so shared IDs cannot be restored; source-first delivery is deleted after receipt. Initial sync is then marked done with missing conversations/messages.

**Review evidence:** runInitialSync separately sends liveSourceRecords or calls replaceLocalSet. replaceLocalSet deletes every live snapshot entry without a source membership set. envelope preserves old revisions, and MergeStore suppresses records older than existing tombstones. Existing copy fixtures run target first and use disjoint IDs.

**Evidence limit:** Confirmed by source ordering and merge rules; adversarial scenario not executed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T098, T098B) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Define a coordinated source snapshot and target replacement boundary, including shared IDs and source/target delivery order.
3. Retain source members regardless of their older revisions; delete only target-only members. Commit replacement and completion state consistently.
4. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] Copy-phone and copy-mac preserve source data with overlapping entity IDs in either delivery order.
- [ ] Target-only records disappear; interrupted/retried copy converges and does not mark completion prematurely.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
