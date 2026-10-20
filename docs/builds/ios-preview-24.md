# iOS preview build 24 (T179 pinned device-proof build)

## Result

- Project: `barrett/locallab`, bundle identifier `app.locallab.mobile`.
- Successful build: [63b3ba76-566f-4bd6-905b-67b746a6cb2d](https://expo.dev/accounts/barrett/projects/locallab/builds/63b3ba76-566f-4bd6-905b-67b746a6cb2d).
- EAS status: `finished`; started 10/20/2026 11:32:46, finished 10/20/2026 11:42:36 local time (cloud run ~9.8 minutes), started by `barrett`.
- App version `0.1.0`, build `24`; `preview` profile, internal (ad hoc) distribution, physical iOS device.
- [Signed IPA](https://expo.dev/artifacts/eas/UYvvEkD3msmfm5mbt-V88580yRXxq7uGyrTBX52qRHM.ipa): HEAD following the signed-CDN redirects (two 307 hops) returned 200; Content-Length 26,889,815 bytes.
- Existing EAS-managed distribution certificate and ad hoc profile `[expo] app.locallab.mobile AdHoc 1790527962448` (provisioned device: iPhone UDID `00008150-001844EC3C02401C`) were reused — same regular no-login signing path as builds 2–21.
- EAS recorded commit `8951af8` ("fix(ios): scope memory entitlements to store builds so ad-hoc preview builds sign with the existing EAS profile") as build source; project fingerprint `dd1acc1d3a2b5c8832b2adf1c4beb62bc12d846c`.
- Pin deviation from builds 2–23: the tree was clean at dispatch and committed first (`5a910e7` buildNumber bump, `8951af8` signing scope fix), so the recorded commit fully identifies this archive, as T179 step 1 requires.

## First dispatch failed

- Build [662e1f93-5846-4ee4-9f62-e0948ceff0ba](https://expo.dev/accounts/barrett/projects/locallab/builds/662e1f93-5846-4ee4-9f62-e0948ceff0ba) failed in Xcode signing: the ad hoc profile (created 2026-09-27) predates the kernel memory entitlements added in release prep (`8ea7e51`), and regenerating it requires an owner-authenticated Apple session (password + 2FA stay local to the owner per the build-22/23 precedent).
- Fix kept store builds byte-identical in intent: `app.config.js` now strips `ios.entitlements` unless `APP_STORE_BUILD=1` / `EAS_BUILD_PROFILE=production`, so the preview build signs with the existing profile while production retains the pair build 23 proved.
- Consequence for device proof: build 24 runs WITHOUT Extended Virtual Addressing / Increased Memory Limit; the T179 benchmark rows (especially 4B model fits and memory-pressure behavior) must note the reduced per-app memory budget; store builds keep the entitlements.

## What ships since build 23

- The full P12 group-chat lane (T170–T178): group rooms/settings/participant prefs schema (migration 0009), turn controller with round-robin/rotation/dice/topic-interest ordering and selector validation fallback, discussion vs independent context modes, Drunk 512-token window, single-slot shared-model lease runtime with release/unload, group chat route + setup settings UI, avatar persistence chain (chat appearance, library fields, persona-photo port), Liquid LFM2.5 catalog pin with model-scope publisher parameters, and the GR-13 verification pass (commit `3382766`).

## Verification status

- No product test suite was run against the binary. Successful compilation does not establish physical installation or on-phone behavior; the T179 device rows live under `docs/implementation/evidence/parity/t179/`.

## Installation

- Open the build link (or its QR code) on the provisioned iPhone while signed into the matching Apple account, or install the IPA through the usual Apple Configurator route.
