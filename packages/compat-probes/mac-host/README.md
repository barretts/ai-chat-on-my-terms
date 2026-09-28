# Mac host compatibility probe

This probe exercises the available host pieces without credentials or model files: SQLite create/read at the macOS Application Support path, local HTTP transport to the Rust companion, and observable child-process termination. On Windows/Linux it uses a temporary SQLite path and returns exit code 2 after printing the explicit Mac build gate.

Run from the repository root on macOS 14+:

```sh
pnpm --filter @locallab/compat-mac-host probe
pnpm --filter @locallab/desktop build
pnpm --filter @locallab/desktop exec tauri build --target aarch64-apple-darwin
cargo build --locked --release --target aarch64-apple-darwin --manifest-path apps/companion/Cargo.toml
```

Capture exact host evidence with `sw_vers`, `rustc --version --verbose`, `rustup target list --installed`, `cargo tree --manifest-path apps/companion/Cargo.toml`, `pnpm --filter @locallab/desktop exec tauri --version`, and `sqlite3 --version`. The workspace pins Next 16.1.0, Tauri CLI 2.0.0, Rust dependencies in `Cargo.lock`, and the root Node/pnpm versions. `tauri build` consumes the static export in `apps/desktop/out` and produces the signed/unsigned native bundle for the current host.

This probe does not certify a Mac build on Windows. The Rust companion currently exposes a local health/control endpoint; the llama.cpp inference sidecar and its source revision are owned by T029 and are intentionally reported pending here. After T029 lands, add its pinned artifact and health/lifecycle check to this probe before marking the llama.cpp portion passed.
