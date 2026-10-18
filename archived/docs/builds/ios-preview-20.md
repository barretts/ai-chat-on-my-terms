# iOS preview build 20

## Result

- Project: `barrett/locallab`, bundle identifier `app.locallab.mobile`.
- Successful build: [92641eac-95ca-4724-b902-c498ebcd1949](https://expo.dev/accounts/barrett/projects/locallab/builds/92641eac-95ca-4724-b902-c498ebcd1949).
- EAS status: `finished`; started 10/17/2026 00:47:34, finished 10/17/2026 00:54:13 local time (cloud run ~7 minutes), started by `barrett`.
- App version `0.1.0`, build `20`; `preview` profile, internal distribution, physical iOS device.
- [Signed IPA](https://expo.dev/artifacts/eas/prcn1maQFRi_2VOOds9L2aB4ssSnIZ6pxjko8tx6QiA.ipa): HEAD (following the signed-CDN redirect) returned 200; Content-Length 26,829,307 bytes.
- Existing EAS-managed remote distribution certificate and ad hoc provisioning profile were reused. Build fingerprint `62b65b4b30bbbf8c260c3e6ef60168938e4d6d82`.
- Quota was checked immediately before submission: Free plan, overage 0, estimated total cost 0.

## Source

EAS records commit `8b20642c5f97a59d2bd576629b24276476a48499` (the cobalt-blue recolor, also pushed to `origin/main`). As with builds 2–18, the uploaded source archive also included working-tree changes, so the commit alone does not identify the complete upload. Preserved in-progress work at submission time included:

- `apps/mobile/app.json` iOS `buildNumber` bumped 18 → 20 for this build (uncommitted at submission).
- `apps/mobile/composition/chat/*` (chat screen bevel recolor included in the cobalt commit except screen.tsx, which also carries in-progress changes), `features/chat-settings/*`, `features/speech/screen.tsx`, `features/diagnostics/error-notice.tsx`, `features/themes/index.ts` + tests, `platform/local-chat-provider.ts`.
- `modules/gguf/ios/*` (stream decoder, tool protocol additions) and `packages/providers/cloud/compatible/src/index.ts`.

Committed changes new to the phone since build 18 (git history): the full test-retarget series (`af083c4`..`0ee1e9d`), Windows desktop Tauri packaging (`799b142`, mobile-irrelevant), and the cobalt recolor (`8b20642`) replacing the purple/lavender scheme everywhere — builtin palettes, Paper base themes, secondary-container lavender leak, hardcoded accents, and the retro messenger artwork.

## Evidence

- Local receipts (gitignored): `tmp/iphone-build20/submission.log` (includes the installation QR code and link), `tmp/iphone-build20/build-info.txt` (`eas build:view`), `tmp/iphone-build20/ipa-head.txt`.
- Submission used `eas-cli@24.8.0` (pinned by `docs/iphone-installation.md`) via `pnpm dlx` from `apps/mobile`, profile `preview`, `--non-interactive`.
- No product test suite was run against the binary. Successful compilation does not establish physical installation or on-phone behavior.

## Installation

Open the build page in Safari on the registered iPhone and choose Install:
<https://expo.dev/accounts/barrett/projects/locallab/builds/92641eac-95ca-4724-b902-c498ebcd1949>

The profile is an internal device build, not an App Store submission. The `preview` profile retains the LAN endpoint `http://192.168.1.213:1234/v1` and model `qwen3.8-flash-next-iq3_s-128k`; the phone needs LAN access to that model host for those defaults.
