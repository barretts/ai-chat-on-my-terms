# R024 — App Lock permanently gates sessions that have no PIN configured

- **Priority:** P1
- **Original tasks:** T108, T001
- **Suggested owner:** T108 App Lock core and root provider
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Track whether App Lock is actually enabled and challenge only when a valid PIN record exists; make no-record unlock explicitly restore an unlocked state.

## Evidence and failure scenario

**Source:** [modules/app-lock/src/index.ts:190](../../../modules/app-lock/src/index.ts#L190)

**Trigger:** Launch without a PIN, background longer than the default one-minute grace, then foreground the app and attempt Unlock.

**Impact:** foregrounded sets locked=true without checking whether a lock record exists. unlockWithPin returns ok when there is no record but never clears locked. The root-mounted provider displays its blocking gate to ordinary non-PIN users; only restarting the session clears it.

**Review evidence:** createLockSession.foregrounded gates only elapsed time. unlockWithPin returns immediately for record===null before clearing locked. AppLockProvider listens to all app-state changes and syncs this state regardless of hasLock; RootLayout mounts it around every route.

**Evidence limit:** Confirmed source state transitions; app/device reproduction not executed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T108, T001) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Track valid PIN-enabled state when deciding foreground challenges; keep enabled locks secure through preference changes and removal.
3. Ensure a no-record unlock clears any stale locked state and synchronize the root provider gate.
4. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] A user without a PIN remains usable after backgrounding beyond the grace period.
- [ ] An enabled PIN still challenges on cold start/grace expiry, rejects a wrong PIN and unlocks correctly with supported methods.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
