# R020 — Relay Docker deployment cannot install the pnpm workspace

- **Priority:** P1
- **Original tasks:** T094
- **Suggested owner:** T094 relay deployment
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** [R002](./R002-sync-core-packages-are-excluded-from-the-workspace.md)

## Outcome

Build/install with the pinned pnpm workspace and lockfile, or produce an explicit deployable package bundle with resolved workspace dependencies.

## Evidence and failure scenario

**Source:** [services/relay/Dockerfile:14](../../../services/relay/Dockerfile#L14)

**Trigger:** Run the documented repository-root Docker build or docker-compose.relay.yml build.

**Impact:** The image runs npm ci although no package-lock exists. Installation fails before the relay can start. The root also has no npm workspace configuration, so merely supplying a lock would not link the copied workspace:* relay dependencies.

**Review evidence:** Dockerfile copies package.json/package-lock.json* and runs npm ci --omit=dev. The current root has pnpm-lock.yaml and packageManager pnpm@8.15.9, no package-lock.json, and workspace membership is declared in pnpm-workspace.yaml rather than root npm workspaces.

**Evidence limit:** Confirmed build inputs and install-command mismatch; Docker build not executed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T094) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Replace npm-ci assumptions with the pinned pnpm workspace deployment flow or an explicit resolved deploy bundle.
3. Copy the actual workspace/lock inputs and runtime dependency closure; check the documented compose build context.
4. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] The documented repository-root image build installs from the pinned lockfile without a package-lock.
- [ ] The built container starts the relay and resolves all runtime workspace imports.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
