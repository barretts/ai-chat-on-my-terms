# R019 — Applying LoRA rewires the default graph VAE to a CLIP output

- **Priority:** P1
- **Original tasks:** T086
- **Suggested owner:** T086 LoRA graph transformation
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Rewrite only output slots 0 and 1; preserve VAE and any other checkpoint outputs. Allocate collision-free LoRA node IDs for imported graphs.

## Evidence and failure scenario

**Source:** [packages/media/comfyui/src/index.ts:126](../../../packages/media/comfyui/src/index.ts#L126)

**Trigger:** Build the default ComfyUI graph with at least one selected LoRA.

**Impact:** VAEDecode.vae originally points to CheckpointLoaderSimple output 2. applyLoras replaces every nonzero checkpoint output with the final LoRA CLIP output 1. The resulting graph supplies CLIP where VAE is required and the server rejects it; default LoRA generation is unusable.

**Review evidence:** defaultGraph node 6 uses vae:["1",2]. applyLoras rewrites all checkpoint references with value[1]===0 ? modelSource : clipSource, so output 2 is corrupted. LoRA loaders only replace MODEL and CLIP, not the unchanged VAE.

**Evidence limit:** Confirmed by source graph transformation; server execution not performed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T086) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Rewrite checkpoint output 0 (MODEL) and 1 (CLIP) only; preserve output 2 (VAE) and other outputs.
3. Use collision-free node IDs when inserting LoRA nodes into imported graphs.
4. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] The default graph with one or multiple LoRAs keeps VAEDecode connected to the checkpoint VAE.
- [ ] Imported node IDs are not overwritten and the generated graph passes backend type validation.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
