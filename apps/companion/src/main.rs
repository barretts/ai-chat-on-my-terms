use std::env;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::ExitCode;
use std::time::Duration;

const DEFAULT_ADDR: &str = "127.0.0.1:4318";

fn main() -> ExitCode {
    #[cfg(target_os = "macos")]
    let _local_storage = match open_local_storage() {
        Ok(storage) => storage,
        Err(error) => {
            eprintln!("could not open companion local storage: {error}");
            return ExitCode::FAILURE;
        }
    };
    let address = env::var("LOCALLAB_COMPANION_ADDR").unwrap_or_else(|_| DEFAULT_ADDR.to_owned());
    let listener = match TcpListener::bind(&address) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("could not bind companion health server at {address}: {error}");
            return ExitCode::FAILURE;
        }
    };

    println!("AI Chat Connect health server listening at http://{address}/health");
    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => handle_connection(stream),
            Err(error) => eprintln!("companion connection failed: {error}"),
        }
    }

    ExitCode::SUCCESS
}

#[cfg(target_os = "macos")]
fn open_local_storage(
) -> Result<locallab_companion::storage::CompanionStorage, Box<dyn std::error::Error>> {
    use std::path::PathBuf;

    let data_dir = env::var_os("LOCALLAB_COMPANION_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME")
                .map(|home| PathBuf::from(home).join("Library/Application Support/LocalLab"))
        })
        .ok_or("neither LOCALLAB_COMPANION_DATA_DIR nor HOME is set")?;
    std::fs::create_dir_all(&data_dir)?;
    Ok(locallab_companion::storage::CompanionStorage::open(
        data_dir.join("locallab.sqlite"),
    )?)
}

fn handle_connection(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut request = [0_u8; 2048];
    let read = match stream.read(&mut request) {
        Ok(read) => read,
        Err(error) => {
            eprintln!("failed to read companion request: {error}");
            return;
        }
    };
    let request_line = String::from_utf8_lossy(&request[..read]);
    let (status, body) =
        if request_line.starts_with("GET /health ") || request_line.starts_with("GET /health?") {
            (
                "200 OK",
                "{\"status\":\"ok\",\"service\":\"locallab-companion\"}",
            )
        } else {
            ("404 Not Found", "{\"error\":\"not_found\"}")
        };

    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    if let Err(error) = stream.write_all(response.as_bytes()) {
        eprintln!("failed to write companion response: {error}");
    }
}
