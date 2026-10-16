//! Minimal Tauri v2 shell for LocalLab.
//!
//! The window and its configuration come from `tauri.conf.json`; the frontend
//! is the static Next export in `../out`. Platform adapters (keyring, blob
//! bridge, job scheduler) and sidecar processes are intentionally unwired at
//! this stage — sidecar executables are bundled via `bundle.externalBin` but
//! not spawned from here. No plugins or custom commands are registered.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running LocalLab desktop shell");
}
