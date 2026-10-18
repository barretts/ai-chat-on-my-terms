# R026 — Backup object routes allow cross-user overwrite and deletion

- **Priority:** P1
- **Original tasks:** T110
- **Suggested owner:** T110 backup storage authorization
- **Status:** Implemented in working tree; runtime verification not run. See [implementation handoff](../blocker-fixes-follow-up.md).
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Require authenticated account ownership for every object operation, scope storage keys to the owner, and enforce entitlement per requesting account.

## Evidence and failure scenario

**Source:** [services/api/features/backup/index.ts:81](../../../../services/api/features/backup/index.ts#L81)

**Trigger:** Register these routes and upload a backup under a valid object ID. Another caller sends DELETE or PUT using that same ID.

**Impact:** The second caller can destroy or replace the backup without its passphrase or owner session. Encryption protects plaintext, not availability or ownership.

**Review evidence:** GET, PUT and DELETE use the global object ID directly. There is no session resolution or owner check. The optional ProGate takes no request/user argument and defaults to allowed. The mobile object-store client sends no account credentials.

**Evidence limit:** Confirmed by source-path and state/contract inspection; runtime reproduction not executed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T110) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Bind each backup operation to a verified account and scope object keys/metadata to that owner.
3. Enforce per-request entitlement without trusting UI state; fail closed when auth is unavailable.
4. Update the mobile object-store adapter to supply credentials and define compatibility for existing objects without making them public.
5. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] Owner A can upload/download/delete its object; anonymous callers and account B cannot read, replace or delete it.
- [ ] Two users can use the same displayed object ID without collision; failed auth leaves stored ciphertext unchanged.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
