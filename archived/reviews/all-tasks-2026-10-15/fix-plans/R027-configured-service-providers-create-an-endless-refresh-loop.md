# R027 — Configured service providers create an endless refresh loop

- **Priority:** P1
- **Original tasks:** T106, T111, T112, T113
- **Suggested owner:** Mobile account/billing/community/support providers
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Memoize each client and its token adapter by stable configuration, or construct it once outside render. Keep refresh effects stable across their own state updates.

## Evidence and failure scenario

**Source:** [apps/mobile/features/account/provider.tsx:31](../../../../apps/mobile/features/account/provider.tsx#L31)

**Trigger:** Mount AccountProvider, BillingProvider, CommunityProvider or SupportProvider with baseUrl and without an injected stable client; return successful JSON responses.

**Impact:** Each state update creates a new client, changes refresh identity and reruns the refresh effect. Requests and renders continue indefinitely; account busy-state updates can overlap requests. Enabling these services makes the app continuously hit the API.

**Review evidence:** All four providers construct create*Client in the render body, use client in refresh dependencies, and use refresh in an effect. Successful refresh stores fresh objects/arrays, causing the next render. The current root supplies no baseUrl, so this is conditional on configuring the supported service path.

**Evidence limit:** Confirmed by source-path and state/contract inspection; runtime reproduction not executed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T106, T111, T112, T113) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Stabilize client and token-adapter construction in all four affected providers using configuration-aware memoization or equivalent ownership.
3. Keep explicit refresh and real configuration changes working; clean up or ignore stale in-flight results after a client switch.
4. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] Mounting each provider with baseUrl settles after the intended initial fetches; state updates do not trigger endless requests.
- [ ] An explicit refresh works once; changing baseUrl/client updates the service without responses from the old client overwriting new state.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
