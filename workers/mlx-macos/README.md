# LocalLab MLX macOS worker

This Swift package builds `locallab-mlx-worker` for macOS 14 or later and links the same pinned `mlx-swift-lm` 2.30.6 release as the iOS adapter. Package the signed executable inside the companion app and launch it by its bundled absolute path; end users do not need Terminal, Homebrew, or a separate install.

The worker reads one JSON command per stdin line and writes versioned JSON events to stdout. Commands are `capabilities`, `load`, `generate`, `cancel`, `unload`, and `shutdown`. Worker control events carry `type`, monotonically increasing `sequence`, ISO-8601 `timestamp`, and optional `runId`. Generation events use the shared `RunStarted`, `TextDelta`, `RunCompleted`, `RunCanceled`, and `RunFailed` names and shapes from `packages/contracts`; each run has one terminal event. Stderr is reserved for diagnostics.

The manifest uses version 1, backend `mlx`, format `safetensors-folder`, quantization label, app-managed folder path, and an optional minimum-memory requirement. Model paths are local directories validated for `config.json`, safetensors weights, and absence of symlinks. The worker refuses Intel and non-macOS hosts with an actionable explanation. GGUF remains a separate backend.

Run `swift test` on macOS to build and test. A packaged/developer-signed Apple Silicon runtime smoke test is still required before marking device support verified.
