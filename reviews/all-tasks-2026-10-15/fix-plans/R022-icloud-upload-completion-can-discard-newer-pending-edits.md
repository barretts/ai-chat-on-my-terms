# R022 — iCloud upload completion can discard newer pending edits

- **Priority:** P1
- **Original tasks:** T100
- **Suggested owner:** T100 iCloud pending upload bookkeeping
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Remove a pending upload only if it still has the exact uploaded revision; retain newer local changes when applying stale cloud records. Serialize passes and persist pending identities for restart recovery.

## Evidence and failure scenario

**Source:** [packages/sync/icloud/src/index.ts:150](../../../packages/sync/icloud/src/index.ts#L150)

**Trigger:** Start publishing revision A; while saveRecords is awaiting the cloud, call noteLocalChange with newer revision B of the same entity; then let A finish.

**Impact:** Completion deletes the pending entry by entity key, removing B even though only A reached the cloud. B is also already in seen, so re-notifying the same change will not enqueue it again. Fetch similarly deletes pending changes for superseded incoming records. Newer local edits can be permanently omitted from sync.

**Review evidence:** publish snapshots chunk, awaits saveRecords, then unconditionally pending.delete(entityType:entityId). noteLocalChange can overwrite that key during the await. seen is set at enqueue. fetch treats superseded as crossed and deletes by recordName without comparing the pending revision.

**Evidence limit:** Confirmed async state transition by source inspection. T100 is in-progress shared code; no native CloudKit bridge/runtime was executed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T100) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Compare the exact uploaded revision with the current pending entry before deleting it on upload completion.
3. During fetch, preserve newer local pending edits when an older cloud record is superseded.
4. Inspect overlapping passes and restart persistence so the fix cannot drop newer work through a second completion path.
5. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] Enqueue B while upload A is in flight; completing A leaves B queued and B is subsequently uploaded.
- [ ] Fetching stale cloud A does not discard pending B; retries and concurrent passes preserve the newest revision.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
