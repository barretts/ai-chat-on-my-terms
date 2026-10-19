//! Minimal Tauri v2 shell for AI Chat on My Terms.
//!
//! The window and its configuration come from `tauri.conf.json`; the frontend
//! is the static Expo web export served from `../dist/desktop-bundle`.
//! `desktop` provides the custom command layer (SQLite, keyring, save dialog)
//! consumed by the TS bridge in `apps/mobile/platform/desktop/`. Sidecar
//! executables are bundled via `bundle.externalBin` but not spawned from here.

mod desktop;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;
            // One shared SQLite connection for the app lifetime; the JS
            // `sharedMobileDatabase` port queue serializes all access through
            // the commands below.
            let db_path = app.path().app_data_dir()?.join("locallab.sqlite");
            let conn = desktop::open_connection(&db_path)?;
            app.manage(std::sync::Mutex::new(conn));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop::db_open,
            desktop::db_exec,
            desktop::db_run,
            desktop::db_all,
            desktop::db_get,
            desktop::secret_get,
            desktop::secret_set,
            desktop::secret_delete,
            desktop::files_save
        ])
        .run(tauri::generate_context!())
        .expect("error while running the AI Chat on My Terms desktop shell");
}
