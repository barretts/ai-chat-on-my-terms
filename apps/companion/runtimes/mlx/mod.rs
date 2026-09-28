//! Optional process client for the bundled Apple Silicon MLX worker.
//! The worker executable is installed inside the signed app bundle by packaging.
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

#[derive(Debug, PartialEq, Eq)]
pub enum RuntimeError {
    Unsupported(String),
    Start(String),
    WorkerExited(Option<i32>),
    Protocol(String),
}

impl std::fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported(message) | Self::Start(message) | Self::Protocol(message) => {
                f.write_str(message)
            }
            Self::WorkerExited(code) => write!(f, "MLX worker exited unexpectedly ({code:?})"),
        }
    }
}

pub struct MlxRuntime {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl MlxRuntime {
    pub fn spawn(worker: &Path) -> Result<Self, RuntimeError> {
        if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            return Err(RuntimeError::Unsupported(
                "MLX local inference requires macOS on Apple Silicon; use GGUF or a remote provider.".into(),
            ));
        }
        let mut child = Command::new(worker)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                RuntimeError::Start(format!("could not start bundled MLX worker: {error}"))
            })?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| RuntimeError::Protocol("worker stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| RuntimeError::Protocol("worker stdout unavailable".into()))?;
        let mut runtime = Self {
            child,
            input,
            output: BufReader::new(stdout),
        };
        let ready = runtime.next_event()?;
        if !ready.contains("\"type\":\"WorkerReady\"") {
            return Err(RuntimeError::Protocol(format!(
                "expected MLX ready event, got {ready}"
            )));
        }
        Ok(runtime)
    }

    /// Sends a single JSON command. Newlines are rejected to preserve framing.
    pub fn send_json(&mut self, command: &str) -> Result<(), RuntimeError> {
        if command.contains(['\r', '\n']) || !command.trim_start().starts_with('{') {
            return Err(RuntimeError::Protocol(
                "worker command must be one JSON object per line".into(),
            ));
        }
        writeln!(self.input, "{command}")
            .and_then(|_| self.input.flush())
            .map_err(|error| {
                RuntimeError::Protocol(format!("could not write MLX command: {error}"))
            })
    }

    /// Reads the next complete versioned event. Callers own schema decoding and run projection.
    pub fn next_event(&mut self) -> Result<String, RuntimeError> {
        let mut line = String::new();
        match self.output.read_line(&mut line) {
            Ok(0) => {
                let code = self
                    .child
                    .try_wait()
                    .ok()
                    .flatten()
                    .and_then(|status| status.code());
                Err(RuntimeError::WorkerExited(code))
            }
            Ok(_) => Ok(line.trim_end_matches(['\r', '\n']).to_owned()),
            Err(error) => Err(RuntimeError::Protocol(format!(
                "could not read MLX event: {error}"
            ))),
        }
    }

    pub fn unload(&mut self) -> Result<(), RuntimeError> {
        self.send_json(r#"{"command":"unload"}"#)
    }
}

impl Drop for MlxRuntime {
    fn drop(&mut self) {
        let _ = self.send_json(r#"{"command":"shutdown"}"#);
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_commands_must_be_one_json_line() {
        assert!(validate_command(r#"{"command":"capabilities"}"#).is_ok());
        assert!(validate_command("{}\n{} ").is_err());
        assert!(validate_command("not-json").is_err());
    }

    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    #[test]
    fn unsupported_hosts_are_gated_before_worker_launch() {
        assert!(matches!(
            MlxRuntime::spawn(Path::new("missing-worker")),
            Err(RuntimeError::Unsupported(_))
        ));
    }

    fn validate_command(command: &str) -> Result<(), RuntimeError> {
        if command.contains(['\r', '\n']) || !command.trim_start().starts_with('{') {
            Err(RuntimeError::Protocol("invalid command".into()))
        } else {
            Ok(())
        }
    }
}
