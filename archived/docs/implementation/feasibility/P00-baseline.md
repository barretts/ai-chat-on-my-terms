# P00 Native Feasibility Baseline

Date: 2026-09-26  
Decision state: **candidate baseline; native hardware validation pending**

## Pinned workspace candidates

| Surface | Candidate pin | Current evidence | Remaining proof |
|---|---|---|---|
| iPhone shell | Node `>=22.13.0`, pnpm `8.15.9`, Expo `57.0.25`, React Native `0.86.3`, React `19.2.3`, iOS deployment target `17.0` | Frozen install, Expo dependency check, TypeScript, and iOS JS export pass on Windows | Clean iPhone development-client build and route launch |
| Direct provider stream and local DB | Expo `expo/fetch`, `expo-sqlite` `57.0.3` | Fragmented UTF-8, cancellation, and create/close/reopen fixtures pass | Live BYOK stream/cancel and force-quit persistence on iPhone |
| Local GGUF | `llama.rn` `0.12.4`, New Architecture, C++20 plugin setting | Package fixtures cover input validation and physical-device gating | iOS native build, licensed local model run, measured memory/thermal behavior |
| Apple MLX/Core ML | `mlx-swift-lm` `2.30.6`, `ml-stable-diffusion` `1.1.1` | Upstream package manifests and products are pinned; bridge safely reports unverified engines | Swift/Xcode build, Expo autolinking, text inference, image output |
| Mac shell | Next `16.1.0`, Tauri CLI `2.0.0`, companion lockfile | Windows probe covers static build assumptions, SQLite, local HTTP, process exit | macOS 14+ arm64 Tauri build; llama.cpp sidecar is a later T029 dependency |

The llama.rn upstream notes that v0.10 and later require React Native's New
Architecture, downloads platform artifacts during installation, and needs
Expo build properties for CNG builds. Its iOS Metal compatibility has device
GPU requirements; therefore package presence and JavaScript export do not
establish device support. See the [upstream installation notes](https://github.com/mybigday/llama.rn#installation).

## Fallback decision

- Keep the direct configured-provider adapter as the network path. It resolves
  credentials at request time and sends them only in request headers.
- Treat GGUF, MLX, and Core ML as unavailable until the corresponding native
  probe returns verified device facts and a run receipt. `unknown` is never
  converted to supported.
- If MLX is unavailable, retain the GGUF option. If on-device image generation
  is unavailable, offer a configured remote image provider. If neither an
  on-device model nor configured network provider is available, report the
  capability as unavailable and preserve local conversation data.
- Keep the Mac companion health/control process separate from inference until
  T029 supplies a pinned llama.cpp sidecar and lifecycle contract.

## Measurement gate

Do not set numeric startup, first-token, sustained-generation, memory, battery,
or thermal targets from fixture results. T005 requires those values to be
measured on one minimum-supported and one higher-memory iPhone with exact model,
iOS version, app build, and licensed GGUF hash. No such device or model artifact
is available on the current Windows host. The GGUF probe has a 30-second hard
generation stop to keep an individual check bounded; this is a test timeout,
not a performance acceptance target. Record peak memory and thermal state in
the device evidence when hardware is available.

## Exact local checks

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:contracts
pnpm test:schema
pnpm test:service-contracts
pnpm test:fixtures
pnpm test:compat
pnpm test:storage
pnpm --dir apps/mobile exec expo install --check
pnpm --dir apps/mobile exec expo export --platform ios
```

These checks are fixtures or host-side package/build checks. Hardware identity,
build hashes, and a licensed model SHA-256 are intentionally left blank until
recorded from real devices; no fixture receipt can stand in for them.
