use locallab_gguf_worker::{Backend, Worker, LLAMA_CPP_COMMIT, LLAMA_CPP_TAG};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

fn main() {
    let sidecar = std::env::var_os("LOCALLAB_LLAMA_SERVER")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("llama-server"));
    let port = std::env::var("LOCALLAB_GGUF_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4319);
    let mut worker = match Worker::new(sidecar, port) {
        Ok(worker) => worker,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    println!("event\tready\tllama.cpp={LLAMA_CPP_TAG}+{LLAMA_CPP_COMMIT}");
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let response = match line {
            Ok(line) => command(&mut worker, &line),
            Err(error) => format!("error\tcontrol_read_failed\t{}", error),
        };
        println!("{response}");
        let _ = io::stdout().flush();
        if response == "ok\tshutdown" {
            break;
        }
    }
}

fn command(worker: &mut Worker, line: &str) -> String {
    let mut parts = line.splitn(3, '\t');
    match parts.next().unwrap_or("") {
        "health" => "ok\thealth\tready".into(),
        "status" => match worker.status() { Ok(status) => format!("ok\tstatus\t{status}"), Err(error) => format!("error\t{error}") },
        "load" => {
            let model = parts.next().unwrap_or("");
            let backend = parts.next().unwrap_or("");
            match Backend::parse(backend).and_then(|backend| worker.start(PathBuf::from(model).as_path(), backend)) {
                Ok(()) => format!("event\tload_started\t{}", model.replace('\t', " ")),
                Err(error) => format!("error\t{error}"),
            }
        }
        "cancel" | "stop" => match worker.stop() { Ok(()) => "event\tstopped".into(), Err(error) => format!("error\t{error}") },
        "shutdown" => { let _ = worker.stop(); "ok\tshutdown".into() },
        _ => "error\tinvalid_request\tcommand must be health, status, load, cancel, stop, or shutdown".into(),
    }
}
