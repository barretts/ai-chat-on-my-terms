use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// llama.cpp release selected for the initial Mac sidecar integration.
/// A packaged binary must be built from this tag and its artifact checksum
/// recorded by the desktop packaging task before distribution.
pub const LLAMA_CPP_TAG: &str = "v0.4.1";
pub const LLAMA_CPP_COMMIT: &str = "b29c606";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    Cpu,
    AppleGpu,
}

impl Backend {
    pub fn parse(value: &str) -> Result<Self, WorkerError> {
        match value {
            "cpu" => Ok(Self::Cpu),
            "apple-gpu" => Ok(Self::AppleGpu),
            _ => Err(WorkerError::InvalidRequest(
                "backend must be cpu or apple-gpu".into(),
            )),
        }
    }

    pub fn gpu_layers(self) -> &'static str {
        match self {
            Self::Cpu => "0",
            Self::AppleGpu => "99",
        }
    }
}

#[derive(Debug)]
pub enum WorkerError {
    InvalidRequest(String),
    ModelPath(String),
    Start(String),
    SidecarExited(i32),
}

impl std::fmt::Display for WorkerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRequest(message) => write!(f, "invalid_request: {message}"),
            Self::ModelPath(message) => write!(f, "missing_model: {message}"),
            Self::Start(message) => write!(f, "sidecar_start_failed: {message}"),
            Self::SidecarExited(code) => write!(f, "sidecar_crashed: exit code {code}"),
        }
    }
}

pub struct Worker {
    sidecar: PathBuf,
    port: u16,
    child: Option<Child>,
    model: Option<PathBuf>,
    backend: Option<Backend>,
}

impl Worker {
    pub fn new(sidecar: impl Into<PathBuf>, port: u16) -> Result<Self, WorkerError> {
        if port == 0 {
            return Err(WorkerError::InvalidRequest("port must be 1-65535".into()));
        }
        Ok(Self {
            sidecar: sidecar.into(),
            port,
            child: None,
            model: None,
            backend: None,
        })
    }

    pub fn start(&mut self, model: &Path, backend: Backend) -> Result<(), WorkerError> {
        self.refresh()?;
        if self.child.is_some() {
            return Err(WorkerError::InvalidRequest(
                "a model is already loaded; stop it first".into(),
            ));
        }
        if !model.is_file() {
            return Err(WorkerError::ModelPath(model.display().to_string()));
        }
        if model.to_string_lossy().contains(['\t', '\r', '\n']) {
            return Err(WorkerError::InvalidRequest(
                "model path contains a control character".into(),
            ));
        }
        let mut command = Command::new(&self.sidecar);
        command
            .arg("--model")
            .arg(model)
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(self.port.to_string())
            .arg("--n-gpu-layers")
            .arg(backend.gpu_layers())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(target_os = "macos")]
        if backend == Backend::AppleGpu {
            // llama.cpp selects Metal when built with GGML_METAL. The packaged
            // Mac sidecar is required to enable that backend at build time.
        }
        let child = command
            .spawn()
            .map_err(|error| WorkerError::Start(error.to_string()))?;
        self.child = Some(child);
        self.model = Some(model.to_path_buf());
        self.backend = Some(backend);
        Ok(())
    }

    pub fn status(&mut self) -> Result<String, WorkerError> {
        self.refresh()?;
        Ok(match (&self.child, &self.model, self.backend) {
            (Some(_), Some(model), Some(backend)) => format!(
                "loaded\t{}\t{}\t{}",
                backend_name(backend),
                self.port,
                escape(model.to_string_lossy().as_ref())
            ),
            _ => "idle".into(),
        })
    }

    pub fn stop(&mut self) -> Result<(), WorkerError> {
        if let Some(mut child) = self.child.take() {
            if let Some(status) = child
                .try_wait()
                .map_err(|error| WorkerError::Start(error.to_string()))?
            {
                self.clear_model();
                return Err(WorkerError::SidecarExited(status.code().unwrap_or(-1)));
            }
            #[cfg(unix)]
            {
                // The sidecar is isolated in its own process group so auxiliary
                // inference threads/helpers cannot outlive cancellation.
                let result = unsafe { kill(-(child.id() as i32), 15) };
                if result != 0 {
                    child.kill().map_err(|error| {
                        WorkerError::Start(format!("could not terminate sidecar: {error}"))
                    })?;
                }
            }
            #[cfg(not(unix))]
            child.kill().map_err(|error| {
                WorkerError::Start(format!("could not terminate sidecar: {error}"))
            })?;
            child
                .wait()
                .map_err(|error| WorkerError::Start(format!("could not reap sidecar: {error}")))?;
        }
        self.clear_model();
        Ok(())
    }

    fn refresh(&mut self) -> Result<(), WorkerError> {
        if let Some(child) = self.child.as_mut() {
            if let Some(status) = child
                .try_wait()
                .map_err(|error| WorkerError::Start(error.to_string()))?
            {
                self.child = None;
                self.clear_model();
                return Err(WorkerError::SidecarExited(status.code().unwrap_or(-1)));
            }
        }
        Ok(())
    }

    fn clear_model(&mut self) {
        self.model = None;
        self.backend = None;
    }
}

#[cfg(unix)]
unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn backend_name(backend: Backend) -> &'static str {
    match backend {
        Backend::Cpu => "cpu",
        Backend::AppleGpu => "apple-gpu",
    }
}

fn escape(value: &str) -> String {
    value
        .replace('%', "%25")
        .replace('\t', "%09")
        .replace('\r', "%0D")
        .replace('\n', "%0A")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_options_are_explicit_and_unknown_values_fail() {
        assert_eq!(Backend::parse("cpu").unwrap().gpu_layers(), "0");
        assert_eq!(Backend::parse("apple-gpu").unwrap().gpu_layers(), "99");
        assert!(Backend::parse("cuda").is_err());
    }

    #[test]
    fn missing_model_is_actionable_and_does_not_launch() {
        let mut worker = Worker::new("not-a-sidecar", 18080).unwrap();
        assert!(matches!(
            worker.start(Path::new("missing.gguf"), Backend::Cpu),
            Err(WorkerError::ModelPath(_))
        ));
        assert_eq!(worker.status().unwrap(), "idle");
    }

    #[test]
    fn sidecar_launch_failure_is_reported() {
        let model = std::env::temp_dir().join(format!("locallab-{}.gguf", std::process::id()));
        std::fs::write(&model, b"test").unwrap();
        let mut worker = Worker::new("locallab-no-such-llama-server", 18081).unwrap();
        assert!(matches!(
            worker.start(&model, Backend::Cpu),
            Err(WorkerError::Start(_))
        ));
        let _ = std::fs::remove_file(model);
    }

    #[cfg(unix)]
    #[test]
    fn abnormal_exit_is_reported_as_a_crash() {
        let model = std::env::temp_dir().join(format!("locallab-{}.gguf", std::process::id()));
        std::fs::write(&model, b"test").unwrap();
        let mut worker = Worker::new("/bin/false", 18082).unwrap();
        worker.start(&model, Backend::Cpu).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(matches!(
            worker.status(),
            Err(WorkerError::SidecarExited(_))
        ));
        let _ = std::fs::remove_file(model);
    }
}
