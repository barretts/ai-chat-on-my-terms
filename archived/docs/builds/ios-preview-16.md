# iOS preview build 16

## Result

- Project: `barrett/locallab`, bundle identifier `app.locallab.mobile`.
- Successful build: [ec35f74d-b175-4cbd-a743-2b22e075e6e1](https://expo.dev/accounts/barrett/projects/locallab/builds/ec35f74d-b175-4cbd-a743-2b22e075e6e1).
- EAS status: `FINISHED`, completed `2026-10-16T03:23:42.922Z`.
- App version `0.1.0`, build `16`; `preview` profile, internal distribution, physical iOS device.
- [Signed IPA](https://expo.dev/artifacts/eas/DBKrsMfjzbmlfVtRuA6TDXiDcl3yDQPt0DV88zdDV8M.ipa): HTTP HEAD returned 200; Content-Length 26,790,433 bytes.
- Existing remote distribution certificate and ad hoc provisioning profile were reused.

## Source and build fixes

EAS records commit `878252ea376421053797fd470714abd99a9d2f3e`. The uploaded source also includes working-tree changes; the commit alone does not identify the complete upload. Other implementation work was in progress and was preserved.

Changes made for this build:

1. `apps/mobile/app.json`: increment iOS build number from 15 to 16.
2. `apps/mobile/metro.config.js`: retain normal resolution first, then allow workspace-relative `.js` imports to resolve TypeScript sources under packages/modules. This addressed the jobs/scheduler import failure without changing Node ESM source imports.
3. `packages/speech-system/ios/SpeechSystemModule.swift`: move AVSpeechSynthesizerDelegate conformance to a retained NSObject adapter with a weak module reference, and copy PCM samples through UnsafeBufferPointer instead of slicing a raw pointer.

## Evidence

- Local iOS export completed successfully: 1,850 modules, 6.9 MB Hermes bundle, output `tmp/expo-ios-build-preflight-20261015`.
- First cloud attempt [3803651a-0318-4c32-95a7-b175b3ea4318](https://expo.dev/accounts/barrett/projects/locallab/builds/3803651a-0318-4c32-95a7-b175b3ea4318) failed at Xcode compilation: NSObjectProtocol delegate conformance and invalid Float pointer range access. The replacement corrects those errors and finished compilation, signing and artifact upload.
- Local raw receipts/logs: `tmp/expo-build-16.json`, `tmp/expo-build-16-log-1.txt`, `tmp/expo-build-16-replacement.json`, `tmp/expo-build-16-replacement-log-1.txt`. These are gitignored and may contain expiring private log URLs.
- No product test suite was run. Successful compilation does not establish physical installation, dictation, playback or PCM capture behavior on the phone.

## Installation

Open the successful build page in Safari on the registered iPhone and choose Install. The profile is an internal device build, not an App Store submission. The preview profile retains its existing LAN endpoint and model configuration; the phone needs LAN access to that model host for those defaults.
