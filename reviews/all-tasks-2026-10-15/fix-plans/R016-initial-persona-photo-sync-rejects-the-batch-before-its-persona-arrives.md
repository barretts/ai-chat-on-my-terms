# R016 — Initial Persona photo sync rejects the batch before its Persona arrives

- **Priority:** P1
- **Original tasks:** T099, T098
- **Suggested owner:** T099 Persona sync admission and T098 composition
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** [R006](./R006-initial-copy-tombstones-the-source-records-it-must-retain.md)

## Outcome

Validate selected incoming Persona ownership for the full batch before applying photo records, or order/admit dependencies explicitly while preserving privacy checks and transactional acknowledgement semantics.

## Evidence and failure scenario

**Source:** [packages/sync/core/composition/src/index.ts:198](../../../packages/sync/core/composition/src/index.ts#L198)

**Trigger:** Perform initial merge/copy sync from a source with a selected Persona and its selected photo to a receiver that has neither row.

**Impact:** Source snapshots sort attachment records before persona records. The receiver photo gate requires an existing local Persona reference, so it rejects the first attachment before applying the Persona later in the same batch. No acknowledgement is sent; retrying the unchanged batch cannot converge and also blocks following chat records.

**Review evidence:** MergeStore.snapshot sorts entityType/entityId keys; liveSourceRecords preserves that order. onFrame admits and applies one record at a time, throwing before acknowledgement. personaTierGate attachment admission only uses ctx.attachmentOwner, which is a local lookup. No pending-batch ownership preflight or dependency ordering exists.

**Evidence limit:** Confirmed by source ordering and admission tracing; two-device execution not performed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T099, T098) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Preflight ownership/admission for incoming Persona and attachment records across the batch, or establish explicit dependency order.
3. Use incoming selected Persona ownership without permitting unselected/private photos; make apply/ack behavior safe on partial failure.
4. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] An empty receiver accepts a selected Persona and its photo even when the attachment sorts first.
- [ ] Unselected or foreign photos are still rejected; retries converge without stranding subsequent chats.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
