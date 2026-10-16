//! T103 (ER-07): composition gate wiring the already-proven companion
//! modules into ONE host-side decision path for a paired iPhone.
//!
//! Nothing here re-implements crypto, routing or sync rules — it only
//! sequences them the way the live session must:
//!
//! - session admission runs the RE-10 version guard (T102) BEFORE the
//!   ModeGuard claim (T101), so a protocol-incompatible iPhone can never
//!   occupy the pairing's single live session slot,
//! - a sealed chat-request frame is opened with the relay crypto, then
//!   forwarded ONLY through the configured-route registry (T095) against
//!   loopback backends, and the raw backend response comes back sealed
//!   as one "event" frame in the companion→mobile direction,
//! - sync batches are accepted only when the pair has completed the
//!   SY-02/SY-03/SY-07 setup (enabled AND choice AND initial done) —
//!   stricter than the transport's two-condition gate, because a batch
//!   arriving over a live session is an actual data release.
//!
//! Errors from every module below map through unchanged (same `kind`
//! taxonomy) so callers keep naming the subsystem that refused.

use core::fmt;
use std::io::Write;

use serde_json::{json, Value};

use crate::features::sync_setup::SyncSetupRegistry;
use crate::remote::crypto::{seal_bytes, OpeningChannel, FRAME_PROTOCOL_MINOR};
use crate::remote::routes::{forward_chat_stream, CancelToken, RouteRegistry, StreamOutcome};
use crate::usb::frames::{frame_from_json, frame_to_json};
use crate::usb::guard::{DeviceMode, ModeGuard};

/// Wire protocol this companion speaks: major 1 (fixed; a major bump is
/// always a full re-pair) and the minor tracked here. A phone with a
/// NEWER minor is refused (RE-10) rather than guessing at its framing.
pub const COMPANION_PROTOCOL_MINOR: u32 = FRAME_PROTOCOL_MINOR;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompositionError {
    pub kind: &'static str,
    pub message: String,
}

impl CompositionError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
    fn malformed(message: impl Into<String>) -> Self {
        Self::new("malformed", message)
    }
}

impl fmt::Display for CompositionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CompositionError {}

pub type Result<T, E = CompositionError> = core::result::Result<T, E>;

/// Proof of an admitted session; the caller MUST present its mode and
/// route back on teardown so only the matching claim is released.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionTicket {
    pub mode: DeviceMode,
    pub route_id: String,
}

/// One sync-batch decision for a paired route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncGateOutcome {
    Accept { record_ids: Vec<String> },
    Refused { reason: &'static str },
}

/// The composition root for one paired route's live session surfaces.
pub struct RemoteComposition {
    guard: ModeGuard,
    registry: RouteRegistry,
    sync_setup: SyncSetupRegistry,
}

impl RemoteComposition {
    pub fn new(guard: ModeGuard, registry: RouteRegistry, sync_setup: SyncSetupRegistry) -> Self {
        Self { guard, registry, sync_setup }
    }

    /// Session admission: version guard first, then the single-path
    /// claim — a live USB session refuses a new Remote claim and vice
    /// versa ("excluded"), and a newer phone protocol never claims at
    /// all ("version-mismatch").
    pub fn session_opened(
        &mut self,
        mode: DeviceMode,
        route_id: &str,
        remote_version_minor: u32,
    ) -> Result<SessionTicket> {
        if remote_version_minor > COMPANION_PROTOCOL_MINOR {
            return Err(CompositionError::new(
                "version-mismatch",
                format!(
                    "iPhone protocol minor {remote_version_minor} is newer than this companion's minor {COMPANION_PROTOCOL_MINOR}; re-pair after updating the companion"
                ),
            ));
        }
        self.guard
            .claim(route_id, mode)
            .map_err(|err| CompositionError::new(err.kind, err.message))?;
        Ok(SessionTicket { mode, route_id: route_id.to_string() })
    }

    /// Teardown mirror of the ticket: releases ONLY the mode that still
    /// matches, exactly like ModeGuard::release. Returns whether a claim
    /// was actually released.
    pub fn session_closed(&mut self, mode: DeviceMode, route_id: &str) -> bool {
        self.guard.release(route_id, mode)
    }

    /// Serves one sealed mobile→companion chat-request frame and answers
    /// the phone with the R028 wire contract — the SAME contract the
    /// TypeScript mobile handle consumes:
    ///
    /// - the sealed plaintext is the `EncryptedPayload` envelope
    ///   `{tag:"request", body:{type:"chat-request", version:1, runId,
    ///   routeId, messages, tools}}` (a body that is not a v1 chat-request
    ///   settles the phone with a `chat-refused` body instead of hanging
    ///   its waiter forever);
    /// - the backend POST body (`{"messages":…,"stream":true,"tools":[…]}`)
    ///   is built HERE from the structured messages — the raw-backend-bytes
    ///   `bodyBase64Url` convention the old code spoke is retired;
    /// - the raw backend reply (OpenAI SSE chunks or a final chat JSON) is
    ///   translated into a `RunEvent` batch — RunStarted, TextDeltas, then
    ///   exactly one terminal (RunCompleted / RunCanceled / RunFailed) —
    ///   each sealed as its own `event` frame, followed by the
    ///   `chat-complete` request frame that resolves the phone's waiter.
    ///
    /// `opener` carries the mobile→companion direction keys (its replay
    /// window); `direction_key`/`nonce_key` are the companion→mobile pair
    /// used for the response seal, and `next_sequence` is the CALLER'S
    /// companion→mobile sender sequence (R021: sequences are per-session,
    /// monotonic, direction-owned — echoing the mobile's request sequence
    /// back is exactly the cross-direction reuse that replay window now
    /// refuses). Every frame the phone receives MUST pass its strict
    /// `EncryptedRelayFrameV1` schema — including the protocol version pair
    /// stamped by `seal_bytes` (the old frame JSON omitted it, so a real
    /// mobile handle failed every companion response closed).
    ///
    /// Backend death and cancellation settle the phone (terminal event +
    /// chat-complete) before the Err/Ok outcome is surfaced to the host.
    pub fn serve_chat(
        &self,
        opener: &mut OpeningChannel,
        direction_key: &[u8; 32],
        nonce_key: &[u8; 32],
        next_sequence: &mut u64,
        request_frame_json: &str,
        cancel: &CancelToken,
        sink: &mut impl Write,
    ) -> Result<StreamOutcome> {
        let wire: Value = serde_json::from_str(request_frame_json)
            .map_err(|err| CompositionError::malformed(format!("request frame json: {err}")))?;
        let frame = frame_from_json(&wire)
            .map_err(|err| CompositionError::new(err.kind, err.message))?;
        if frame.content_tag != "request" {
            return Err(CompositionError::malformed(format!(
                "chat serving expects a request frame, got contentTag {}",
                frame.content_tag
            )));
        }
        let plaintext = opener
            .open(&frame)
            .map_err(|err| CompositionError::new(err.kind, err.message))?;
        let envelope: Value = serde_json::from_slice(&plaintext)
            .map_err(|err| CompositionError::malformed(format!("sealed chat-request envelope: {err}")))?;
        if envelope["tag"].as_str() != Some("request") {
            return Err(CompositionError::malformed("sealed envelope is not a request payload"));
        }
        let body = &envelope["body"];
        if body["type"].as_str() != Some("chat-request") {
            return Err(CompositionError::malformed("sealed body is not a chat-request"));
        }
        let run_id = body["runId"].as_str();
        if body["version"].as_u64() != Some(CHAT_REQUEST_VERSION) {
            // Version guard: settle the phone's waiter with a refusal
            // instead of leaving it pending forever on a request this
            // companion will never answer.
            if let Some(run_id) = run_id {
                let reason = format!("unsupported chat-request version {:?}", body["version"]);
                self.emit_payload(
                    direction_key,
                    nonce_key,
                    next_sequence,
                    &frame.route_id,
                    &frame.request_id,
                    &json!({
                        "tag": "request",
                        "body": { "type": "chat-refused", "runId": run_id, "reason": reason },
                    }),
                    sink,
                )?;
            }
            return Err(CompositionError::malformed("chat-request body is not version 1"));
        }
        let run_id = run_id
            .ok_or_else(|| CompositionError::malformed("chat-request body is missing runId"))?
            .to_string();
        let backend_route = body["routeId"]
            .as_str()
            .ok_or_else(|| CompositionError::malformed("chat-request body is missing routeId"))?;
        if !body["messages"].is_array() {
            return Err(CompositionError::malformed("chat-request body is missing messages array"));
        }
        if backend_route != frame.route_id {
            return Err(CompositionError::new(
                "unconfigured",
                format!(
                    "chat-request route {backend_route} does not match the session route {}",
                    frame.route_id
                ),
            ));
        }
        // R028: the backend POST body is built from the structured request
        // (the mobile adapter never sees or sends backend wire bytes). An
        // empty tools array is omitted — LM Studio/Ollama reject unknown
        // empty tool lists differently across versions.
        let mut backend_request = serde_json::Map::new();
        backend_request.insert("messages".into(), body["messages"].clone());
        backend_request.insert("stream".into(), Value::Bool(true));
        if body["tools"].as_array().is_some_and(|tools| !tools.is_empty()) {
            backend_request.insert("tools".into(), body["tools"].clone());
        }
        let backend_request = Value::Object(backend_request).to_string().into_bytes();
        let mut backend_stream: Vec<u8> = Vec::new();
        let forward = forward_chat_stream(&self.registry, backend_route, &backend_request, cancel, &mut backend_stream);
        // Translate the raw backend reply into the RunEvent batch, then
        // settle the phone: events (tag "event") then chat-complete
        // (tag "request"). The host-visible outcome/error is returned
        // AFTER the phone has been settled — never leave it hanging.
        let timestamp = iso8601_now();
        let mut events: Vec<Value> = Vec::new();
        events.push(json!({
            "runId": run_id, "sequence": 0, "timestamp": timestamp, "type": "RunStarted",
        }));
        let sequence: u64 = 1;
        let outcome = match forward {
            Ok(outcome) => Ok(outcome),
            Err(err) => Err(CompositionError::new(err.kind, err.message)),
        };
        match &outcome {
            Ok(outcome) if outcome.cancelled => events.push(json!({
                "runId": run_id, "sequence": sequence, "timestamp": timestamp,
                "type": "RunCanceled", "reason": "cancelled",
            })),
            Err(err) => events.push(json!({
                "runId": run_id, "sequence": sequence, "timestamp": timestamp,
                "type": "RunFailed",
                "error": {
                    "code": err.kind,
                    "message": format!("{} backend request failed", err.kind),
                    "recoverable": err.kind != "unconfigured",
                },
            })),
            Ok(_) => {
                let (deltas, terminal) = translate_backend_reply(&backend_stream, &run_id, sequence, &timestamp);
                events.extend(deltas);
                events.push(terminal);
            }
        }
        for event in events.iter() {
            self.emit_payload(
                direction_key,
                nonce_key,
                next_sequence,
                &frame.route_id,
                &frame.request_id,
                &json!({ "tag": "event", "event": event }),
                sink,
            )?;
        }
        self.emit_payload(
            direction_key,
            nonce_key,
            next_sequence,
            &frame.route_id,
            &frame.request_id,
            &json!({ "tag": "request", "body": { "type": "chat-complete", "runId": run_id } }),
            sink,
        )?;
        sink.flush().map_err(|err| CompositionError::new("io", format!("sink flush failed: {err}")))?;
        outcome
    }

    /// Seals one response payload back to the phone on the caller's
    /// companion→mobile sender sequence (post-incremented) and writes one
    /// frame JSON per line to `sink` — every frame schema-valid for the
    /// strict TypeScript receiver (R028: protocol pair included).
    fn emit_payload(
        &self,
        direction_key: &[u8; 32],
        nonce_key: &[u8; 32],
        next_sequence: &mut u64,
        route_id: &str,
        request_id: &str,
        payload: &Value,
        sink: &mut impl Write,
    ) -> Result<()> {
        let frame = seal_bytes(
            direction_key,
            nonce_key,
            payload.to_string().as_bytes(),
            route_id,
            request_id,
            *next_sequence,
            payload["tag"].as_str().expect("payload tag"),
        )
        .map_err(|err| CompositionError::new(err.kind, err.message))?;
        *next_sequence += 1;
        let mut line = frame_to_json(&frame).to_string();
        line.push('\n');
        sink.write_all(line.as_bytes())
            .map_err(|err| CompositionError::new("io", format!("sink write failed: {err}")))?;
        Ok(())
    }

    /// SY gate for an incoming sync-batch frame: fail-closed unless the
    /// pair is opted in, has recorded its initial choice and has
    /// COMPLETED the initial sync — an arriving batch is a data release,
    /// so the choice step must already be behind it.
    pub fn sync_gate(&self, route_id: &str, batch_record_ids: &[String]) -> SyncGateOutcome {
        match self.sync_setup.find(route_id) {
            Some(setup) if setup.enabled && setup.choice.is_some() && setup.initial_sync_done => {
                SyncGateOutcome::Accept { record_ids: batch_record_ids.to_vec() }
            }
            _ => SyncGateOutcome::Refused { reason: "sync not opted in for this pair" },
        }
    }
}

/// R028: only chat-request payload version 1 is served; anything else
/// settles the phone with a chat-refused body (versioned payload contract
/// shared with the TypeScript mobile adapter, which stamps `version: 1`).
const CHAT_REQUEST_VERSION: u64 = 1;

/// Translate a raw backend chat reply — OpenAI-style SSE chunks or one
/// final chat-completion JSON — into `(text-delta events, terminal
/// event)`. The terminal is ALWAYS present: the phone's waiter must settle
/// with exactly one terminal RunEvent. Chunk/JSON shapes the backends
/// actually emit (LM Studio, Ollama's OpenAI endpoint) are what this
/// consumes; an unrecognisable payload is a RunFailed, never a hang.
fn translate_backend_reply(raw: &[u8], run_id: &str, first_sequence: u64, timestamp: &str) -> (Vec<Value>, Value) {
    let failed = |code: &'static str, message: String, recoverable: bool| {
        (
            Vec::new(),
            json!({
                "runId": run_id, "sequence": first_sequence, "timestamp": timestamp,
                "type": "RunFailed",
                "error": { "code": code, "message": message, "recoverable": recoverable },
            }),
        )
    };
    let text = String::from_utf8_lossy(raw);
    let mut deltas: Vec<String> = Vec::new();
    let mut finish: Option<String> = None;
    let mut saw_data_line = false;
    for line in text.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || !line.starts_with("data:") {
            continue;
        }
        let payload = line["data:".len()..].trim();
        if payload == "[DONE]" {
            continue;
        }
        saw_data_line = true;
        let Ok(chunk) = serde_json::from_str::<Value>(payload) else {
            return failed("backend-protocol", "backend SSE chunk is not valid json".into(), false);
        };
        let choice = &chunk["choices"][0];
        if let Some(delta) = choice["delta"]["content"].as_str() {
            if !delta.is_empty() {
                deltas.push(delta.to_string());
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            finish = Some(reason.to_string());
        }
    }
    if !saw_data_line {
        if raw.iter().all(|byte| byte.is_ascii_whitespace()) {
            return failed("backend-protocol", "backend returned an empty reply".into(), false);
        }
        match serde_json::from_str::<Value>(&text) {
            Ok(final_json) => {
                if let Some(delta) = final_json["choices"][0]["message"]["content"].as_str() {
                    if !delta.is_empty() {
                        deltas.push(delta.to_string());
                    }
                }
                finish = final_json["choices"][0]["finish_reason"].as_str().map(str::to_string).or(finish);
            }
            Err(_) => return failed("backend-protocol", "backend reply is neither SSE nor chat-completion json".into(), false),
        }
    }
    let mut events = Vec::with_capacity(deltas.len() + 1);
    let mut sequence = first_sequence;
    for delta in deltas {
        events.push(json!({
            "runId": run_id, "sequence": sequence, "timestamp": timestamp,
            "type": "TextDelta", "text": delta,
        }));
        sequence += 1;
    }
    let terminal = json!({
        "runId": run_id, "sequence": sequence, "timestamp": timestamp,
        "type": "RunCompleted", "finishReason": finish.unwrap_or_else(|| "stop".to_string()),
    });
    (events, terminal)
}

/// R028: RunEvent timestamps carry a real wall clock (the old chat path
/// emitted no timestamps at all); this crate deliberately avoids a
/// chrono/uuid dependency, so the UTC civil breakdown is computed inline
/// (Howard Hinnant's days-to-civil algorithm — valid for every timestamp
/// SystemTime can hand out since 1970).
fn iso8601_from_millis(millis: u64) -> String {
    let epoch_days = (millis / 86_400_000) as i64;
    let second_of_day = (millis % 86_400_000) / 1_000;
    let millisecond = millis % 1_000;
    let z = epoch_days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 };
    if month <= 2 {
        year += 1;
    }
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millisecond:03}Z",
        second_of_day / 3600,
        (second_of_day % 3600) / 60,
        second_of_day % 60,
    )
}

fn iso8601_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    iso8601_from_millis(now.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::sync_setup::SyncChoice;
    use crate::remote::crypto::{b64url_decode, derive_nonce_key, derive_session_key, Role, SessionEntropy};
    use crate::remote::routes::{cancel_pair, BackendKind, RouteConfig};
    use serde_json::json;
    use std::io::Read;
    use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::thread;

    /// Idents frozen into the R028 request-wire fixture — keep in lockstep
    /// with packages/remote/crypto/scripts/generate-r028-request-wire.mts.
    const CHAT_RUN_ID: &str = "0198f2a3-0000-7000-8000-0000000000c0";
    const CHAT_REQUEST_ID: &str = "0198f2a3-0000-7000-8000-0000000000d0";

    fn pairing_fixture() -> Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/remote/crypto/fixtures/pairing-vectors.json"
        );
        let text = std::fs::read_to_string(path).expect("pairing golden vectors must exist");
        serde_json::from_str(&text).expect("pairing golden vectors must be valid json")
    }

    struct SessionKeys {
        route: String,
        m2c: [u8; 32],
        m2c_nonce: [u8; 32],
        c2m: [u8; 32],
        c2m_nonce: [u8; 32],
    }

    /// R007 data keys from the frozen pairing vectors (mix both sides'
    /// handshake ephemerals).
    fn pairing_keys() -> SessionKeys {
        let f = pairing_fixture();
        let route = f["routeId"].as_str().expect("routeId").to_string();
        let secret = b64url_decode(f["pairingSecretBase64Url"].as_str().expect("secret")).expect("secret b64url");
        let mobile_salt: [u8; 16] = b64url_decode(f["mobileSaltBase64Url"].as_str().expect("msalt"))
            .expect("msalt")
            .try_into()
            .expect("16-byte mobile salt");
        let companion_salt: [u8; 16] = b64url_decode(f["companionSaltBase64Url"].as_str().expect("csalt"))
            .expect("csalt")
            .try_into()
            .expect("16-byte companion salt");
        let mobile_ephemeral: [u8; 16] = b64url_decode(f["mobileEphemeralBase64Url"].as_str().expect("meph"))
            .expect("meph")
            .try_into()
            .expect("16-byte mobile ephemeral");
        let companion_ephemeral: [u8; 16] = b64url_decode(f["companionEphemeralBase64Url"].as_str().expect("ceph"))
            .expect("ceph")
            .try_into()
            .expect("16-byte companion ephemeral");
        let entropy = SessionEntropy { mobile_ephemeral, companion_ephemeral };
        let derive = |session: bool, mobile_first: bool| -> [u8; 32] {
            let (from, to) = if mobile_first { (Role::Mobile, Role::Companion) } else { (Role::Companion, Role::Mobile) };
            if session {
                derive_session_key(&secret, &mobile_salt, &companion_salt, &entropy, &route, from, to).expect("session key")
            } else {
                derive_nonce_key(&secret, &mobile_salt, &companion_salt, &entropy, &route, from, to).expect("nonce key")
            }
        };
        SessionKeys {
            m2c: derive(true, true),
            m2c_nonce: derive(false, true),
            c2m: derive(true, false),
            c2m_nonce: derive(false, false),
            route,
        }
    }

    /// The TS-sealed chat-request frame: produced by the REAL TypeScript
    /// pairing stack from the real mobile adapter's payload shape
    /// (scripts/generate-r028-request-wire.mts) — the exact bytes a real
    /// iPhone puts on the wire.
    fn ts_request_wire(route: &str) -> String {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/composition/remote/fixtures/r028-request-wire.json");
        let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("r028 request wire fixture must exist"))
            .expect("r028 request wire must be valid json");
        assert_eq!(fixture["protocol"], json!("r028-request-wire-v1"));
        assert_eq!(fixture["routeId"].as_str().expect("fixture route"), route);
        assert_eq!(fixture["requestId"].as_str().expect("fixture requestId"), CHAT_REQUEST_ID);
        assert_eq!(fixture["runId"].as_str().expect("fixture runId"), CHAT_RUN_ID);
        fixture["frame"].to_string()
    }

    /// Minimal loopback fake backend (mirrors the remote/routes tests).
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

    /// Reads a POST request and RETURNS the body (the old drain_request
    /// discarded it — R028 asserts exactly what the companion sent the
    /// backend).
    fn read_request_body(stream: &mut TcpStream) -> Vec<u8> {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).unwrap_or(0) == 0 {
                return Vec::new();
            }
            head.push(byte[0]);
        }
        let declared = String::from_utf8_lossy(&head)
            .lines()
            .find(|line| line[..line.find(':').unwrap_or(0)].eq_ignore_ascii_case("content-length"))
            .and_then(|line| line.split_once(':'))
            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        let mut body = Vec::new();
        let mut chunk = [0u8; 256];
        while body.len() < declared {
            let read = stream.read(&mut chunk).unwrap_or(0);
            if read == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..read]);
        }
        body.truncate(declared);
        body
    }

    fn respond(stream: &mut TcpStream, status_line: &str, body: &[u8]) {
        let head = format!(
            "HTTP/1.0 {status_line}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).expect("respond head");
        stream.write_all(body).expect("respond body");
    }

    /// Fake backend recording every POST body it receives into `capture`.
    fn capture_backend(
        status_line: &'static str,
        body: &'static [u8],
        capture: Arc<Mutex<Vec<u8>>>,
        connections: usize,
    ) -> (u16, thread::JoinHandle<()>) {
        spawn_backend(
            move |stream| {
                let received = read_request_body(stream);
                capture.lock().expect("capture lock").extend_from_slice(&received);
                respond(stream, status_line, body);
            },
            connections,
        )
    }

    /// OpenAI-shaped SSE as real LM Studio / Ollama chat-completions
    /// endpoints emit it: delta chunks, a finish_reason, then [DONE].
    fn sse_body() -> &'static [u8] {
        b"data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n\
data: {\"choices\":[{\"delta\":{\"content\":\"lo \"}}]}\n\n\
data: {\"choices\":[{\"delta\":{\"content\":\"world\"},\"finish_reason\":null}]}\n\n\
data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
data: [DONE]\n\n"
    }

    fn registry_for(route: &str, port: u16) -> RouteRegistry {
        RouteRegistry::configure(vec![RouteConfig {
            route_id: route.to_string(),
            kind: BackendKind::LmStudio,
            origin: format!("http://127.0.0.1:{port}"),
        }])
        .expect("configure loopback route")
    }

    /// serve_chat sinks one frame JSON per line.
    fn response_frames(sink: &[u8]) -> Vec<Value> {
        sink.split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).expect("response frame json"))
            .collect()
    }

    fn open_plaintext(mobile: &mut OpeningChannel, frame: &Value) -> Value {
        let parsed = frame_from_json(frame).expect("response frame decodes");
        let plaintext = mobile.open(&parsed).expect("mobile opens companion frame");
        serde_json::from_slice(&plaintext).expect("response payload json")
    }

    #[test]
    fn sealed_chat_round_trip_serves_run_events_to_a_ts_sealed_request() {
        let keys = pairing_keys();
        let route = keys.route.as_str();
        let capture = Arc::new(Mutex::new(Vec::new()));
        let (port, _server) = capture_backend("200 OK", sse_body(), capture.clone(), 1);
        let composition = RemoteComposition::new(ModeGuard::new(), registry_for(route, port), SyncSetupRegistry::new());

        // R028 cross-language half 1: the request frame was sealed by the
        // real TS pairing stack; the companion must open it and BUILD the
        // backend POST body from the structured messages.
        let request_wire = ts_request_wire(route);
        let (token, _handle) = cancel_pair();
        let mut companion_opener = OpeningChannel::new(&keys.m2c, &keys.m2c_nonce, route);
        let mut next_sequence = 0u64;
        let mut sink: Vec<u8> = Vec::new();
        let outcome = composition
            .serve_chat(&mut companion_opener, &keys.c2m, &keys.c2m_nonce, &mut next_sequence, &request_wire, &token, &mut sink)
            .expect("serve chat");
        assert!(!outcome.cancelled);
        assert_eq!(outcome.bytes_forwarded, sse_body().len());
        let backend_body: Value =
            serde_json::from_slice(&capture.lock().expect("capture lock")).expect("backend body must be json");
        assert_eq!(
            backend_body,
            json!({ "messages": [{ "role": "user", "content": "hi" }], "stream": true }),
            "the companion builds the backend POST body from the structured request",
        );

        let frames = response_frames(&sink);
        assert_eq!(frames.len(), 6, "RunStarted + 3 TextDeltas + RunCompleted + chat-complete");
        assert_eq!(next_sequence, 6, "the caller's sender sequence advanced once per response frame");
        let mut texts = String::new();
        let mut mobile_opener = OpeningChannel::new(&keys.c2m, &keys.c2m_nonce, route);
        for (index, frame) in frames.iter().enumerate() {
            // Every frame must satisfy the strict TS receiver schema, which
            // demands the protocol version pair (R028: the old codec
            // emitted NONE — a real mobile handle rejected every reply).
            assert_eq!(frame["protocol"]["major"].as_u64(), Some(1), "frame {index} protocol major");
            assert_eq!(frame["protocol"]["minor"].as_u64(), Some(FRAME_PROTOCOL_MINOR as u64), "frame {index} protocol minor");
            assert_eq!(frame["routeId"].as_str(), Some(route), "frame {index} route");
            assert_eq!(frame["requestId"].as_str(), Some(CHAT_REQUEST_ID), "frame {index} answers the request id");
            assert_eq!(frame["sequence"].as_u64(), Some(index as u64), "frame {index} sequence on the caller's counter");
        }
        for (index, frame) in frames.iter().take(5).enumerate() {
            assert_eq!(frame["contentTag"].as_str(), Some("event"), "frame {index} is an event frame");
            let payload = open_plaintext(&mut mobile_opener, frame);
            assert_eq!(payload["tag"], json!("event"));
            let event = &payload["event"];
            assert_eq!(event["runId"].as_str(), Some(CHAT_RUN_ID), "event {index} runId");
            assert_eq!(event["sequence"].as_u64(), Some(index as u64), "event {index} sequence within the run");
            let timestamp = event["timestamp"].as_str().expect("event timestamp");
            assert_eq!(timestamp.len(), 24, "wall clock ISO8601 timestamp: {timestamp}");
            assert!(timestamp.ends_with('Z'));
            match index {
                0 => assert_eq!(event["type"], json!("RunStarted")),
                1..=3 => {
                    assert_eq!(event["type"], json!("TextDelta"));
                    texts.push_str(event["text"].as_str().expect("delta text"));
                }
                _ => {
                    assert_eq!(event["type"], json!("RunCompleted"));
                    assert_eq!(event["finishReason"], json!("stop"));
                }
            }
        }
        assert_eq!(texts, "Hello world", "the deltas reassemble the backend answer");
        assert_eq!(frames[5]["contentTag"].as_str(), Some("request"));
        let complete = open_plaintext(&mut mobile_opener, &frames[5]);
        assert_eq!(complete["tag"], json!("request"));
        assert_eq!(complete["body"]["type"], json!("chat-complete"));
        assert_eq!(complete["body"]["runId"].as_str(), Some(CHAT_RUN_ID));

        // R028 cross-language half 2: hand the EXACT response frames to the
        // TypeScript mobile pipeline (`packages/remote/integration/test/
        // r028-crosslang.test.mts` replays them through the real receiver:
        // strict schema parse, replay-window open, delta accumulation,
        // chat-complete latch). The test SKIPS with a loud note if the
        // companion has not run since — always run `cargo test` first.
        let marker = std::env::temp_dir().join("locallab-r028-crosslang.json");
        std::fs::write(
            &marker,
            json!({ "routeId": route, "runId": CHAT_RUN_ID, "frames": frames }).to_string(),
        )
        .expect("cross-language marker must be writable");
    }

    #[test]
    fn response_sequence_is_the_callers_monotonic_sender_counter_across_runs() {
        // R021/R028: companion→mobile sequences are direction-owned and
        // monotonic across the session. Echoing the mobile request sequence
        // (the old code) re-uses sender sequence across runs and a real
        // phone's replay window refuses it; here ONE caller counter feeds
        // both runs and ONE phone-side opener accepts everything.
        let keys = pairing_keys();
        let route = keys.route.as_str();
        let capture = Arc::new(Mutex::new(Vec::new()));
        let (port, _server) = capture_backend("200 OK", sse_body(), capture, 2);
        let composition = RemoteComposition::new(ModeGuard::new(), registry_for(route, port), SyncSetupRegistry::new());
        let (token, _handle) = cancel_pair();
        let mut opener = OpeningChannel::new(&keys.m2c, &keys.m2c_nonce, route);
        let mut next_sequence = 0u64;
        let mut all_frames: Vec<Value> = Vec::new();

        // Run 1: the frozen TS wire (mobile sequence 0).
        let mut sink: Vec<u8> = Vec::new();
        composition
            .serve_chat(&mut opener, &keys.c2m, &keys.c2m_nonce, &mut next_sequence, &ts_request_wire(route), &token, &mut sink)
            .expect("serve run one");
        all_frames.extend(response_frames(&sink));
        assert_eq!(next_sequence, 6);

        // Run 2: second mobile request (sequence 1 on ITS direction).
        let payload = json!({
            "tag": "request",
            "body": {
                "type": "chat-request", "version": 1,
                "runId": "0198f2a3-0000-7000-8000-0000000000c1",
                "routeId": route, "messages": [{ "role": "user", "content": "again" }], "tools": [],
            },
        })
        .to_string();
        let run_two = seal_bytes(
            &keys.m2c,
            &keys.m2c_nonce,
            payload.as_bytes(),
            route,
            "0198f2a3-0000-7000-8000-0000000000d1",
            1,
            "request",
        )
        .expect("seal run two");
        let mut sink: Vec<u8> = Vec::new();
        composition
            .serve_chat(
                &mut opener,
                &keys.c2m,
                &keys.c2m_nonce,
                &mut next_sequence,
                &frame_to_json(&run_two).to_string(),
                &token,
                &mut sink,
            )
                .expect("serve run two");
        all_frames.extend(response_frames(&sink));
        assert_eq!(next_sequence, 12);

        let mut mobile_opener = OpeningChannel::new(&keys.c2m, &keys.c2m_nonce, route);
        for (index, frame) in all_frames.iter().enumerate() {
            assert_eq!(frame["sequence"].as_u64(), Some(index as u64), "sender sequence {index}");
            open_plaintext(&mut mobile_opener, frame);
        }
    }

    #[test]
    fn refuses_non_v1_chat_request_and_settles_the_phone() {
        // Version guard: an unknown request version MUST NOT leave the
        // phone's waiter pending forever — settle it with chat-refused.
        let keys = pairing_keys();
        let route = keys.route.as_str();
        let composition = RemoteComposition::new(ModeGuard::new(), RouteRegistry::configure(vec![]).expect("registry"), SyncSetupRegistry::new());
        let payload = json!({
            "tag": "request",
            "body": {
                "type": "chat-request", "version": 2,
                "runId": CHAT_RUN_ID, "routeId": route, "messages": [], "tools": [],
            },
        })
        .to_string();
        let frame = seal_bytes(&keys.m2c, &keys.m2c_nonce, payload.as_bytes(), route, CHAT_REQUEST_ID, 0, "request").expect("seal v2");
        let (token, _handle) = cancel_pair();
        let mut opener = OpeningChannel::new(&keys.m2c, &keys.m2c_nonce, route);
        let mut next_sequence = 0u64;
        let mut sink: Vec<u8> = Vec::new();
        let err = composition
            .serve_chat(
                &mut opener,
                &keys.c2m,
                &keys.c2m_nonce,
                &mut next_sequence,
                &frame_to_json(&frame).to_string(),
                &token,
                &mut sink,
            )
                .expect_err("a non-v1 chat-request must be refused");
        assert_eq!(err.kind, "malformed");
        let frames = response_frames(&sink);
        assert_eq!(frames.len(), 1, "exactly the refusal frame");
        assert_eq!(frames[0]["contentTag"].as_str(), Some("request"));
        let mut mobile_opener = OpeningChannel::new(&keys.c2m, &keys.c2m_nonce, route);
        let refusal = open_plaintext(&mut mobile_opener, &frames[0]);
        assert_eq!(refusal["tag"], json!("request"));
        assert_eq!(refusal["body"]["type"], json!("chat-refused"));
        assert_eq!(refusal["body"]["runId"].as_str(), Some(CHAT_RUN_ID));
        assert!(
            refusal["body"]["reason"].as_str().expect("refusal reason").contains("version"),
            "the reason names the version guard",
        );
    }

    #[test]
    fn backend_death_settles_the_phone_with_a_failed_terminal() {
        // R028 acceptance: never leave the phone hanging — a backend
        // refusing the request is a RunFailed terminal event followed by
        // chat-complete, THEN the host-visible error.
        let keys = pairing_keys();
        let route = keys.route.as_str();
        let capture = Arc::new(Mutex::new(Vec::new()));
        let (port, _server) = capture_backend("500 Internal Server Error", b"", capture, 1);
        let composition = RemoteComposition::new(ModeGuard::new(), registry_for(route, port), SyncSetupRegistry::new());
        let (token, _handle) = cancel_pair();
        let mut opener = OpeningChannel::new(&keys.m2c, &keys.m2c_nonce, route);
        let mut next_sequence = 0u64;
        let mut sink: Vec<u8> = Vec::new();
        let err = composition
            .serve_chat(
                &mut opener,
                &keys.c2m,
                &keys.c2m_nonce,
                &mut next_sequence,
                &ts_request_wire(route),
                &token,
                &mut sink,
            )
                .expect_err("the host still sees the backend failure");
        assert_eq!(err.kind, "stopped");
        let frames = response_frames(&sink);
        assert_eq!(frames.len(), 3, "RunStarted + RunFailed + chat-complete");
        let mut mobile_opener = OpeningChannel::new(&keys.c2m, &keys.c2m_nonce, route);
        let start = open_plaintext(&mut mobile_opener, &frames[0]);
        assert_eq!(start["event"]["type"], json!("RunStarted"));
        let failed = open_plaintext(&mut mobile_opener, &frames[1]);
        assert_eq!(failed["event"]["type"], json!("RunFailed"));
        assert_eq!(failed["event"]["error"]["code"], json!("stopped"));
        assert_eq!(failed["event"]["error"]["recoverable"], json!(true));
        let complete = open_plaintext(&mut mobile_opener, &frames[2]);
        assert_eq!(complete["body"]["type"], json!("chat-complete"));
    }

    #[test]
    fn cancelled_run_settles_the_phone_with_a_canceled_terminal() {
        let keys = pairing_keys();
        let route = keys.route.as_str();
        let capture = Arc::new(Mutex::new(Vec::new()));
        let (port, _server) = capture_backend("200 OK", sse_body(), capture, 1);
        let composition = RemoteComposition::new(ModeGuard::new(), registry_for(route, port), SyncSetupRegistry::new());
        let (token, handle) = cancel_pair();
        handle.cancel(); // cancel BEFORE serving: forward must stop cooperatively
        let mut opener = OpeningChannel::new(&keys.m2c, &keys.m2c_nonce, route);
        let mut next_sequence = 0u64;
        let mut sink: Vec<u8> = Vec::new();
        let outcome = composition
            .serve_chat(
                &mut opener,
                &keys.c2m,
                &keys.c2m_nonce,
                &mut next_sequence,
                &ts_request_wire(route),
                &token,
                &mut sink,
            )
                .expect("a cancelled serve is a normal lifecycle outcome");
        assert!(outcome.cancelled);
        let frames = response_frames(&sink);
        assert_eq!(frames.len(), 3, "RunStarted + RunCanceled + chat-complete");
        let mut mobile_opener = OpeningChannel::new(&keys.c2m, &keys.c2m_nonce, route);
        open_plaintext(&mut mobile_opener, &frames[0]);
        let canceled = open_plaintext(&mut mobile_opener, &frames[1]);
        assert_eq!(canceled["event"]["type"], json!("RunCanceled"));
        assert_eq!(canceled["event"]["reason"], json!("cancelled"));
        let complete = open_plaintext(&mut mobile_opener, &frames[2]);
        assert_eq!(complete["body"]["type"], json!("chat-complete"));
    }

    #[test]
    fn translate_backend_reply_handles_plain_final_json() {
        // Non-streaming backends answer with one chat-completion JSON;
        // the translation must still produce deltas + ONE terminal.
        let raw = br#"{"choices":[{"message":{"role":"assistant","content":"Plain answer"},"finish_reason":"stop"}]}"#;
        let (deltas, terminal) = translate_backend_reply(raw, CHAT_RUN_ID, 1, "2026-10-15T00:00:00.000Z");
        assert_eq!(deltas.len(), 1);
        assert_eq!(deltas[0]["text"], json!("Plain answer"));
        assert_eq!(terminal["type"], json!("RunCompleted"));
        assert_eq!(terminal["finishReason"], json!("stop"));
    }

    #[test]
    fn translate_backend_reply_fails_closed_on_unrecognisable_payloads() {
        let (deltas, terminal) = translate_backend_reply(b"", CHAT_RUN_ID, 1, "t");
        assert!(deltas.is_empty());
        assert_eq!(terminal["type"], json!("RunFailed"));
        assert_eq!(terminal["error"]["code"], json!("backend-protocol"));
        assert_eq!(terminal["error"]["recoverable"], json!(false));
        let (_, terminal) = translate_backend_reply(b"gateway exploded", CHAT_RUN_ID, 1, "t");
        assert_eq!(terminal["type"], json!("RunFailed"));
        let (_, terminal) = translate_backend_reply(b"data: not-json\n\n", CHAT_RUN_ID, 1, "t");
        assert_eq!(terminal["type"], json!("RunFailed"));
    }

    #[test]
    fn iso8601_from_millis_matches_known_epoch_values() {
        assert_eq!(iso8601_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601_from_millis(1_760_000_000_123), "2025-10-09T08:53:20.123Z");
        assert_eq!(iso8601_from_millis(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso8601_from_millis(1_753_996_799_000), "2025-07-31T21:19:59.000Z");
    }

    #[test]
    fn iso8601_now_tracks_the_wall_clock() {
        let before = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_millis() as u64;
        let stamp = iso8601_now();
        assert_eq!(stamp.len(), 24, "ISO8601 wall clock: {stamp}");
        assert!(stamp.ends_with('Z'));
        assert!(stamp[..4].parse::<u64>().expect("year") >= 2025, "real clock year: {stamp}");
        let after = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_millis() as u64;
        assert!(before <= after + 1_000);
    }

    #[test]
    fn advertised_protocol_minor_is_the_frame_seal_minor() {
        // R028 cross-module invariant: the version the phone negotiates at
        // session level and the version stamped into every response frame
        // are ONE constant — drift re-pairs or fails closed, never splits.
        assert_eq!(COMPANION_PROTOCOL_MINOR, FRAME_PROTOCOL_MINOR);
    }

    #[test]
    fn usb_session_blocks_a_new_remote_claim_until_closed() {
        let mut composition = RemoteComposition::new(ModeGuard::new(), RouteRegistry::configure(vec![]).expect("empty registry"), SyncSetupRegistry::new());
        let usb_ticket = composition.session_opened(DeviceMode::Usb, "pair-1", 0).expect("usb claim");
        let err = composition
            .session_opened(DeviceMode::Remote, "pair-1", 0)
            .expect_err("remote must be refused while usb is live");
        assert_eq!(err.kind, "excluded");
        assert!(composition.session_closed(usb_ticket.mode, &usb_ticket.route_id));
        let remote_ticket = composition.session_opened(DeviceMode::Remote, "pair-1", 0).expect("remote claim after release");
        assert_eq!(remote_ticket.mode, DeviceMode::Remote);
    }

    #[test]
    fn sync_gate_refuses_until_setup_is_complete() {
        let ids = || vec!["rec-a".to_string(), "rec-b".to_string()];
        let empty = RemoteComposition::new(ModeGuard::new(), RouteRegistry::configure(vec![]).expect("registry"), SyncSetupRegistry::new());
        assert_eq!(
            empty.sync_gate("pair-1", &ids()),
            SyncGateOutcome::Refused { reason: "sync not opted in for this pair" }
        );

        let mut opted_in = SyncSetupRegistry::new();
        opted_in.opt_in("pair-1");
        let opted = RemoteComposition::new(ModeGuard::new(), RouteRegistry::configure(vec![]).expect("registry"), opted_in);
        assert_eq!(
            opted.sync_gate("pair-1", &ids()),
            SyncGateOutcome::Refused { reason: "sync not opted in for this pair" }
        );

        let mut complete = SyncSetupRegistry::new();
        complete.opt_in("pair-1");
        complete.set_choice("pair-1", SyncChoice::Merge).expect("choice");
        complete.complete_initial("pair-1").expect("initial done");
        let ready = RemoteComposition::new(ModeGuard::new(), RouteRegistry::configure(vec![]).expect("registry"), complete);
        assert_eq!(ready.sync_gate("pair-1", &ids()), SyncGateOutcome::Accept { record_ids: ids() });
    }

    #[test]
    fn newer_phone_protocol_is_refused_before_any_claim() {
        let mut composition = RemoteComposition::new(ModeGuard::new(), RouteRegistry::configure(vec![]).expect("registry"), SyncSetupRegistry::new());
        let err = composition
            .session_opened(DeviceMode::Remote, "pair-1", COMPANION_PROTOCOL_MINOR + 7)
            .expect_err("newer phone must be refused");
        assert_eq!(err.kind, "version-mismatch");
        assert_eq!(composition.session_closed(DeviceMode::Remote, "pair-1"), false);
        assert!(composition.session_opened(DeviceMode::Remote, "pair-1", 0).is_ok());
    }
}
