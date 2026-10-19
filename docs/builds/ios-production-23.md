# iOS production build 23

- Build: [9bd18bf0-3b54-4af5-8221-643bec7f8145](https://expo.dev/accounts/barrett/projects/locallab/builds/9bd18bf0-3b54-4af5-8221-643bec7f8145).
- Version `0.1.0`, build `23`, production profile, store distribution, bundle ID `app.locallab.mobile`.
- Apple Team `KQJWD7GN74`; active App Store profile `U8V37V2644`; existing distribution certificate reused.
- Corrects build 22's provisioning mismatch by declaring Extended Virtual Addressing and Increased Memory Limit in app configuration and enabling both Apple capabilities before generating the replacement profile.
- Source upload: 21.2 MB; upload and fingerprint computation succeeded. Source includes uncommitted release preparation; the Git commit alone does not identify this archive.
- Dispatch is verified. Final build status and signed artifact verification remain pending. No App Store Connect upload, TestFlight acceptance, review submission, or public release is established by dispatch.
- Export compliance remains for manual Apple assessment; no exemption assertion was added.

## Final result: successful

Expo reported **FINISHED** October 19, 2026 at 5:07:09 PM America/Chicago. No build error was reported.

- [Production IPA](https://expo.dev/artifacts/eas/6zUZ85Ne_e-ptGd6ChFemTihUQKcgUQKR6Kqqb_qtKk.ipa?download=1).
- Downloaded artifact: `.logs/app-store-production-23/AI-Chat-on-My-Terms-0.1.0-23.ipa`, 41,994,760 bytes.
- SHA-256: `a2c8d599f9d40afc4d342512bfeb5bb4c3e101110f766c6ab41b7d81ba4c9d6f`.
- IPA Info.plist confirms bundle `app.locallab.mobile`, version `0.1.0`, build `23`, minimum iOS `17.0`, SDK `iphoneos26.5`, Xcode `2660`.
- Embedded provisioning profile confirms team/app identifier `KQJWD7GN74.app.locallab.mobile`, both required memory entitlements true, `get-task-allow=false`, no provisioned device list, and no all-devices distribution flag. Profile UUID `3468f684-994e-4975-83df-d172bc77da13`. CMS content/signature decoded and verified with OpenSSL without validating the certificate trust chain; this is not full independent app-signature or Apple upload validation.
- Nine privacy manifest files are present in the IPA. Presence is not a completed privacy audit or an App Privacy attestation.

App Store Connect app `6824682448` now exists with iOS draft version `0.1.0`, manual release, Prepare for Submission. This candidate has not been uploaded to App Store Connect or tested through TestFlight. No App Review submission or public release occurred.
