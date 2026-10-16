# Sidecar build record — apps/desktop/src-tauri/binaries

Bundled external binaries for the Windows Tauri bundle (`bundle.externalBin` in
`tauri.conf.json`). Built on this Windows host (Windows 10.0.26200, x86_64) on
2026-10-16. No signing applied.

## locallab-companion-x86_64-pc-windows-msvc.exe
- Source: this repo, `apps/companion` (crate `locallab-companion` 0.1.0)
- Built with: `cargo build --locked --release --manifest-path apps/companion/Cargo.toml` (rustc 1.94.0, x86_64-pc-windows-msvc)
- SHA-256: `55cc169253ee662a6b5bd7c3947f71263e4ba26992a88e463a21d5f54b82e727`

## locallab-gguf-worker-x86_64-pc-windows-msvc.exe
- Source: this repo, `workers/gguf` (crate `locallab-gguf-worker` 0.1.0)
- Built with: `cargo build --locked --release --manifest-path workers/gguf/Cargo.toml` (rustc 1.94.0, x86_64-pc-windows-msvc)
- SHA-256: `2d2232d8a2c624220e3ee10723dd87c9f75d9c4e8edcfc03c4c5fae21d220af5`

## llama-server-x86_64-pc-windows-msvc.exe
- Source: `ggml-org/llama.cpp` pinned per `workers/gguf/README.md` — tag `v0.4.1`, commit `b29c606` (checkout `b29c606e2`, "llama.cpp : bump version to 0.4.1 (#28900)")
- Built with: cmake 4.2.3 (Ninja generator), MinGW-w64 GCC 15.2.0 (WinLibs POSIX UCRT package), CPU-only:
  `cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=OFF -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_EXE_LINKER_FLAGS=-static -DGGML_OPENMP=OFF`
  then `cmake --build build --target llama-server`
- Flags notes: `-D_WIN32_WINNT=0x0A00` added to C/CXX flags (vendored cpp-httplib requires a Windows 10 macro under MinGW); `GGML_OPENMP=OFF` keeps the exe free of the `libgomp-1.dll` dynamic dependency — imported DLLs are system-only (ADVAPI32, KERNEL32, msvcrt, SHELL32, WS2_32).
- Runtime check: `llama-server --version` → `version: 0.4.1-dev (build 10964, commit b29c606e2) built with GNU 15.2.0 for Windows AMD64`
- SHA-256: `a5e417ccb40ffb78ae2ab89b3171b76313ea5e98225eb4f3c1f2aeafe1479183`
- Known gap: the optional llama-server web UI asset download failed during cmake configure (TLS verification); the binary embeds no static UI and serves only the HTTP API, which is all the gguf worker protocol needs.
- Note: built with GCC/MinGW, not MSVC — self-contained x64 Windows PE, ABI-compatible at the process boundary (the worker talks to it via loopback HTTP/CLI args only).

## Reproduce
Sidecar exes must be rebuilt and re-hashed on every artifact change:
```
cargo build --locked --release --manifest-path apps/companion/Cargo.toml
cargo build --locked --release --manifest-path workers/gguf/Cargo.toml
git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp && git checkout b29c606
cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=OFF -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_EXE_LINKER_FLAGS=-static -DGGML_OPENMP=OFF
cmake --build build --target llama-server
```
Copy with the `*-x86_64-pc-windows-msvc.exe` target-triple suffix per Tauri v2 convention.
