# R002 — Sync core packages are excluded from the workspace

- **Priority:** P1
- **Original tasks:** T001, T098, T098B, T098C, T100
- **Suggested owner:** Workspace configuration
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Add packages/sync/core/* to the workspace and regenerate the lockfile.

## Evidence and failure scenario

**Source:** [pnpm-workspace.yaml:6](../../../pnpm-workspace.yaml#L6)

**Trigger:** Resolve @locallab/sync-merge, sync-transport or sync-composition through a clean pnpm workspace install.

**Impact:** The new packages live at packages/sync/core/*, one directory deeper than packages/*/*. No matching workspace glob exists. The in-progress sync-icloud package already declares sync-merge as workspace:*, making dependency resolution fail on a clean install.

**Review evidence:** pnpm-workspace.yaml includes packages/*, packages/*/*, packages/chat/engine/* and other explicit deep patterns but no packages/sync/core/*. packages/sync/icloud/package.json declares @locallab/sync-merge: workspace:*.

**Evidence limit:** Confirmed by current path and manifest inspection; installer not executed. The earlier in-progress qualifier is superseded by this follow-up source review. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T001, T098, T098B, T098C, T100) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Add the actual sync-core package depth to workspace membership; inspect all three package manifests and their workspace consumers.
3. Regenerate the pinned pnpm lockfile and confirm sync-icloud can resolve sync-merge. Coordinate the lockfile with R001.
4. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] Workspace discovery includes sync-merge, sync-transport and sync-composition.
- [ ] A clean frozen-lockfile install resolves the sync workspace dependencies.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
