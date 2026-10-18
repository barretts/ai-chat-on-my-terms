# R025 — Backup restore inserts child tables before their parents

- **Priority:** P1
- **Original tasks:** T110
- **Suggested owner:** T110 database restore
- **Status:** Implemented in working tree; runtime verification not run. See [implementation handoff](../blocker-fixes-follow-up.md).
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Plan restore around foreign-key dependencies: clear safely, insert parents before children, and validate all references before commit. Account for cascading deletes and cyclic dependencies.

## Evidence and failure scenario

**Source:** [apps/mobile/features/backup/db-snapshot.ts:68](../../../../apps/mobile/features/backup/db-snapshot.ts#L68)

**Trigger:** Back up a configured provider and its model, then restore into a clean initialized database with foreign keys enabled.

**Impact:** The models table sorts before providers, so inserting its provider reference fails before the parent is restored. Other child-first tables fail similarly. On an existing database, later parent deletes can also cascade away children already restored.

**Review evidence:** snapshotDatabase orders sqlite_master by name; restoreTransaction deletes and inserts each table in archive order. models.provider_id references providers(id). No dependency ordering or deferred constraint handling is present.

**Evidence limit:** Confirmed by source-path and state/contract inspection; runtime reproduction not executed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T110) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Enumerate actual schema dependencies, cascading deletes and potential cycles before choosing restore ordering.
3. Separate safe clearing from insertion; restore parents before children or use a justified transactional strategy that preserves integrity.
4. Validate restored references before commit and retain rollback on every error.
5. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] A backup with providers, models, conversations, messages and runs restores into a clean database with foreign keys enabled.
- [ ] Restore over populated data preserves every backed-up row; corrupt references roll back without damaging the original database.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
