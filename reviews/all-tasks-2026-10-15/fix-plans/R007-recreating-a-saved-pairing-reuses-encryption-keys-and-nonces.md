# R007 — Recreating a saved pairing reuses encryption keys and nonces

- **Priority:** P1
- **Original tasks:** T093, T096
- **Suggested owner:** T093/T096 pairing protocol implementation
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Negotiate fresh session material on reconnect before resetting counters, or persist a safe nonce space and peer replay state across restarts.

## Evidence and failure scenario

**Source:** [packages/remote/client/src/index.ts:135](../../../packages/remote/client/src/index.ts#L135)

**Trigger:** Create two client instances from the same saved QR, such as before and after an app restart, and send the first frame from each.

**Impact:** The same pairing secret and route derive the same salts, keys and sequence-zero nonce. Reusing an AES-GCM nonce compromises sealed-frame security, while a peer retaining its replay state refuses the restarted client.

**Review evidence:** deriveSessionSalts is deterministic per QR secret and route. createPairingClient constructs fresh createSessionPairing channels each time. SealingChannel initializes nextSequence to 0 in packages/remote/crypto/src/index.ts:192.

**Evidence limit:** Confirmed by deterministic key/nonce construction; cryptographic runtime probe not executed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T093, T096) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Trace session establishment and persisted pairing material in both languages before changing key derivation.
3. Choose fresh authenticated session material on reconnect or a durable non-repeating nonce space; make reset/reconnect behavior explicit for both peers.
4. Update protocol compatibility handling if wire changes are required.
5. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] Two sessions from the same saved pairing never reuse a key/nonce pair.
- [ ] Reconnect after either peer restarts succeeds without weakening replay protection; old-session frames are refused.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
