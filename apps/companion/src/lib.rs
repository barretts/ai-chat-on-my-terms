/// Credential APIs backed by the native OS secure store.
pub mod secrets;

pub mod runtimes {
    #[path = "../../runtimes/gguf/mod.rs"]
    pub mod gguf;

    #[path = "../../runtimes/mlx/mod.rs"]
    pub mod mlx;
}

#[cfg(target_os = "macos")]
#[path = "../platform/storage/mod.rs"]
pub mod storage;
