# Desktop app (Windows)

The desktop client is a Tauri shell whose webview hosts the same Expo web
export as the browser build. Persistence roles run natively: SQLite through
Rust commands (rusqlite) at a real file, provider keys through the Windows
Credential Manager, archive export through a native save dialog. The planned
separate desktop UI was dropped (see `plans/07-sources-and-decisions.md`,
2026-10-19 amendment).

## Prerequisites (Windows 10/11)

- Node 22+, pnpm 8.15.9, Rust stable (MSVC), WebView2 runtime (ships with
  Windows 11; the installer bootstraps it on Windows 10).
- `pnpm install` at the repo root.

## Run from source

```powershell
pnpm desktop:dev     # static export if missing, then tauri dev window
```

Edit app code under `apps/mobile/` as usual; re-run the export with
`pnpm desktop:bundle` and reload the window (`Ctrl+R`). The dev script skips
the export when `apps/desktop/dist/desktop-bundle/` already exists.

## Build installers

```powershell
pnpm desktop:build   # static export + cargo release + WiX MSI + NSIS setup
```

Artifacts land in `apps/desktop/src-tauri/target/release/bundle/`
(`msi/AI Chat on My Terms_*.msi`, `nsis/*-setup.exe`). NSIS installs
per-user (`installMode: currentUser`, no elevation) because all app data is
per-user; the MSI is machine-scoped (standard MSI behavior) and needs an
elevated install. Builds are unsigned; signing/notarization is a release
gate with a named external credential owner (T124). Native sidecars are
pinned binaries under `apps/desktop/src-tauri/binaries/` (hashes in
`BUILD-RECORD.md`).

## Data locations

- SQLite: `%APPDATA%\app.locallab.desktop\locallab.sqlite` (WAL).
- Web storage (attachments/blobs, IndexedDB): `%LOCALAPPDATA%\app.locallab.desktop\EBWebView`.
- Provider keys: Windows Credential Manager, service
  `com.locallab.provider-secrets`. Never stored in SQLite or the bundle.
- Extracted sidecars land in the SQLite folder on first run.

## Smoke test against the built app

```powershell
pnpm desktop:build   # once
pnpm test:desktop-ui # tests/smoke/desktop-full — see its README
```

The harness launches the exe (release build, or an installed copy via
`LOCALLAB_DESKTOP_EXE`) with WebView2 remote debugging (port 9222), drives
onboarding → a local OpenAI-compatible fixture provider (port 4599) → a
streamed chat reply, restarts the app to verify history reopening, the
transcript rows in the roaming SQLite file (bridge, not browser storage)
and that the stored key still works without re-entry, then imports a chat
archive through the file chooser (ZIP serialized by the app's own
exporter) and proves the export button raises the native Win32 save
dialog. It is fixture evidence, not live-vendor proof. One app instance
at a time: the WebView2 profile locks the data directory.

## Install/uninstall lifecycle (verified 2026-10-19)

`nsis/AI Chat on My Terms_0.1.0_x64-setup.exe /S` installed per-user to
`%LOCALAPPDATA%\AI Chat on My Terms`, and the same full smoke passed
against the installed exe (`1 passed (47.4s)`). `uninstall.exe /S` removed
the install dir and the HKCU uninstall key, including the sidecar binaries
extracted on first run, but deliberately keeps user data: the roaming
SQLite file and Credential Manager entries survive for reinstall. To erase
everything, delete `%APPDATA%\app.locallab.desktop` and the
`com.locallab.provider-secrets` credentials (e.g. `cmdkey /delete:`).
The MSI is machine-scoped: silent unprivileged install correctly fails with
Error 1925; it needs an elevated session (CI runners qualify).

## Not yet available

- macOS/Linux installers: blocked on their native sidecar binaries (T164,
  T166); the CI jobs fail fast with that pointer.
- Signed/notarized releases: credential owner pending (T124 gate).
- Live-vendor and Mac/Linux clean-install evidence; elevated MSI
  clean-install on a CI runner.
