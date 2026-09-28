# Local GGUF worker

This crate is the desktop process supervisor and control-channel boundary for llama.cpp. It does not bundle the native executable yet. The selected source release is pinned to `ggml-org/llama.cpp` tag `v0.4.1`, commit `b29c606`; a packaging task must build that commit with Metal enabled for macOS and record a SHA-256 digest for each shipped artifact. Until then, set `LOCALLAB_LLAMA_SERVER` to a compatible local `llama-server` executable. The worker never downloads code or model files. The tag and commit are visible on the [upstream release page](https://github.com/ggml-org/llama.cpp/releases/tag/v0.4.1).

Build and test the supervisor:

```sh
cargo test --manifest-path workers/gguf/Cargo.toml --offline
cargo build --release --manifest-path workers/gguf/Cargo.toml --target aarch64-apple-darwin
```

The worker reads one tab-delimited command per line from stdin and emits tab-delimited replies/events on stdout. Commands are `health`, `status`, `load<TAB>absolute-model-path<TAB>cpu|apple-gpu`, `cancel`, `stop`, and `shutdown`. Paths in status escape `%`, tab, CR, and LF as `%25`, `%09`, `%0D`, `%0A`. Sidecar stdout/stderr are isolated from the protocol. CPU uses zero GPU layers; Apple GPU requests 99 layers and requires a Metal-enabled sidecar. The sidecar binds only to loopback. `cancel`/`stop` kills and reaps the child; worker drop also cleans it up. Crashes become `sidecar_crashed` errors on the next status/load operation.

This source-level supervisor can be built and tested on Windows. A Mac artifact build, Metal generation, packaged binary digest, and physical offline generation remain unverified until a Mac host and a redistributable GGUF fixture are available.
