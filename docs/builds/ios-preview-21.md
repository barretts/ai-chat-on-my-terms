# iOS preview build 21

## Result

- Project: `barrett/locallab`, bundle identifier `app.locallab.mobile`.
- Successful build: [1e7b4d3f-c5f8-4903-a8c4-3dd1a1820db1](https://expo.dev/accounts/barrett/projects/locallab/builds/1e7b4d3f-c5f8-4903-a8c4-3dd1a1820db1).
- EAS status: `finished`; started 10/17/2026 05:34:20, finished 10/17/2026 05:40:38 local time (cloud run ~6.5 minutes), started by `barrett`.
- App version `0.1.0`, build `21`; `preview` profile, internal distribution, physical iOS device.
- [Signed IPA](https://expo.dev/artifacts/eas/gEmomjFJMrwbJve8CobzGvQSruayuWvKNAC-rPfSruI.ipa): HEAD (following the signed-CDN redirect) returned 200; Content-Length 26,831,501 bytes.
- Existing EAS-managed remote distribution certificate and ad hoc provisioning profile were reused.
- EAS recorded commit `c2a72e8` ("feat(themes): built-in theme sets with light+dark variants and dropdown picker", also pushed to `origin/main`) as the build source.

## What ships since build 20

- Built-in theme sets (`c2a72e8`): every builtin theme now carries light AND dark palettes (`ThemeV1.variants`); six sets — Locallab Default, Harbor Teal, Amber Sepia, Forest Trail, Sunset Rose, Slate Mono — replace the light/dark singletons; the theme editor chips became a dropdown that applies a set immediately; dark Paper bases were retinted from grey to deep cobalt navy and the MD3 lavender `tertiary` leak was closed with teal.
- Verified in expo-web before submission: the dropdown listed all six sets, selecting Harbor Teal repainted the running app with its dark variant (background `#08201f`, accent `#7fd4d2`), and the same set switched to its light variant (`#f4faf9`/`#0f6b6e`) via the app-theme preference; zero purple computed colors remained in the dark scan.
- Product checks: themes schema suite 16/16, mobile themes suite 9/9, `pnpm -r test` 112/113 (single flaky `@locallab/testkit` failure that passes in isolation), mobile typecheck clean.

## Source

As with builds 2-20, the uploaded source archive also included working-tree changes, so the commit alone does not identify the complete upload. Preserved in-progress work at submission time included `apps/mobile/app.json` iOS `buildNumber` 21 (uncommitted at submission), `apps/mobile/composition/chat/*`, `features/chat-settings/*`, `features/speech/screen.tsx`, `features/diagnostics/error-notice.tsx`, `platform/local-chat-provider.ts`, `modules/gguf/ios/*`, and `packages/providers/cloud/compatible/src/index.ts`.

## Evidence

- Local receipts (gitignored): `tmp/iphone-build21/submission.log` (upload + fingerprint + build link), `tmp/iphone-build21/ipa-head.txt`, `tmp/iphone-build21/web-harbor-teal-light.png` (Harbor Teal light-variant screenshot).
- Submission used `eas-cli@24.8.0` (pinned by `docs/iphone-installation.md`) via `pnpm dlx` from `apps/mobile`, profile `preview`, `--non-interactive --no-wait`.
- No product test suite was run against the binary. Successful compilation does not establish physical installation or on-phone behavior.

## Installation

Open the build page in Safari on the registered iPhone and choose Install:
<https://expo.dev/accounts/barrett/projects/locallab/builds/1e7b4d3f-c5f8-4903-a8c4-3dd1a1820db1>

The profile is an internal device build, not an App Store submission. The `preview` profile retains the LAN endpoint `http://192.168.1.213:1234/v1` and model `qwen3.8-flash-next-iq3_s-128k`; the phone needs LAN access to that model host for those defaults.
