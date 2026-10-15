//! T095: companion model routing and health (RE-03/RE-05) for the project's
//! own remote pairing (T093 crypto, T094 opaque relay). The mobile peer asks
//! the companion to run chat traffic against locally configured backends; the
//! companion NEVER proxies arbitrary destinations — only explicit loopback
//! origins from the configured allowlist, and errors always name the backend
//! they came from (backend-specific setup errors).
//!
//! Origin shape matches the frozen provider rule
//! (`packages/providers/compatible-local`): exact `http://<loopback>:<port>`
//! only — no credentials, paths, or query.

use std::collections::BTreeMap;
use std::fmt;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub const CONNECT_TIMEOUT: Duration = Duration::from_millis(750);
pub const READ_TIMEOUT: Duration = Duration::from_millis(5_000);
const MAX_HEAD_BYTES: usize = 65_536;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutingCargoError {
    pub kind: &'static str,
    pub message: String,
}

impl RoutingCargoError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
    fn unconfigured(message: impl Into<String>) -> Self {
        Self::new("unconfigured", message)
    }
    fn not_allowlisted(message: impl Into<String>) -> Self {
        Self::new("not_allowlisted", message)
    }
    fn unreachable(message: impl Into<String>) -> Self {
        Self::new("unreachable", message)
    }
    fn stopped(message: impl Into<String>) -> Self {
        Self::new("stopped", message)
    }
    fn malformed(message: impl Into<String>) -> Self {
        Self::new("malformed", message)
    }
}

impl fmt::Display for RoutingCargoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RoutingCargoError {}

pub type Result<T, E = RoutingCargoError> = core::result::Result<T, E>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind {
    Local,
    LmStudio,
    Ollama,
    OmLx,
}

impl BackendKind {
    pub fn id(self) -> &'static str {
        match self {
            BackendKind::Local => "local",
            BackendKind::LmStudio => "lmstudio",
            BackendKind::Ollama => "ollama",
            BackendKind::OmLx => "omlx",
        }
    }

    /// Human-facing backend identity; every routing error names it (RE-05).
    pub fn label(self) -> &'static str {
        match self {
            BackendKind::Local => "Local runtime",
            BackendKind::LmStudio => "LM Studio",
            BackendKind::Ollama => "Ollama",
            BackendKind::OmLx => "oMLX",
        }
    }

    pub fn from_id(id: &str) -> Option<BackendKind> {
        match id {
            "local" => Some(BackendKind::Local),
            "lmstudio" => Some(BackendKind::LmStudio),
            "ollama" => Some(BackendKind::Ollama),
            "omlx" => Some(BackendKind::OmLx),
            _ => None,
        }
    }

    fn health_path(self) -> &'static str {
        match self {
            BackendKind::Local => "/health",
            BackendKind::LmStudio => "/v1/models",
            BackendKind::Ollama => "/api/version",
            BackendKind::OmLx => "/health",
        }
    }

    fn chat_path(self) -> &'static str {
        match self {
            BackendKind::Ollama => "/api/chat",
            _ => "/v1/chat/completions",
        }
    }
}

/// Parses and allowlists an exact loopback origin. Returns the socket target.
fn validate_origin(kind: BackendKind, origin: &str) -> Result<SocketAddr> {
    let reject = |why: &str| {
        Err(RoutingCargoError::not_allowlisted(format!(
            "{} route origin {origin} is not allowlisted ({why})",
            kind.label()
        )))
    };
    let Some(rest) = origin.strip_prefix("http://") else {
        return reject("only http:// origins are supported");
    };
    if rest.contains('/') || rest.contains('?') || rest.contains('@') {
        return reject("origin must not carry paths, query or credentials");
    }
    let (host_text, port_text) = match rest.rsplit_once(':') {
        Some(pair) => pair,
        None => return reject("origin must include an explicit port"),
    };
    let Ok(port) = port_text.parse::<u16>() else {
        return reject("port is not a number");
    };
    if port == 0 {
        return reject("port must be non-zero");
    }
    let host = host_text.trim_matches(|c| c == '[' || c == ']');
    let literal = match host {
        "localhost" => IpAddr::V4(Ipv4Addr::LOCALHOST),
        _ => match host.parse::<IpAddr>() {
            Ok(addr) => addr,
            Err(_) => return reject("host is not a loopback literal"),
        },
    };
    let loopback = match literal {
        IpAddr::V4(v4) => v4.is_loopback() || (v4.octets()[0] == 127),
        IpAddr::V6(v6) => v6 == Ipv6Addr::LOCALHOST,
    };
    if !loopback {
        return reject("host must be loopback (127.x / localhost / ::1)");
    }
    Ok(SocketAddr::new(literal, port))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteConfig {
    pub route_id: String,
    pub kind: BackendKind,
    pub origin: String,
}

/// Frozen configured-route table: every entry passed origin validation at
/// configure time, so resolve() never re-parses and nothing else is reachable.
#[derive(Debug, Clone)]
pub struct RouteRegistry {
    by_id: BTreeMap<String, RouteConfig>,
}

impl RouteRegistry {
    pub fn configure(configs: Vec<RouteConfig>) -> Result<RouteRegistry> {
        let mut by_id = BTreeMap::new();
        for config in configs {
            validate_origin(config.kind, &config.origin)?;
            if by_id.contains_key(&config.route_id) {
                return Err(RoutingCargoError::not_allowlisted(format!(
                    "duplicate route id {}",
                    config.route_id
                )));
            }
            by_id.insert(config.route_id.clone(), config);
        }
        Ok(RouteRegistry { by_id })
    }

    pub fn resolve(&self, route_id: &str) -> Result<&RouteConfig> {
        self.by_id.get(route_id).ok_or_else(|| {
            RoutingCargoError::unconfigured(format!(
                "route {route_id} is not a configured route; refusing to proxy arbitrary destinations"
            ))
        })
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendHealth {
    pub route_id: String,
    pub backend: &'static str,
    pub ready: bool,
    pub detail: Option<String>,
}

struct Head {
    status: u16,
    content_length: Option<usize>,
}

fn connect(origin: &str, kind: BackendKind) -> Result<TcpStream> {
    let addr = validate_origin(kind, origin)?;
    let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|err| {
        RoutingCargoError::unreachable(format!("{} is not reachable at {origin}: {err}", kind.label()))
    })?;
    stream
        .set_read_timeout(Some(READ_TIMEOUT))
        .map_err(|err| RoutingCargoError::new("io", format!("set_read_timeout: {err}")))?;
    Ok(stream)
}

fn send_request(
    stream: &mut TcpStream,
    kind: BackendKind,
    method: &str,
    path: &str,
    origin: &str,
    body: Option<&[u8]>,
) -> Result<()> {
    let authority = origin.strip_prefix("http://").ok_or_else(|| {
        RoutingCargoError::not_allowlisted(format!("{} origin {origin} is malformed", kind.label()))
    })?;
    let mut head = format!(
        "{method} {path} HTTP/1.0\r\nHost: {authority}\r\nConnection: close\r\n"
    );
    if let Some(body) = body {
        head.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    head.push_str("\r\n");
    stream
        .write_all(head.as_bytes())
        .and_then(|()| body.map_or(Ok(()), |body| stream.write_all(body)))
        .map_err(|err| {
            RoutingCargoError::unreachable(format!("{} write failed: {err}", kind.label()))
        })
}

fn read_head(stream: &mut TcpStream) -> Result<Head> {
    let mut buffer = Vec::new();
    let mut byte = [0u8; 1];
    while !buffer.ends_with(b"\r\n\r\n") {
        if buffer.len() >= MAX_HEAD_BYTES {
            return Err(RoutingCargoError::malformed("backend response head too large"));
        }
        match stream.read(&mut byte) {
            Ok(0) => {
                return Err(RoutingCargoError::stopped(
                    "backend closed before the response head was complete".to_string(),
                ))
            }
            Ok(_) => buffer.push(byte[0]),
            Err(err) => return Err(RoutingCargoError::stopped(format!("backend read failed mid-response: {err}"))),
        }
    }
    let head = String::from_utf8_lossy(&buffer);
    let status_line = head
        .lines()
        .next()
        .ok_or_else(|| RoutingCargoError::malformed("missing status line"))?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| RoutingCargoError::malformed("bad status line"))?;
    let content_length = head
        .lines()
        .find(|line| line[..line.find(':').unwrap_or(0)].eq_ignore_ascii_case("content-length"))
        .and_then(|line| line.split_once(':'))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok());
    Ok(Head { status, content_length })
}

/// Liveness + readiness for one configured route. A refused/unreachable
/// backend is a setup error and names the backend (RE-05).
pub fn check_health(config: &RouteConfig) -> BackendHealth {
    let probe = (|| -> Result<String> {
        let mut stream = connect(&config.origin, config.kind)?;
        send_request(&mut stream, config.kind, "GET", config.kind.health_path(), &config.origin, None)?;
        let head = read_head(&mut stream)?;
        if head.status >= 500 {
            return Err(RoutingCargoError::stopped(format!(
                "{} health endpoint returned {}",
                config.kind.label(),
                head.status
            )));
        }
        Ok(format!("{} ready ({} {})", config.kind.label(), head.status, config.kind.health_path()))
    })();
    match probe {
        Ok(detail) => BackendHealth {
            route_id: config.route_id.clone(),
            backend: config.kind.label(),
            ready: true,
            detail: Some(detail),
        },
        Err(err) => BackendHealth {
            route_id: config.route_id.clone(),
            backend: config.kind.label(),
            ready: false,
            detail: Some(format!("{}: {}", config.kind.label(), err.message)),
        },
    }
}

pub fn health_registry(registry: &RouteRegistry) -> Vec<BackendHealth> {
    registry.by_id.values().map(check_health).collect()
}

#[derive(Debug, Clone)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

#[derive(Debug, Clone)]
pub struct CancelHandle(Arc<AtomicBool>);

impl CancelHandle {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

pub fn cancel_pair() -> (CancelToken, CancelHandle) {
    let flag = Arc::new(AtomicBool::new(false));
    (CancelToken(flag.clone()), CancelHandle(flag))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamOutcome {
    pub bytes_forwarded: usize,
    pub cancelled: bool,
}

/// Forwards a chat request against a configured route to `sink`, honoring
/// cooperative cancellation. A mid-stream backend death is a stop error that
/// names the backend; cancel is a normal lifecycle outcome (socket closed).
pub fn forward_chat_stream(
    registry: &RouteRegistry,
    route_id: &str,
    request_body: &[u8],
    cancel: &CancelToken,
    sink: &mut impl Write,
) -> Result<StreamOutcome> {
    let config = registry.resolve(route_id)?;
    let kind = config.kind;
    let mut stream = connect(&config.origin, kind)?;
    send_request(&mut stream, kind, "POST", kind.chat_path(), &config.origin, Some(request_body))?;
    let head = read_head(&mut stream)?;
    if head.status >= 400 {
        return Err(RoutingCargoError::stopped(format!(
            "{} server refused the request (status {})",
            kind.label(),
            head.status
        )));
    }
    let mut forwarded = 0usize;
    let mut chunk = [0u8; 8192];
    loop {
        if cancel.is_cancelled() {
            drop(stream);
            return Ok(StreamOutcome { bytes_forwarded: forwarded, cancelled: true });
        }
        match stream.read(&mut chunk) {
            Ok(0) => {
                if let Some(expected) = head.content_length {
                    if forwarded < expected {
                        return Err(RoutingCargoError::stopped(format!(
                            "{} stopped mid-stream after {forwarded} of {expected} bytes",
                            kind.label()
                        )));
                    }
                }
                return Ok(StreamOutcome { bytes_forwarded: forwarded, cancelled: false });
            }
            Ok(read) => {
                sink.write_all(&chunk[..read]).map_err(|err| {
                    RoutingCargoError::new("io", format!("sink write failed: {err}"))
                })?;
                forwarded += read;
            }
            Err(err) => {
                return Err(RoutingCargoError::stopped(format!(
                    "{} stream read failed after {forwarded} bytes: {err}",
                    kind.label()
                )))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;
    use std::time::Instant;

    /// Minimal loopback fake backend; returns the bound port and a join handle.
    fn spawn_backend(handler: impl Fn(&mut TcpStream) + Send + 'static, connections: usize) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let handle = thread::spawn(move || {
            for stream in listener.incoming().take(connections) {
                let mut stream = stream.expect("accept");
                handler(&mut stream);
            }
        });
        (port, handle)
    }

    fn drain_request(stream: &mut TcpStream) {
        let mut buffer = Vec::new();
        let mut byte = [0u8; 1];
        while !buffer.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).unwrap_or(0) == 0 {
                return;
            }
            buffer.push(byte[0]);
        }
        // Consume any declared body: an unread request body makes Windows
        // answer close() with RST, which would corrupt the fake-stream tests.
        let head = String::from_utf8_lossy(&buffer).to_string();
        let declared = head
            .lines()
            .find(|line| line[..line.find(':').unwrap_or(0)].eq_ignore_ascii_case("content-length"))
            .and_then(|line| line.split_once(':'))
            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        let mut remaining = declared;
        let mut trash = [0u8; 256];
        while remaining > 0 {
            let read = stream.read(&mut trash).unwrap_or(0);
            if read == 0 {
                break;
            }
            remaining -= read.min(remaining);
        }
    }

    fn ok_backend(_port: u16) -> (u16, thread::JoinHandle<()>) {
        spawn_backend(
            |stream| {
                drain_request(stream);
                stream
                    .write_all(b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                    .expect("respond");
            },
            1,
        )
    }

    fn registry_with(overrides: Vec<RouteConfig>) -> RouteRegistry {
        let configs = overrides;
        RouteRegistry::configure(configs).expect("configure")
    }

    fn route(route_id: &str, kind: BackendKind, port: u16) -> RouteConfig {
        RouteConfig {
            route_id: route_id.to_string(),
            kind,
            origin: format!("http://127.0.0.1:{port}"),
        }
    }

    #[test]
    fn arbitrary_destinations_are_denied() {
        let err = RouteRegistry::configure(vec![route("bad", BackendKind::Ollama, 11434)])
            .and_then(|_| Ok(()))
            .err();
        assert!(err.is_none(), "loopback route should configure cleanly");
        let err = RouteRegistry::configure(vec![RouteConfig {
            route_id: "evil".to_string(),
            kind: BackendKind::Ollama,
            origin: "http://proxy.example.com:11434".to_string(),
        }])
        .expect_err("remote host must be denied");
        assert_eq!(err.kind, "not_allowlisted");
        assert!(err.message.contains("Ollama"), "backend identity preserved: {err}");

        for shape in [
            "http://127.0.0.1:8080/v1",
            "http://admin@127.0.0.1:8080",
            "https://127.0.0.1:8080",
            "http://127.0.0.1",
            "http://10.0.0.5:8080",
        ] {
            let err = RouteRegistry::configure(vec![RouteConfig {
                route_id: "x".to_string(),
                kind: BackendKind::LmStudio,
                origin: shape.to_string(),
            }])
            .expect_err("must reject {shape}");
            assert_eq!(err.kind, "not_allowlisted", "{shape}");
        }
    }

    #[test]
    fn unconfigured_route_is_denied_not_proxied() {
        let (port, _server) = ok_backend(0);
        let registry = registry_with(vec![route("lm", BackendKind::LmStudio, port)]);
        let err = registry.resolve("some-other-route").expect_err("unknown route");
        assert_eq!(err.kind, "unconfigured");
        assert!(err.message.contains("some-other-route"));
    }

    #[test]
    fn all_supported_backends_are_reachable_through_companion() {
        let mut configs = Vec::new();
        let mut servers = Vec::new();
        for kind in [BackendKind::Local, BackendKind::LmStudio, BackendKind::Ollama, BackendKind::OmLx] {
            let (port, server) = ok_backend(0);
            servers.push(server);
            configs.push(route(kind.id(), kind, port));
        }
        let registry = registry_with(configs);
        let report = health_registry(&registry);
        assert_eq!(report.len(), 4);
        for entry in &report {
            assert!(entry.ready, "{:?}", entry);
        }
        let mut labels: Vec<&str> = report.iter().map(|entry| entry.backend).collect();
        labels.sort_unstable();
        assert_eq!(labels, vec!["LM Studio", "Local runtime", "Ollama", "oMLX"]);
    }

    #[test]
    fn down_backend_reports_named_setup_error() {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).expect("bind");
        let dead_port = listener.local_addr().expect("addr").port();
        drop(listener);
        let registry = registry_with(vec![route("ollama-dead", BackendKind::Ollama, dead_port)]);
        let report = health_registry(&registry);
        assert_eq!(report.len(), 1);
        assert!(!report[0].ready);
        let detail = report[0].detail.clone().expect("detail");
        assert!(detail.contains("Ollama"), "identity preserved: {detail}");
    }

    #[test]
    fn stream_cancellation_is_clean_lifecycle() {
        let total = 4_000usize;
        let (port, server) = spawn_backend(
            move |stream| {
                drain_request(stream);
                let head = format!(
                    "HTTP/1.0 200 OK\r\nContent-Length: {total}\r\nConnection: close\r\n\r\n"
                );
                stream.write_all(head.as_bytes()).expect("head");
                let mut sent = 0usize;
                while sent < total {
                    let step = 100.min(total - sent);
                    stream.write_all(&vec![b'x'; step]).expect("chunk");
                    stream.flush().expect("flush");
                    sent += step;
                    thread::sleep(Duration::from_millis(10));
                }
            },
            1,
        );
        let _ = server;
        let registry = registry_with(vec![route("lm", BackendKind::LmStudio, port)]);
        let (token, handle) = cancel_pair();
        let mut sink = Vec::new();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(60));
            handle.cancel();
        });
        let started = Instant::now();
        let outcome = forward_chat_stream(&registry, "lm", b"{}", &token, &mut sink).expect("stream");
        assert!(outcome.cancelled);
        assert!(outcome.bytes_forwarded > 0);
        assert!(outcome.bytes_forwarded < total);
        assert!(started.elapsed() < READ_TIMEOUT, "cancel closed the socket promptly");
        assert_eq!(sink.len(), outcome.bytes_forwarded);
    }

    #[test]
    fn server_stop_preserves_backend_identity() {
        let (port, _server) = spawn_backend(
            |stream| {
                drain_request(stream);
                stream
                    .write_all(b"HTTP/1.0 200 OK\r\nContent-Length: 4000\r\nConnection: close\r\n\r\npartial")
                    .expect("partial");
                // drop without finishing: abrupt backend death
            },
            1,
        );
        let registry = registry_with(vec![route("lm", BackendKind::LmStudio, port)]);
        let (token, _handle) = cancel_pair();
        let mut sink = Vec::new();
        let err = forward_chat_stream(&registry, "lm", b"{}", &token, &mut sink).expect_err("death");
        assert_eq!(err.kind, "stopped");
        assert!(err.message.contains("LM Studio"), "identity preserved: {err}");
    }

    #[test]
    fn refused_backend_status_is_a_named_stop_error() {
        let (port, _server) = spawn_backend(
            |stream| {
                drain_request(stream);
                stream
                    .write_all(b"HTTP/1.0 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .expect("respond");
            },
            1,
        );
        let registry = registry_with(vec![route("omlx", BackendKind::OmLx, port)]);
        let (token, _handle) = cancel_pair();
        let mut sink = Vec::new();
        let err = forward_chat_stream(&registry, "omlx", b"{}", &token, &mut sink).expect_err("refused");
        assert_eq!(err.kind, "stopped");
        assert!(err.message.contains("oMLX"));
        assert!(err.message.contains("503"));
    }
}
