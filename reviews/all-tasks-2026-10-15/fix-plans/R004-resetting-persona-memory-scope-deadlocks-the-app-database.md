# R004 — Resetting Persona memory scope deadlocks the app database

- **Priority:** P1
- **Original tasks:** T053, T049
- **Suggested owner:** T053 Persona memory scope
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Accept the transaction callback parameter and use that scoped port for both DELETE statements.

## Evidence and failure scenario

**Source:** [packages/memory/scope/src/index.ts:283](../../../packages/memory/scope/src/index.ts#L283)

**Trigger:** Call SQLitePersonaMemoryScope.resetPersona on the shared mobile database.

**Impact:** The transaction callback awaits this.db.runAsync on the outer queue instead of the supplied transaction connection. Its writes wait for the transaction to finish while the transaction waits for its writes, permanently blocking the shared database queue.

**Review evidence:** resetPersona calls this.db.withTransactionAsync(async () => ...) and both DELETE statements use this.db. The shared database adapter queues external operations after the active transaction.

**Evidence limit:** Confirmed by source control-flow inspection. No current mobile UI caller was found; this is a blocker in the package reset API, not an observed UI freeze. Runtime reproduction not executed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T053, T049) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Accept the transaction-scoped port in resetPersona and issue both DELETEs through it.
3. Preserve Persona and conversation isolation; establish the package API caller separately from current UI wiring.
4. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] resetPersona resolves on the shared queued database adapter and subsequent work is not blocked.
- [ ] Both intended memory sets are cleared atomically; unrelated Persona memory survives.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
