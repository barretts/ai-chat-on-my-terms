# iOS preview build 25 (T180 on-device benchmark button)

## Result

- Project: `barrett/locallab`, bundle identifier `app.locallab.mobile`.
- Successful build: [1edf8d93-ba68-4ac0-8ddc-14baa56d1216](https://expo.dev/accounts/barrett/projects/locallab/builds/1edf8d93-ba68-4ac0-8ddc-14baa56d1216).
- EAS status: `finished`; started 10/20/2026 ~13:48, cloud run ~8.1 minutes, started by `barrett`.
- App version `0.1.0`, build `25`; `preview` profile, internal (ad hoc) distribution, physical iOS device.
- [Signed IPA](https://expo.dev/artifacts/eas/tdWG8FO5qj919oGyDYZF72J1ukHdhRH8kWJiThHHkig.ipa): GET following the signed-CDN redirects (two 307 hops) returned 200; 26,905,332 bytes; sha256 `79ae17eb2787cc4624d4be7c71e54a6e43938af751c84725dbac4042d5f1cd9b` (verified on a local copy).
- Existing EAS-managed distribution certificate and ad hoc profile `[expo] app.locallab.mobile AdHoc 1790527962448` (provisioned device: iPhone UDID `00008150-001844EC3C02401C`) reused — same regular no-login signing path as build 24.
- EAS recorded commit `e74c177c967ea05cb60083ce97c6bee648fd9c49` ("build(ios): pin device-proof build 25 for T180 benchmark button") as build source; the tree was clean at dispatch, so the recorded commit fully identifies this archive (build-24 convention).

## What ships since build 24

- T180 dev-only group benchmark runner (`d26e210`): Settings gains a "Developer benchmark" section (visible only when `EXPO_PUBLIC_DEV_BENCH=1`, which the preview profile sets and the store-build guard refuses); one press runs the T179 row-3 matrix — installed models x {2,3,5} seats x {round-robin, dice, topic-interest}, fixed bench personas, identical kickoff text, deterministic dice seeds — against the REAL group runtime (route bootstrap replica, capacity-1 lease runtime unloaded between scenarios, recording provider port capturing per-run wall-clock/usage/finish keyed by message id), writes a JSON manifest under `Documents/locallab/bench/`, then opens the share sheet (Copy-to-clipboard button also available); all bench rooms/conversations are deleted after each scenario.
- `app.config.js` store guard now also fails on any `EXPO_PUBLIC_DEV_*` variable; `eas.json` preview env carries `EXPO_PUBLIC_DEV_BENCH=1` only.

## Caveats

- Build 25 still runs WITHOUT Extended Virtual Addressing / Increased Memory Limit (same ad-hoc profile as build 24); benchmark rows must note the stock per-app memory budget — this is a signing-profile artifact, not a product behavior.
- The runner is dev-only evidence tooling: it is not part of the product UX and is excluded from store builds.

## Installation

- Open the build link (or its QR code) on the provisioned iPhone while signed into the matching Apple account.
- To produce T179 row 3 manifests: Settings → Developer benchmark → tick both installed models → Run matrix; share or copy the manifest and file it under `docs/implementation/evidence/parity/t179/`.
