# iOS production build 32

Prepared October 23, 2026 for the owner's requested TestFlight upload.

## Verified artifact

- App: **AI Chat on My Terms**, version **0.1.0 (32)**.
- Bundle ID: `app.locallab.mobile`; Apple team: `KQJWD7GN74`; App Store Connect app: `6824682448`.
- Source checkpoint: `bb04869f1ae2f7478b2c5ecc6464ac0d2c5c1dfd`, plus the automatic local build-number increment to 32. Failed local-tool setup attempts reserved 30 and 31 without producing installable candidates.
- Built on this Mac with pinned EAS CLI 24.8.0 in `--local` mode, Node 24.13.1, Fastlane 2.240.1, and Xcode 27.1 (`27A9275`). Production image is also pinned to `macos-tahoe-26.6-xcode-27.1` for future cloud builds.
- Store-signed IPA: `build/ios-production-32/AIChatonMyTerms-0.1.0-32.ipa` (local, ignored by Git).
- Size: **42,103,852 bytes**.
- SHA-256: `f0e53f5ea72f40d57bd82d5e5bd372b7adbbd2ceb0d44aadb0311e7ac6937aa1`.
- Artifact inspection confirms iOS 27.1 SDK, iOS 17 minimum, iPhone/iPad device families, embedded JavaScript, scene lifecycle configuration, and supported orientations.
- Deep/strict code-signature verification passed. Signed entitlements identify the expected app/team, enable TestFlight beta reporting and both local-model memory capabilities, and disable `get-task-allow`.

## Upload state

**Apple accepted build 32 and completed processing successfully.** Fresh App Store Connect readback on October 23, 2026 reports build ID `951d2d6d-2609-4849-b3d1-c951e9b5462c`, processing state `VALID`, and internal TestFlight state `MISSING_EXPORT_COMPLIANCE`. Apple's recorded upload time is `2026-10-23T17:52:55-07:00`. The secure local uploader completed with exit code 0 after the owner supplied authentication. The earlier cached-credential error `-22910` is resolved.

The screenshot upload receipt at `submission/screenshots/0.1.0/apple-upload-receipt.json` includes this fresh build readback. TestFlight install availability is **not** established while export compliance remains missing.

The owner authorized TestFlight delivery. App Review submission and public release remain separate steps. The upload command uses local Fastlane and Apple's uploader, waits for processing, and skips distribution/submission changes. No source or binary upload to Expo was used: automatic approval review rejected Expo source export, so the build ran locally and retrieved only the existing managed signing credentials.

`ITSAppUsesNonExemptEncryption` remains unset. No export-compliance answer was invented. Apple confirms `usesNonExemptEncryption: null`; the actual export-compliance declaration must be resolved before claiming TestFlight install availability.

## Verification boundaries

The simulator package at `submission/screenshots/0.1.0/` exercises the current UI and records its own simulator binary provenance. Simulator build 29 and store build 32 share the committed UI changes; they are different platform artifacts. The store IPA has not yet been installed or accepted on a physical device through TestFlight. Imported fictional chats demonstrate saved-conversation rendering, not model inference or provider connectivity.
