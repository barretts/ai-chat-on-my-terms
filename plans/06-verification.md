# Verification after working builds

## Two levels of evidence

**Implementation smoke** is a quick contract/local check run with each feature card. T158, T128, T157, T129–T132 and T134 add bounded real-build smoke paths to prove the app actually works. A fixture may prove wiring, but it is marked `fixture`. **Deep verification** begins after the relevant working build. T159A–H, T122 and T123 prove the iPhone release on real hardware/services; T160–T169 prove later-platform differences. T121 reconciles all 231 rows, and T135/T127 make the final release/audit decision.

A feature is not called verified because it has a screen, typecheck or fixture. Its evidence manifest records: feature ID, implementation card, verification shard, platform, app/companion build ID, OS/device/backend/model versions, setup/action/observed result, evidence path, live/fixture marker, defect ID and applicability reason. Keep secrets and personal content out. Missing paid API, account, signing, model, device or service proof remains pending.

## Ordered gates

| Gate | Requirement | What it does not claim |
|---|---|---|
| T005A–D/T005 | Targeted iPhone/Mac native build probes and pinned compatibility/budget decision | Finished app testing |
| T158 | Physical iPhone: airplane-mode tiny GGUF send/stream/reopen and configured OpenAI Responses network send/stream/reopen; label remote fixture or live evidence | Full named-provider matrix or release readiness |
| T128 | Full-feature iPhone development build with working core routes and Mac host; bounded smoke matrix | Signed store build or deep live-vendor matrix |
| T122/T123 + T159A–H | Parallel iPhone performance, security and eight domain proof shards after T128 | Android/iPad/full desktop parity |
| T159 | Signed internal/TestFlight iPhone release after all iPhone deep proof is reconciled | Public App Store publication |
| T157, T129–T132, T134 | Working iPad, Android and full desktop builds with bounded smoke | Exhaustive platform parity |
| T124/T125 | Desktop installers and Android internal distribution after working builds | Public store review |
| T160–T169 | Parallel Android/iPad/Mac/Windows/Linux and cross-device parity shards | Overall completion until T121 |
| T121/T135/T127 | 231-row evidence aggregation, cross-platform release and final artifact audit | Any pending or placeholder-only row |

## Bounded deep-verification shards

| Shard | Real proof scope |
|---|---|
| T159A | iPhone onboarding, local model/runtime/downloads, LAN and named BYOK providers, including a live OpenAI Responses call with real credential and failure recovery |
| T159F | iPhone chat/history, files, search, context and parameter precedence |
| T159B | iPhone Personas, scoped memory, group modes and resource leases |
| T159G | iPhone Arena and built-in/search/MCP/sandbox tool loops |
| T159C | iPhone system/local/hosted voice, Whisper/Call Mode and image/video backends |
| T159D | iPhone/Mac relay, USB, iCloud, selective sync and Shortcut/App Intent recipes |
| T159E | iPhone data/lock, accounts, backup, support/catalog, consent and Apple billing |
| T159H | iPhone themes, localization, low-battery UI, accessibility and icons |
| T160/T168 | Android models/providers/downloads, then chat/files/parameters |
| T161/T169 | Android Personas/groups, then Arena/tools |
| T162 | Android speech and media |
| T163 | iPad-specific layout, Pencil, accessibility and shared-function regression |
| T164–T166 | Mac, Windows and Linux OS/installer/sidecar/UI differences |
| T167 | Cross-device pairing/sync, services, privacy and failure parity |

Each shard works from its own [coverage](05-coverage.md) rows and writes a small task-local evidence manifest under its owned path. If a shard exceeds 48k context, split by backend or feature prefix without changing its parent acceptance. T121 only joins/reviews manifests and runs a bounded final smoke; it does not personally rerun 231 scenarios.

## Physical and service matrix, after functional milestones

- iPhone: one minimum-supported device and one higher-memory device, exact iOS/build/model hash; Apple Silicon Mac companion. Test offline, LAN, separate-network relay, host sleep/wake, USB, iCloud, purchase sandbox and lock/background cases in the named shards.
- iPad: a supported physical iPad with Pencil where applicable after T157. Test native two-pane/landscape layout and shared features; iPad is not a prerequisite of T128.
- Android: low/high memory physical devices after T129–T132, with real GGUF/download/permission/background, Google Play sandbox and supported platform equivalents.
- Desktop: clean Mac, Windows and Linux installs after T134/T124 with pinned sidecars, OS file paths, keyboard/screen-reader/tray and phone pairing. Desktop-only Nerds and navigation prove here.
- Services: actual OpenAI Responses endpoint and the other named BYOK vendors, Ollama, LM Studio, oMLX/custom, A1111, ComfyUI, SearXNG, MCP, optional account/catalog/support/backup/search/relay, RevenueCat store sandboxes and real encryption/rotation paths. Use a secret manager and isolated staging data.

Performance thresholds are pinned by T005 on named model/hardware baselines: startup, first token, sustained generation, peak memory, battery/thermal and crash-free run. T122 measures production-like iPhone builds after T128. Security T123 checks network destinations, log/backup redaction, pairing replay, App Lock/PIN recovery and tool sandbox boundaries after the functional build.

## Release decisions

T159 requires all iPhone-applicable rows to have real proof or an explicit supported-hardware limitation, no critical/high unresolved defect, a signed internal install/upgrade and correct offline/privacy/billing paths. T135 requires the analogous Android/iPad/desktop evidence plus usable internal artifacts. Public App Store/Play submission remains a separate, explicit owner action after internal gates; no plan status implies store approval.
