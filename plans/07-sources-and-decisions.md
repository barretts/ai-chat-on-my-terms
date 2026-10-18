# Sources and frozen project choices

> Local workstation: Windows; run workspace commands in PowerShell. Follow the [PowerShell environment guide](POWERSHELL.md).

## Scope authority

The [231-row inventory](../docs/lm-mini-features.md) is the feature checklist, based on public LM Mini pages/release notes with source links in that file. [Research notes](../archived/docs/research-notes.md) record ambiguity; the [earlier Windows blueprint](../archived/docs/windows-blueprint.md) is technical context. LocalLab is an independent implementation. Public descriptions do not establish original-app pairing compatibility or permit use of original branding/artwork.

## SDK and UI sources

- [AI Elements setup](https://elements.ai-sdk.dev/docs/setup) describes React/shadcn/Tailwind web components. They belong in the later Next/Tauri desktop webview; the iPhone uses native React Native UI.
- [AI SDK Expo guide](https://ai-sdk.dev/docs/getting-started/expo) informs a streaming/message bridge. T005A tests the pinned Expo transport and `expo/fetch`; direct HTTP-to-RunEvent is the fallback.
- [OpenAI Responses text generation](https://developers.openai.com/api/docs/guides/text) documents the official `/v1/responses` request and bearer-key flow; [OpenAI streaming Responses](https://developers.openai.com/api/docs/guides/streaming-responses) documents SSE output deltas, completion and error events. T021A uses this protocol for the first iPhone remote run.
- [Expo Modules](https://docs.expo.dev/modules/overview/) is the native extension route; [Expo SQLite](https://docs.expo.dev/versions/latest/sdk/sqlite/) is the phone database option. These need development/native builds for the planned capabilities.
- [React Native Paper](https://oss.callstack.com/react-native-paper/) provides native UI primitives with LocalLab semantic tokens.
- [Tauri sidecars](https://v2.tauri.app/develop/sidecar/) and [Next static export in Tauri](https://v2.tauri.app/start/frontend/nextjs/) inform the Mac companion and later desktop UI.
- [llama.rn](https://github.com/mybigday/llama.rn), [MLX Swift](https://github.com/ml-explore/mlx-swift-lm) and [Apple Core ML Stable Diffusion](https://github.com/apple-aiml-research/ml-stable-diffusion) are candidate native engines. T005B–D prove actual hardware/architecture/version compatibility before dependent runtime work.
- [Better Auth Expo integration](https://better-auth.com/docs/integrations/expo) informs optional accounts; [RevenueCat Expo installation](https://www.revenuecat.com/docs/getting-started/installation/expo) informs purchase wiring. T159E verifies real Apple sandbox/Family Sharing; T125 verifies Google.

## Decisions workers can execute without re-opening scope

| Topic | Choice | Owner/gate |
|---|---|---|
| Order | Working offline GGUF and OpenAI iPhone T158, working full-feature iPhone T128, then deep iPhone T159 while iPad/Android/full desktop are built; final T135/T127 | Coordinator |
| Minimum targets | iOS 17+ iPhone first; iPadOS 17+, Android API 29+ and macOS 14+ host/later full desktop. T001 pins exact working toolchains. | T001/T005 |
| Local/online boundary | No account for offline chat. Cloud, relay, backup, community, analytics and purchases require explicit choices. | T123 |
| First-run OpenAI endpoint | Default to `https://api.openai.com/v1/responses`; accept a user-entered HTTPS Responses endpoint URL only for a compatible server. Require user-supplied key and model ID, never bundle a project key, store the user key through SecretStore, stream text/cancel via RunEvent, and keep generic Chat Completions-compatible servers in T020. A controlled remote fixture is bounded first-run evidence when no paid key exists; T159A requires live OpenAI proof. | T021A/T158/T159A |
| Identity/sync | UUIDv7 + hybrid logical clock, copy-phone/copy-Mac/merge, tombstones, opt-in entity scopes. | T003/T098 |
| Remote protocol | Own QR v1 and opaque encrypted relay; no claimed original-app compatibility. | T007/T093/T103 |
| Automation scheme | Use `locallab://shortcut/...` with typed validated payloads; never use another product's URI scheme. | T116 |
| Group/Arena bounds | Up to five group participants and four Arena contestants; local leases serialize constrained hardware. | T057/T059 |
| Tool budget | Eight default assistant/tool cycles; unlimited toggle removes cycle count only, retaining CPU/time/output/consent bounds. | T062/T070 |
| Entitlement | Free local path complete. Optional production Pro covers hosted search and selected premium cloud/group/Arena/voice settings; seven-day preview is a project default to validate in T107. | T107/T112 |
| Capabilities/errors | yes/no/unknown with typed backend identity/recovery. | T015/T025 |
| Image/video | Core ML local on eligible iPhone; A1111/ComfyUI LAN/Mac host; ComfyUI video as queued job media. | T092/T159C |
| Verification | Quick smoke with implementation; exhaustive real-device/service proof only after working builds. | T128/T159/T121 |

A failed T005 probe triggers a documented contract-preserving replacement before dependent cards start. Do not silently drop an inventory row.
