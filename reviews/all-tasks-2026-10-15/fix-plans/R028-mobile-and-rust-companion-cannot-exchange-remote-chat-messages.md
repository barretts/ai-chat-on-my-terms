# R028 — Mobile and Rust companion cannot exchange remote chat messages

- **Priority:** P1
- **Original tasks:** T103
- **Suggested owner:** T103 mobile/companion wire integration
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** [R007](./R007-recreating-a-saved-pairing-reuses-encryption-keys-and-nonces.md), [R021](./R021-out-of-order-encrypted-frames-remain-replayable-after-acceptance.md)

## Outcome

Use the same versioned payload and frame schema on both implementations, translate backend streaming events to RunEvents, and send terminal completion/failure. Review the real TS-to-Rust path rather than same-language fixtures.

## Evidence and failure scenario

**Source:** [apps/companion/composition/remote/mod.rs:153](../../../apps/companion/composition/remote/mod.rs#L153)

**Trigger:** Send createRemoteChatConnection.streamRun through attachRemoteSession to RemoteComposition.serve_chat.

**Impact:** The companion rejects the first legitimate mobile request as malformed; the phone never receives completion. Even after adapting the request, the response is raw backend bytes rather than the event/completion payloads the phone consumes.

**Review evidence:** Mobile seals {tag:"request",body:{type:"chat-request",runId,routeId,messages,tools}}. Rust reads plaintext["type"] and requires top-level bodyBase64Url instead. Rust seals raw backend response bytes as one event frame; TS expects EncryptedPayload RunEvent objects plus chat-complete.

**Evidence limit:** Confirmed by source-path and state/contract inspection; runtime reproduction not executed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T103) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Agree one versioned TS/Rust frame and decrypted payload contract for real mobile-to-companion requests.
3. Translate backend streaming output into matching RunEvent payloads and terminal completion/failure messages; validate frame fields and opposite-direction sequence ownership.
4. Ensure cancel, disconnect and protocol mismatch settle the phone waiter instead of leaving a pending stream.
5. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] A request sealed by the actual TS mobile adapter is opened and served by Rust; TS consumes the Rust response and completes with the expected text.
- [ ] Streaming, cancellation, backend failure and disconnect terminate correctly; same-language fixtures alone do not establish completion.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
