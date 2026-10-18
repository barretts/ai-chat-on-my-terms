# R003 — Saving a group deadlocks the app database queue

- **Priority:** P1
- **Original tasks:** T055, T049
- **Suggested owner:** T055 group configuration
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Pass the supplied transaction port into the callback and perform every room and participant write on that port.

## Evidence and failure scenario

**Source:** [packages/groups/config/src/index.ts:294](../../../../packages/groups/config/src/index.ts#L294)

**Trigger:** Save a valid room from GroupSetupPanel using the app's sharedMobileDatabase connection.

**Impact:** dbTransaction awaits a transaction callback that issues writes through the outer this.db. The outer adapter queues those writes behind the transaction that is waiting for them. The transaction never commits and every later database operation, including chat sends, waits indefinitely.

**Review evidence:** saveRoom calls dbTransaction(this.db, async () => ...) and uses this.db.runAsync inside the callback. dbTransaction passes work directly to withTransactionAsync without exposing its transaction argument. apps/mobile/platform/database.ts queues outer operations and supplies a separate transaction-scoped port.

**Evidence limit:** Confirmed by source control-flow inspection; runtime reproduction not executed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T055, T049) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Change the transaction helper to pass its scoped database port to the callback.
3. Use that port for every saveRoom operation, including participant replacement. Preserve atomic rollback. Inspect the shared queue adapter before choosing a fallback.
4. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] Saving a room with multiple participants resolves on the real queued adapter.
- [ ] A subsequent database query/chat write resolves. A failed participant write rolls back the room save.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
