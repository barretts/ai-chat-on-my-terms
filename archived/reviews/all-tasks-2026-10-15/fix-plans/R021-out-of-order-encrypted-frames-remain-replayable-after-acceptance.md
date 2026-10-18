# R021 — Out-of-order encrypted frames remain replayable after acceptance

- **Priority:** P1
- **Original tasks:** T093, T096
- **Suggested owner:** T093 cross-language replay protection
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Commit the corresponding seen bit for every accepted sequence after successful authentication; keep failed authentication from consuming replay state. Apply the same algorithm in both languages.

## Evidence and failure scenario

**Source:** [packages/remote/crypto/src/index.ts:227](../../../../packages/remote/crypto/src/index.ts#L227)

**Trigger:** Deliver authentic frame sequence 1 before sequence 0, then resend sequence 0 repeatedly while it remains inside the replay window.

**Impact:** Every repeat of sequence 0 is accepted and decrypted because the older-sequence branch never marks that position seen. The identical Rust receiver has the same defect. A relay that reorders/replays captured valid requests can repeatedly deliver authenticated payloads despite the promised replay protection.

**Review evidence:** OpeningChannel.acceptSequence checks the bit for back but returns without setting it. Rust accept_sequence likewise returns Ok without updating seen_mask. Only new high-water sequences set a bit. Authentication also occurs after replay-state mutation.

**Evidence limit:** Confirmed source replay-state transition; live paired execution not performed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T093, T096) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Use the same replay-window algorithm in TypeScript and Rust.
3. Authenticate first, then atomically commit the accepted sequence bit, including older in-window sequences. Failed authentication must not advance or consume replay state.
4. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] After accepting sequences 1 then 0, every repeat of 0 is rejected in both languages.
- [ ] Tampered frames do not consume sequence numbers; window boundaries and legitimate out-of-order frames behave consistently.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
