# R005 — Voice Studio reads a nonexistent audio_uri column

- **Priority:** P1
- **Original tasks:** T080
- **Suggested owner:** T080 Voice Studio
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Select audio_path AS audioUri and avoid letting one optional list failure suppress the other lists.

## Evidence and failure scenario

**Source:** [apps/mobile/features/voice/imports.ts:45](../../../../apps/mobile/features/voice/imports.ts#L45)

**Trigger:** Create a fresh SQLiteTranscriptionImportStore and call list(), including on normal chat-screen initialization.

**Impact:** The SELECT fails with no such column: audio_uri. The Promise.all that also loads Personas and cloud voice connections rejects and silently leaves all three lists empty, disabling imported recording playback and Persona cloud voice selection.

**Review evidence:** ensureSchema creates audio_path at line 34; add writes audio_path; list selects audio_uri AS audioUri. apps/mobile/composition/chat/screen.tsx:861 groups imports, Personas and connection loading in one Promise.all followed by an empty catch.

**Evidence limit:** Confirmed schema/query contradiction; SQL execution not run. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T080) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Align list() with the persisted audio_path column, checking whether any shipped migration requires compatibility.
3. Separate independent imports/Persona/connection load failures so optional recording storage cannot clear unrelated selections.
4. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] A new transcription store lists zero rows without an SQL error; an inserted recording round-trips its audio URI.
- [ ] Failure to load recordings does not suppress available Personas or voice connections.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
