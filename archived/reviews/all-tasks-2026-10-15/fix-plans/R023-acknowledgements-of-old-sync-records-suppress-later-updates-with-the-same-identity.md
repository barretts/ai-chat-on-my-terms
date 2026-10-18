# R023 — Acknowledgements of old sync records suppress later updates with the same identity

- **Priority:** P1
- **Original tasks:** T098C, T098, T099
- **Suggested owner:** T098C acknowledgement identity
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Scope acknowledgements to a unique change/batch identity or revision, clear completed-window state safely, and reject stale acknowledgements from earlier batches.

## Evidence and failure scenario

**Source:** [packages/sync/core/transport/src/index.ts:214](../../../../packages/sync/core/transport/src/index.ts#L214)

**Trigger:** Send and acknowledge record ID X, then enqueue a changed or deleted entity using record ID X with a newer revision.

**Impact:** ackedIds retains X forever. The next batch is immediately considered fully acknowledged and removed without sending. Stable record IDs are deliberately reused by initial snapshot replay, and tombstones commonly use the entity ID. Reusing an acknowledged identity silently drops subsequent changes.

**Review evidence:** handleAck adds IDs to an unbounded set and never removes them. isFullyAcked checks record.id only, independent of revision/batch. sendPending shifts a fully acknowledged head before calling send. Sync composition envelopes reuse row.recordId and replacement tombstones use entityId.

**Evidence limit:** Confirmed queue/ack state-machine defect by source inspection; live transport not executed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T098C, T098, T099) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Define acknowledgement identity per batch/change/revision and update serialization and both endpoints if needed.
3. Prevent old acknowledgements from satisfying newly queued work with the same entity ID; bound completed acknowledgement state.
4. Coordinate transport changes with R008 and copy behavior in R006.
5. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] Acknowledging X revision A does not suppress sending X revision B or its later tombstone.
- [ ] Stale/duplicate acknowledgements cannot remove a newer batch; completed acknowledgement bookkeeping does not grow without bound.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
