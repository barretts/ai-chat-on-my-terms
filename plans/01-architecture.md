# Architecture and delivery shape

> Local workstation: Windows; run workspace commands in PowerShell. Follow the [PowerShell environment guide](POWERSHELL.md).

## Product and platforms

Project name: **AI Chat on My Terms** (renamed from LocalLab; the `locallab` bundle ID, EAS slug, package/crate names and protocol constants stay as technical identifiers — see the README naming note). First target: iPhone on iOS 17+. The required macOS 14+ companion hosts remote models/voice, encrypted relay routes, USB and sync. A native iPad layout and Pencil workstream starts after the working iPhone milestone, as do Android API 29+ and full Mac/Windows/Linux desktop clients. Own pairing between this project's clients and companion works; interoperability with the original app is not assumed.

The app is local-first: install, load/download a model and chat without an account or hosted app service. The first iPhone build also lets the user configure an OpenAI Responses endpoint, API key and model ID, then chat directly with that endpoint. LAN servers are direct; cloud model requests go only to the selected provider. Remote access, backup, account, support/community, hosted search and purchases are explicit optional paths. Working milestones may use deterministic fixtures for optional external services; later verification shards prove the live routes before release.

## Fixed stack and boundaries

- Monorepo: pnpm workspaces, strict TypeScript and pinned native package versions. T001 creates the runnable iPhone shell and Git history; T001A builds Mac/API shells concurrently. T002/T003/T003A own contracts, core migrations and later schema extensions.
- iPhone: Expo/React Native/Expo Router development builds with React Native Paper primitives and project tokens. Swift/Expo Modules provide local MLX, Core ML image generation, iCloud, widgets, App Intents, CallKit and background jobs. Android Kotlin ports start after T128.
- Desktop/host: Tauri 2 shell hosting the iPhone app's Expo web static export as the **webview** UI, with a thin Rust bridge: rusqlite SQLite commands behind the shared `SQLiteDatabasePort`, OS keyring for provider keys, native save dialog for archive export. (2026-10-19 amendment: the planned separate Next.js/shadcn desktop UI was dropped as a duplicate UI fork — the web-mode layout in `docs/collapsible-layout.md` §Desktop is the desktop UI, so feature parity never forks business rules or screens.) A Rust Mac companion owns the first-release tray, filesystem, native workers and sharing. Windows/Linux packaging follows T134.
- Shared packages: contracts, schema/storage, chat/context/parameters, provider adapters, Personas/memory/groups/Arena, tools, speech/media, pairing/sync and testkit. Each card owns a disjoint subpath and imports only published ports.
- Native inference: pinned llama.rn/llama.cpp GGUF on iPhone, Swift MLX on compatible Apple hardware, llama.cpp/MLX workers on Mac, later Android GGUF and desktop sidecars. Model downloads/imports use durable native jobs.
- Optional services: Fastify, Better Auth, PostgreSQL and S3-compatible blobs for opted-in search, backup, catalog, support and entitlements. A separate opaque WebSocket relay forwards encrypted frames and stores no chat history. RevenueCat handles native store entitlement wiring.
- Local persistence: Expo SQLite on phone, Tauri SQLite on desktop, managed blobs for large assets, OS secure store for secrets. Chat data remains local unless the user explicitly selects a remote/sync/backup path. The first-run OpenAI key stays in the phone's secure store and is resolved only for its validated endpoint.

[AI Elements setup](https://elements.ai-sdk.dev/docs/setup) is web-specific, so it belongs in the later desktop webview. The iPhone UI is native React Native. The Vercel AI SDK can bridge streaming/messages in Expo; T005A checks the pinned transport and `expo/fetch` behavior. A direct HTTP-to-RunEvent adapter is the contract-preserving fallback. T005B–D independently certify iPhone GGUF, Apple ML/image and Mac host compatibility before runtime work depends on them.

## Runtime flow

1. The composer creates stable local conversation/message/run IDs, resolves provider/model and effective global → model → Persona → chat parameters, capabilities, attachments and permitted memory.
2. Context packing reserves output tokens and applies the selected overflow policy. Provider/native runner emits ordered RunEvents; projection updates the native transcript and SQLite. The app never treats a rendered string as the only tool/reasoning truth.
3. Tools, voice, image and background extraction are separately authorized cancellable jobs tied to run/message IDs. Model leases protect group/Arena concurrency from local eviction.
4. The Mac companion exposes only configured model/image/audio routes. QR pairing transfers a project-generated secret; relay forwards ciphertext. Sync moves opted-in entities and blobs with tombstones, never API keys, downloaded models or PIN.
5. All adapters return yes/no/unknown capability and typed backend errors. Optional accounts/backup/analytics are activated only with the user's choice and consent.

## Execution order

T158 first proves offline local chat and directly configured OpenAI Responses chat. T021A builds the minimal remote adapter alongside GGUF work; T021 develops advanced OpenAI/Anthropic behavior independently, and T025 composes both. Other feature lanes integrate through T025/T036/T049/T061/T070/T083/T092/T103. T128 wires a working iPhone build. T122/T123/T159A–H are **later deep testing**, while iPad, Android and full desktop implementation proceeds in parallel. T159 is the verified iPhone internal release; T121/T135/T127 verify and close the cross-platform scope. Phase numbers do not act as global barriers.
