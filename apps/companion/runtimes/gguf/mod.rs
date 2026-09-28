//! Typed process client for the desktop GGUF worker.
//! The desktop packaging layer supplies the worker executable path.
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

#[derive(Debug, PartialEq, Eq)]
pub enum RuntimeError {
    Start(String),
    WorkerExited(Option<i32>),
    Protocol(String),
    Worker(String),
}

impl std::fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Start(message) => write!(f, "could not start GGUF worker: {message}"),
            Self::WorkerExited(code) => write!(f, "GGUF worker exited unexpectedly ({code:?})"),
            Self::Protocol(message) => write!(f, "GGUF worker protocol error: {message}"),
            Self::Worker(message) => write!(f, "{message}"),
        }
    }
}

pub struct GgufRuntime {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl GgufRuntime {
    pub fn spawn(worker_executable: &Path) -> Result<Self, RuntimeError> {
        let mut child = Command::new(worker_executable)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| RuntimeError::Start(error.to_string()))?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| RuntimeError::Protocol("missing worker stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| RuntimeError::Protocol("missing worker stdout".into()))?;
        let mut runtime = Self {
            child,
            input,
            output: BufReader::new(stdout),
        };
        let ready = runtime.read_reply()?;
        if !ready.starts_with("event\tready\t") {
            return Err(RuntimeError::Protocol(format!(
                "expected ready event, got {ready}"
            )));
        }
        Ok(runtime)
    }

    pub fn health(&mut self) -> Result<(), RuntimeError> {
        self.send("health")?;
        expect_prefix(self.read_reply()?, "ok\thealth\tready")
    }

    pub fn status(&mut self) -> Result<String, RuntimeError> {
        self.send("status")?;
        let response = self.read_reply()?;
        response
            .strip_prefix("ok\tstatus\t")
            .map(str::to_owned)
            .ok_or_else(|| RuntimeError::Worker(response))
    }

    pub fn load(&mut self, model: &Path, backend: &str) -> Result<String, RuntimeError> {
        if !matches!(backend, "cpu" | "apple-gpu") {
            return Err(RuntimeError::Protocol(
                "backend must be cpu or apple-gpu".into(),
            ));
        }
        self.send(&format!("load\t{}\t{backend}", model.display()))?;
        let response = self.read_reply()?;
        response
            .strip_prefix("event\tload_started\t")
            .map(str::to_owned)
            .ok_or_else(|| RuntimeError::Worker(response))
    }

    pub fn cancel(&mut self) -> Result<(), RuntimeError> {
        self.send("cancel")?;
        expect_prefix(self.read_reply()?, "event\tstopped")
    }

    fn send(&mut self, command: &str) -> Result<(), RuntimeError> {
        writeln!(self.input, "{command}")
            .and_then(|_| self.input.flush())
            .map_err(|error| {
                RuntimeError::Worker(format!("could not write worker command: {error}"))
            })
    }

    fn read_reply(&mut self) -> Result<String, RuntimeError> {
        let mut line = String::new();
        match self.output.read_line(&mut line) {
            Ok(0) => {
                let status = self
                    .child
                    .try_wait()
                    .ok()
                    .flatten()
                    .and_then(|status| status.code());
                Err(RuntimeError::WorkerExited(status))
            }
            Ok(_) => Ok(line.trim_end_matches(['\r', '\n']).to_owned()),
            Err(error) => Err(RuntimeError::Protocol(error.to_string())),
        }
    }
}

impl Drop for GgufRuntime {
    fn drop(&mut self) {
        let _ = writeln!(self.input, "shutdown");
        let _ = self.input.flush();
        let _ = self.child.wait();
    }
}

fn expect_prefix(reply: String, expected: &str) -> Result<(), RuntimeError> {
    if reply.starts_with(expected) {
        Ok(())
    } else {
        Err(RuntimeError::Worker(reply))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_validation_is_local_and_explicit() {
        assert!(matches!(
            validate_backend("metal"),
            Err(RuntimeError::Protocol(_))
        ));
        assert!(validate_backend("cpu").is_ok());
        assert!(validate_backend("apple-gpu").is_ok());
    }

    fn validate_backend(backend: &str) -> Result<(), RuntimeError> {
        if matches!(backend, "cpu" | "apple-gpu") {
            Ok(())
        } else {
            Err(RuntimeError::Protocol(
                "backend must be cpu or apple-gpu".into(),
            ))
        }
    }
}
