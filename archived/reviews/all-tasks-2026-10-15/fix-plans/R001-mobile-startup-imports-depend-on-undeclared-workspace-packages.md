# R001 — Mobile startup imports depend on undeclared workspace packages

- **Priority:** P1
- **Original tasks:** T001, T049, T051, T053, T055, T079, T092
- **Suggested owner:** Mobile composition and dependency wiring
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** [R002](./R002-sync-core-packages-are-excluded-from-the-workspace.md)

## Outcome

Declare every runtime workspace dependency in its consuming package and regenerate the pinned pnpm lockfile.

## Evidence and failure scenario

**Source:** [apps/mobile/package.json:12](../../../../apps/mobile/package.json#L12)

**Trigger:** Install dependencies in a fresh checkout and bundle the /chat route.

**Impact:** The chat startup graph imports groups-config, personas-generator, memory-scope, speech-cloud and media packages that the mobile manifest does not declare. Local manually created node_modules junctions are not reproduced by a clean install, so bundling can fail before the app opens.

**Review evidence:** apps/mobile/composition/chat/screen.tsx imports groups-config at line 50 and personas-generator at line 119; persona-memory.ts imports memory-scope; voice/container.ts imports speech-cloud; composition/media/providers.ts imports media-engine and media-integration. These packages are absent from apps/mobile/package.json and the lockfile importers. Existing local links are Windows junctions. Follow-up: root _layout.tsx now imports AppLockProvider, whose runtime @locallab/app-lock import is also absent from the mobile manifest. Added themes/localization/workflow dependencies do not resolve the earlier missing runtime packages.

**Evidence limit:** Confirmed by source and dependency-manifest inspection; clean install/bundle not executed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T001, T049, T051, T053, T055, T079, T092) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Trace runtime imports from the root layout and chat routes, including App Lock, backup, groups, Persona memory, cloud speech and media composition. Check each consumer manifest, not just the mobile manifest.
3. Declare missing workspace dependencies and regenerate the lockfile with the pinned package manager. Do not rely on manually created node_modules junctions.
4. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] A clean workspace install resolves every runtime import without hand-created links.
- [ ] Root layout and /chat bundle from that installation; the lockfile remains consistent.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
