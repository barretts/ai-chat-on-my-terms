# iOS preview build 27 (manifest model display names)

- EAS build `65cead1f-56fc-48b8-aac2-2f7d0819bfdf` — `finished`, profile `preview`, distribution `internal`, SDK 57.0.0, app version `0.1.0`, buildNumber `27`, started 10/20/2026 18:57:08, finished 19:02:47.
- [Install link](https://expo.dev/accounts/barrett/projects/locallab/builds/65cead1f-56fc-48b8-aac2-2f7d0819bfdf); [Signed IPA](https://expo.dev/artifacts/eas/IRaCIRb2Q6-lwROXmuk9ZCTxUrJSvMs3AmXXM9nH0w8.ipa): 26,910,812 bytes; sha256 `f683b9fde2a2049125f3718909f7f2a62fcef07b6ea572841e59c5e478add09f` (verified on a local copy, `tmp/ios-preview-27.ipa`).
- Fingerprint `3437b40c926f544447541b37acbc3f8f0c8124fa`.
- EAS recorded commit `7be7c38` ("build(ios): pin build 27 (manifest model display names, T182)") as build source; clean tree at dispatch.

## What changed vs build 26

- Bench manifests now carry a `modelNames` map (display names keyed by `blob:<id>`, `712416b`) so device evidence identifies which GGUF ran each scenario — the T2157/T2222 manifests' bare blob ids were unidentifiable.
- No behavior changes to the benchmark flow otherwise; build 26 device findings ([T179 evidence](../implementation/evidence/parity/t179/README.md)) remain valid.

## Caveats (unchanged from build 26)

- Still signed with the reused ad-hoc profile: Extended Virtual Addressing / Increased Memory Limit are declared in `apps/mobile/app.json` (owner edit) but the profile does not carry them — verified absent from `embedded.mobileprovision` and the signed binary in this IPA. Enabling them needs the Apple-portal capability + a regenerated EAS profile (owner-side Apple credentials/2FA).
- Thermal state remains unobservable from JS (no `ProcessThermalState` in RN 0.86.3); manifests honestly record `unknown`.
