# R018 — ComfyUI rejects successful prompt submissions with empty node_errors

- **Priority:** P1
- **Original tasks:** T086, T087, T092
- **Suggested owner:** T086 ComfyUI adapter
- **Status:** Implemented in working tree; runtime verification not run. See [implementation handoff](../blocker-fixes-follow-up.md).
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Distinguish actual prompt rejection/error from an empty diagnostics map and retain prompt_id for every accepted submission.

## Evidence and failure scenario

**Source:** [packages/media/comfyui/src/index.ts:368](../../../packages/media/comfyui/src/index.ts#L368)

**Trigger:** Submit a valid graph to a normal ComfyUI /prompt endpoint returning {prompt_id,number,node_errors:{}}.

**Impact:** The empty object is truthy, so the adapter throws malformed before recording prompt_id or following outputs. Every successful submission is reported failed while the server may still generate the image; retries can submit additional unwanted work.

**Review evidence:** run checks if (promptRecord.node_errors) and throws. The official server successful branch queues the prompt and returns node_errors: valid[3], an object: https://github.com/Comfy-Org/ComfyUI/blob/master/server.py . Fixtures omitting this field do not model this response.

**Evidence limit:** Source tracing against official ComfyUI server; real backend execution not performed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T086, T087, T092) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Parse accepted prompt responses separately from rejected responses; do not treat an empty node_errors object as rejection.
3. Retain prompt_id for accepted jobs and preserve real validation error details.
4. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] A normal response containing prompt_id, number and node_errors:{} proceeds to output tracking.
- [ ] Actual rejected prompts fail clearly; accepted jobs are not resubmitted because their diagnostics map is empty.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
