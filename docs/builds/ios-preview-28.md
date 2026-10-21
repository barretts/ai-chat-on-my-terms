# iOS preview build 28 (grammar guard + starter character pack)

- EAS build `9ccc8203-682a-4041-a79e-7be9da186df2` — `finished`, profile `preview`, distribution `internal`, SDK 57.0.0, app version `0.1.0`, buildNumber `28`, started 10/21/2026 2:50:35, finished 2:56:43.
- [Install link](https://expo.dev/accounts/barrett/projects/locallab/builds/9ccc8203-682a-4041-a79e-7be9da186df2); [Signed IPA](https://expo.dev/artifacts/eas/GWeQXFXzgywwrcig9R-9SaAtATYqaIhQhNtz-9diejs.ipa): 27,000,863 bytes; sha256 `828e20fe81eb6250a56004c02922697e0b0951d49f66bcdf3143296b3bfc7b88` (verified on a local copy, `tmp/ios-preview-28.ipa`).
- Fingerprint `e2101f8a0cdf72580638c244c08da35b9db6a4d0`.
- EAS recorded commit `11b4886` ("build(ios): pin build 28 (T183 grammar guard + T184 starter trope pack)") as build source; clean tree at dispatch.

## What changed vs build 27

- T183 auto-heal JSON-grammar crash guard (`2afb508`): a durable probe spans process restarts for every `json:true` GGUF run; a probe surviving into the next launch quarantines that model's JSON mode to plain-text topic selection. Expected device behavior: the HauhauCS Qwen3.5 2B topic-interest scenario crashes ONCE more after install (the crash that writes the probe), then every later launch runs it in text mode with the quarantine listed (with owner re-enable) in the benchmark section. Upgrading from build 27 does not reset the guard version (`llama-rn-0.12.4`).
- T184 starter character pack (`43222c0`): first boot installs 14 trope personas (7 core + 7 anime-adjacent) with bundled flat avatars, marker-gated (`seed.tropes.v1`) so restarts write nothing; deleted characters are revived only by the Personas screen's "Load character pack" button (which clears their tombstones and keeps edits). First boot pays a one-time ~14-avatar import.

## Caveats (unchanged from build 27)

- Still signed with the reused ad-hoc profile: Extended Virtual Addressing / Increased Memory Limit are declared in `apps/mobile/app.json` but the profile does not carry them. Enabling them needs the Apple-portal capability + a regenerated EAS profile (owner-side Apple credentials/2FA).
- Thermal state remains unobservable from JS (no `ProcessThermalState` in RN 0.86.3); manifests honestly record `unknown`.
