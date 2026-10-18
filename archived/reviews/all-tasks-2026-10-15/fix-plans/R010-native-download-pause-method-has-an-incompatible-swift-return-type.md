# R010 — Native download pause method has an incompatible Swift return type

- **Priority:** P1
- **Original tasks:** T031
- **Suggested owner:** T031 native downloader
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Make the Swift return type String? to match the bridge, or return Data and perform encoding in a correctly typed bridge layer.

## Evidence and failure scenario

**Source:** [modules/downloads/ios/native/BackgroundTransferSession.swift:79](../../../../modules/downloads/ios/native/BackgroundTransferSession.swift#L79)

**Trigger:** Compile BackgroundTransferSession.swift into the native downloader.

**Impact:** pause is declared to return Data?, but its checked continuation resumes with data?.base64EncodedString(), which is String?. The native implementation cannot type-check as written, blocking the background downloader build.

**Review evidence:** The declaration at line 79 is async throws -> Data?. Line 84 passes the optional base64 String to continuation.resume(returning:). The TypeScript bridge expects resumeData as a string.

**Evidence limit:** Confirmed static type contradiction; Swift compilation not available/executed on this Windows review host. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T031) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Align the native pause return type with the bridge resume-data representation.
3. Trace pause, persistence and resume consumers so base64 encoding happens exactly once.
4. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] The native downloader target type-checks on macOS.
- [ ] Pause returns bridge-compatible resume data and a resumed transfer completes without corrupting it.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
