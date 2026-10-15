# R012 — Hugging Face enqueue API rejects its declared revision argument

- **Priority:** P1
- **Original tasks:** T033
- **Suggested owner:** T033 model import lifecycle
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Type the argument as Revision and pass that validated object to JobStore.create, or explicitly parse a serialized revision before validation if serialization is the intended API.

## Evidence and failure scenario

**Source:** [packages/models/imports/src/index.ts:260](../../../packages/models/imports/src/index.ts#L260)

**Trigger:** Call ModelLifecycleRegistry.enqueueHuggingFace with any string revision as required by its public TypeScript signature.

**Impact:** RevisionSchema requires a strict object containing wallMs, counter and deviceId, so every correctly typed string argument throws before jobs.create. The package's Hugging Face enqueue path is unusable to typed consumers.

**Review evidence:** enqueueHuggingFace declares revision: string at line 253 and then calls RevisionSchema.parse(revision) at line 260. The contract in packages/contracts/src/identity.ts requires an object. Existing descriptor tests never call enqueueHuggingFace.

**Evidence limit:** Confirmed signature/schema contradiction; method not executed and mobile Hugging Face UI is not currently mounted. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T033) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Decide whether the public API accepts a Revision object or serialized input based on callers and JobStore contracts.
3. Align its type and validation, then update consumers without type assertions that conceal the mismatch.
4. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] A correctly typed revision successfully creates a Hugging Face enqueue job.
- [ ] Malformed revisions fail before creating a partial job; existing descriptor handling remains compatible.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
