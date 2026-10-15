/// Credential APIs backed by the native OS secure store.
pub mod secrets;

pub mod runtimes {
    #[path = "../../runtimes/gguf/mod.rs"]
    pub mod gguf;

    #[path = "../../runtimes/mlx/mod.rs"]
    pub mod mlx;
}

pub mod remote {
    #[path = "../../remote/crypto/mod.rs"]
    pub mod crypto;

    #[path = "../../remote/routes/mod.rs"]
    pub mod routes;

    #[path = "../../remote/media/mod.rs"]
    pub mod media;
}

/// T101 (RE-11): authenticated iPhone-to-Mac USB route (framing,
/// handshake over pairing proofs, mode/device state).
pub mod usb {
    #[path = "../../usb/frames/mod.rs"]
    pub mod frames;

    #[path = "../../usb/session/mod.rs"]
    pub mod session;

    #[path = "../../usb/guard/mod.rs"]
    pub mod guard;
}

/// Companion feature surfaces (menu-bar / tray behavior layer).
pub mod features {
    #[path = "../../features/sync-setup/mod.rs"]
    pub mod sync_setup;

    #[path = "../../features/sharing/mod.rs"]
    pub mod sharing;
}

/// T102 (RE-07, RE-10, UI-15): startup, window-close/quit, sleep/wake
/// and protocol-version compatibility decisions.
pub mod lifecycle {
    #[path = "../../lifecycle/mod.rs"]
    pub mod service;
}

/// T103 (ER-07): composition gate wiring remote/USB session admission,
/// sealed chat serving and the sync opt-in decision into one host path.
pub mod composition {
    #[path = "../../composition/remote/mod.rs"]
    pub mod remote;
}

/// T116 (AU-04, AU-05): desktop CLI equivalent of the typed
/// deep-link automation family (`locallab://shortcut/...`).
#[path = "../automation/mod.rs"]
pub mod automation;

#[cfg(target_os = "macos")]
#[path = "../platform/storage/mod.rs"]
pub mod storage;
