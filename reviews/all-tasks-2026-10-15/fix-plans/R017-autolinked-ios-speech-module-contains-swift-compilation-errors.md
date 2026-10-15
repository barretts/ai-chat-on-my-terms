# R017 — Autolinked iOS speech module contains Swift compilation errors

- **Priority:** P1
- **Original tasks:** T072, T077, T001
- **Suggested owner:** T072/T077 native speech module
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Call try engine.start() and update outCondition.pointee in the conversion input block; compile the autolinked target on macOS before claiming native completion.

## Evidence and failure scenario

**Source:** [packages/speech-system/ios/SpeechSystemModule.swift:343](../../../packages/speech-system/ios/SpeechSystemModule.swift#L343)

**Trigger:** Build the iOS mobile app with its declared @locallab/speech-system dependency autolinked.

**Impact:** The PCM capture branch calls throwing AVAudioEngine.start without try. The AVAudioConverter input block also writes .pointee on its first argument (packet count) instead of the second argument (input-status pointer). The speech native target cannot compile, blocking the iOS app build.

**Review evidence:** startCapture line 343 calls engine.start() while the same file correctly uses try self.engine!.start() in dictation. Conversion block lines 329-335 names arguments status,outCondition but assigns status.pointee. apps/mobile/package.json declares speech-system and its Expo module config registers the Swift class.

**Evidence limit:** Confirmed source type/call contradictions; Swift/iOS compilation not executed on this Windows host. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T072, T077, T001) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Handle the throwing engine.start call correctly and write converter input status through its actual pointer argument.
3. Review adjacent capture setup/cleanup for errors introduced by these corrections.
4. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] The autolinked speech target compiles in the iOS app on macOS.
- [ ] PCM capture starts and converts input; failure releases engine/audio resources and reports a recoverable error.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
