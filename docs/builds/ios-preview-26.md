# iOS preview build 26 (T181 benchmark fixes: ungated, self-heal, progress, checkpoints)

## Result

- Project: `barrett/locallab`, bundle identifier `app.locallab.mobile`.
- Successful build: [0dc28760-647b-43de-bd25-5f16cdd8853e](https://expo.dev/accounts/barrett/projects/locallab/builds/0dc28760-647b-43de-bd25-5f16cdd8853e).
- EAS status: `finished`; started 10/20/2026 15:23:55, cloud run ~6.5 minutes, started by `barrett`.
- App version `0.1.0`, build `26`; `preview` profile, internal (ad hoc) distribution, physical iOS device.
- [Signed IPA](https://expo.dev/artifacts/eas/R1K0f_tHU66RRlMBYl5ucT08c9UQFftU26ZiatHwDaY.ipa): GET following the signed-CDN redirects (two 307 hops) returned 200; 26,910,612 bytes; sha256 `6a2d1174c57a4a6d959e8d1c6c6f55b3a58c4f9ed7a91072155cecb7c968c3c4` (verified on a local copy, `tmp/ios-preview-26.ipa`).
- Fingerprint `84d550c53cfd475a809a56e48fed380b435c30c3`.
- Existing EAS-managed distribution certificate and ad hoc profile `[expo] app.locallab.mobile AdHoc 1790527962448` (provisioned device: iPhone UDID `00008150-001844EC3C02401C`) reused — same regular no-login signing path as builds 24/25.
- EAS recorded commit `f9cd94c43753456c3ef91fa63c5451105b2369d3` ("build(ios): pin build 26 (T181 ungated benchmark + self-heal + progress/checkpoints)") as build source; the tree was clean at dispatch, so the recorded commit fully identifies this archive (build-24 convention).

## What ships since build 25

- `7799cfb` (owner change): expanded phone-model choices (roleplay catalog entries in `packages/models/catalog`, mobile local-models list, `docs/phone-models-and-voices.md`).
- T181 device-feedback fixes (`f3ef454`), addressing the owner's build-25 report:
  - **Ungated benchmark**: the Developer benchmark section in Settings mounts unconditionally; `EXPO_PUBLIC_DEV_BENCH` removed from the `eas.json` preview env and from the `app.config.js` store guard (the `EXPO_PUBLIC_STRATA_*` guard remains); `devBenchEnabled()` deleted. The section now ships in store builds too (owner call).
  - **"Allocated conversation is missing" fixed**: per-scenario teardown switched from a hand-rolled `DELETE FROM conversations` to the production `deleteConversation` chain (messages, runs, allocations, metadata, lifecycle + queued blob cleanups) — the old teardown left `dev-bench-*` rows in `chat_history_allocations` (no FK cascade), which poisoned every rerun. Additionally, every benchmark session start now sweeps stale bench rooms/conversations/allocation keys (`sweepStaleBenchSessions`), so an install broken by a crash self-heals on the next Run press.
  - **Progress**: `runBenchMatrix` gains `onRoundDone`; the section shows `Scenario i/18: <label> — round r/R done`.
  - **Crash evidence**: after every completed scenario a checkpoint manifest (`group-bench-<stamp>-partial.json`) is rewritten under `Documents/locallab/bench/`; reopening the section offers a "Share <file>" button for the newest existing manifest, so a crash mid-matrix no longer loses completed rows. Scenarios record `memoryBytesBefore/After` (static onboarding fit estimate; true free RAM is not observable from JS) alongside live thermal state.

## Caveats

- Build 26 still runs WITHOUT Extended Virtual Addressing / Increased Memory Limit (same ad-hoc profile as builds 24/25); benchmark rows must note the stock per-app memory budget — a signing-profile artifact, not product behavior. Regenerating the profile with the memory capabilities requires owner-side Apple credentials/2FA.
- Memory figures in the manifest are the static fit estimate (55% of `Device.totalMemory`), not free RAM; iOS analytics `.ips` crash logs remain the way to confirm an OOM kill.
- The benchmark UI is developer tooling but now ships in all builds including store (explicit owner request in T181).

## Installation

- Open the build link (or its QR code) on the provisioned iPhone while signed into the matching Apple account.
- To produce T179 row 3 manifests: Settings → Developer benchmark → tick models → Run matrix (stale rows from the build-25 crash sweep automatically); the per-round progress line shows completion detail, and a partial manifest survives a crash via the Share button at the section's top-level controls.
