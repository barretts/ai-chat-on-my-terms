# iOS production build 22

## Verified dispatch

- Expo build: [8aca0a1e-158a-4a22-b0ff-cd9bd8d01beb](https://expo.dev/accounts/barrett/projects/locallab/builds/8aca0a1e-158a-4a22-b0ff-cd9bd8d01beb).
- App: AI Chat on My Terms; EAS `barrett/locallab`; bundle ID `app.locallab.mobile`.
- Version `0.1.0`, build `22`, profile `production`, distribution `STORE`, physical iOS target.
- Created October 19, 2026 at 4:55:49 PM America/Chicago; initiated by Expo account `barrett`.
- Expo reported `IN_PROGRESS` after the owner completed secure Apple signing prompts. Store signing setup was sufficient for build dispatch; finished archive validation remains separate.
- Recorded source commit: `419bd394c08332cfed27a3a2a2729a2c4d64cd54`. The upload also includes working-tree preparation changes; the commit alone does not identify the complete build source.
- Expo fingerprint: `e6176a67dd32304f06d967acffb2c6e5654e814e`; Expo SDK `57.0.0`.

## Preparation included

Separate store build profile; developer-default environment guard; camera/photo purpose strings; Settings support/privacy links to the approved `aichat.sosuke.com` host. The poster and static marketing site are website assets, not app screenshots.

## Remaining acceptance

Do not treat dispatch as a successful build. Record final status and artifact before upload. No App Store Connect upload, TestFlight availability, device acceptance, review submission, public release, export-compliance decision, or final privacy attestation is established by this record. Cloud-AI consent verification and candidate screenshots remain open; see `../app-store-submission.md` and `../../submission/APPLE-HANDOFF.md`.

## Final result and repair

Build 22 **failed** October 19, 2026 at 4:57:50 PM America/Chicago. Xcode reported that App Store profile `Y454D5U6U8` lacked Extended Virtual Addressing and Increased Memory Limit entitlements. No signed IPA was produced.

The llama.rn plugin conditionally adds these entitlements during production native configuration. Added both explicitly to `expo.ios.entitlements` so early signing setup sees the same requirements. Regression checks now pass 3/3, including visibility of both entitlements before native prebuild.

Using the owner's authenticated Apple session, Expo confirmed bundle registration for `app.locallab.mobile`, enabled Extended Virtual Address Space and Increased Memory Limit on Apple Team `KQJWD7GN74`, and created replacement App Store profile `U8V37V2644` with active status. Existing distribution certificate was reused. Expo reported all credentials ready. A replacement production build is being dispatched; do not reuse build 22.
