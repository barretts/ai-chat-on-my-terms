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

use serde_json::Value;

use crate::features::sync_setup::SyncSetupRegistry;
use crate::remote::crypto::{b64url_decode, seal_bytes, OpeningChannel};
use crate::remote::routes::{forward_chat_stream, CancelToken, RouteRegistry, StreamOutcome};
use crate::usb::frames::{frame_from_json, frame_to_json};
use crate::usb::guard::{DeviceMode, ModeGuard};

/// Wire protocol this companion speaks: major 1 (fixed; a major bump is
/// always a full re-pair) and the minor tracked here. A phone with a
/// NEWER minor is refused (RE-10) rather than guessing at its framing.
pub const COMPANION_PROTOCOL_MINOR: u32 = 1;

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

    /// Opens one sealed mobile→companion chat-request frame
    /// (contentTag "request"; body `{"type":"chat-request","routeId":…,"bodyBase64Url":…}`),
    /// forwards the decoded backend request bytes against the configured
    /// route, and seals the raw backend response back as ONE companion→
    /// mobile frame (contentTag "event") written as frame JSON to `sink`.
    /// `opener` carries the mobile→companion direction keys (its replay
    /// window); `direction_key`/`nonce_key` are the companion→mobile
    /// pair used for the response seal.
    pub fn serve_chat(
        &self,
        opener: &mut OpeningChannel,
        direction_key: &[u8; 32],
        nonce_key: &[u8; 32],
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
        let body: Value = serde_json::from_slice(&plaintext)
            .map_err(|err| CompositionError::malformed(format!("sealed chat-request body: {err}")))?;
        if body["type"].as_str() != Some("chat-request") {
            return Err(CompositionError::malformed("sealed body is not a chat-request"));
        }
        let backend_route = body["routeId"]
            .as_str()
            .ok_or_else(|| CompositionError::malformed("chat-request body is missing routeId"))?;
        let request_bytes = body["bodyBase64Url"]
            .as_str()
            .ok_or_else(|| CompositionError::malformed("chat-request body is missing bodyBase64Url"))
            .and_then(|encoded| {
                b64url_decode(encoded).map_err(|err| CompositionError::new(err.kind, err.message))
            })?;
        // The session frame and the configured backend route are the
        // same pairing id here; forward_chat_stream still re-resolves
        // it fail-closed against the allowlisted registry.
        if backend_route != frame.route_id {
            return Err(CompositionError::new(
                "unconfigured",
                format!(
                    "chat-request route {backend_route} does not match the session route {}",
                    frame.route_id
                ),
            ));
        }
        let mut backend_stream: Vec<u8> = Vec::new();
        let outcome = forward_chat_stream(&self.registry, backend_route, &request_bytes, cancel, &mut backend_stream)
            .map_err(|err| CompositionError::new(err.kind, err.message))?;
        // One response frame per serving: the raw backend response bytes
        // (SSE or final JSON) are sealed back in the opposite direction.
        let response = seal_bytes(
            direction_key,
            nonce_key,
            &backend_stream,
            &frame.route_id,
            &frame.request_id,
            frame.sequence,
            "event",
        )
        .map_err(|err| CompositionError::new(err.kind, err.message))?;
        sink.write_all(frame_to_json(&response).to_string().as_bytes())
            .map_err(|err| CompositionError::new("io", format!("sink write failed: {err}")))?;
        Ok(outcome)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::sync_setup::SyncChoice;
    use crate::remote::crypto::{b64url_encode, derive_nonce_key, derive_session_key, Role, SessionEntropy};
    use crate::remote::routes::{cancel_pair, BackendKind, RouteConfig};
    use serde_json::json;
    use std::io::Read;
    use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
    use std::thread;

    fn pairing_fixture() -> Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/remote/crypto/fixtures/pairing-vectors.json"
        );
        let text = std::fs::read_to_string(path).expect("pairing golden vectors must exist");
        serde_json::from_str(&text).expect("pairing golden vectors must be valid json")
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

    fn drain_request(stream: &mut TcpStream) {
        let mut buffer = Vec::new();
        let mut byte = [0u8; 1];
        while !buffer.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).unwrap_or(0) == 0 {
                return;
            }
            buffer.push(byte[0]);
        }
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

    fn sse_body() -> &'static [u8] {
        b"data: {\"text\":\"hi\"}\n\n"
    }

    fn ok_backend() -> (u16, thread::JoinHandle<()>) {
        let body = sse_body();
        spawn_backend(
            move |stream| {
                drain_request(stream);
                let head = format!(
                    "HTTP/1.0 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(head.as_bytes()).expect("respond");
                stream.write_all(body).expect("body");
            },
            1,
        )
    }

    #[test]
    fn sealed_chat_round_trip_through_pairing_derived_session() {
        let f = pairing_fixture();
        let route = f["routeId"].as_str().expect("routeId");
        let secret = b64url_decode(f["pairingSecretBase64Url"].as_str().expect("secret")).expect("secret b64url");
        let mobile_salt: [u8; 16] = b64url_decode(f["mobileSaltBase64Url"].as_str().expect("msalt"))
            .expect("msalt")
            .try_into()
            .expect("16-byte mobile salt");
        let companion_salt: [u8; 16] = b64url_decode(f["companionSaltBase64Url"].as_str().expect("csalt"))
            .expect("csalt")
            .try_into()
            .expect("16-byte companion salt");
        // R007: data keys mix both sides' handshake ephemerals (relay:
        // hello/ready sessionSalt; here the fixture's frozen ephemerals).
        let mobile_ephemeral: [u8; 16] = b64url_decode(f["mobileEphemeralBase64Url"].as_str().expect("meph"))
            .expect("meph")
            .try_into()
            .expect("16-byte mobile ephemeral");
        let companion_ephemeral: [u8; 16] = b64url_decode(f["companionEphemeralBase64Url"].as_str().expect("ceph"))
            .expect("ceph")
            .try_into()
            .expect("16-byte companion ephemeral");
        let entropy = SessionEntropy { mobile_ephemeral, companion_ephemeral };
        // mobile->companion direction on both sides of the opener/seal pair.
        let m2c = derive_session_key(&secret, &mobile_salt, &companion_salt, &entropy, route, Role::Mobile, Role::Companion).expect("m2c key");
        let m2c_nonce = derive_nonce_key(&secret, &mobile_salt, &companion_salt, &entropy, route, Role::Mobile, Role::Companion).expect("m2c nonce key");
        let c2m = derive_session_key(&secret, &mobile_salt, &companion_salt, &entropy, route, Role::Companion, Role::Mobile).expect("c2m key");
        let c2m_nonce = derive_nonce_key(&secret, &mobile_salt, &companion_salt, &entropy, route, Role::Companion, Role::Mobile).expect("c2m nonce key");

        let (port, _server) = ok_backend();
        let registry = RouteRegistry::configure(vec![RouteConfig {
            route_id: route.to_string(),
            kind: BackendKind::LmStudio,
            origin: format!("http://127.0.0.1:{port}"),
        }])
        .expect("configure loopback route");
        let composition = RemoteComposition::new(ModeGuard::new(), registry, SyncSetupRegistry::new());

        // The iPhone mobile-side view: seal a chat-request whose body
        // carries the backend POST bytes (the fake returns SSE).
        let backend_request = br#"{"messages":[{"role":"user","content":"hi"}]}"#;
        let sealed_body = json!({
            "type": "chat-request",
            "routeId": route,
            "bodyBase64Url": b64url_encode(backend_request),
        })
        .to_string();
        let request_frame = seal_bytes(&m2c, &m2c_nonce, sealed_body.as_bytes(), route, "chat-req-1", 0, "request").expect("seal request");
        let request_wire = frame_to_json(&request_frame).to_string();

        let (token, _handle) = cancel_pair();
        let mut companion_opener = OpeningChannel::new(&m2c, &m2c_nonce, route);
        let mut sink: Vec<u8> = Vec::new();
        let outcome = composition
            .serve_chat(&mut companion_opener, &c2m, &c2m_nonce, &request_wire, &token, &mut sink)
            .expect("serve chat");
        assert!(!outcome.cancelled);
        assert_eq!(outcome.bytes_forwarded, sse_body().len());

        // The iPhone opens the companion's response frame back.
        let response_value: Value = serde_json::from_slice(&sink).expect("response frame json");
        let response_frame = frame_from_json(&response_value).expect("response frame");
        assert_eq!(response_frame.content_tag, "event");
        assert_eq!(response_frame.route_id, route);
        assert_eq!(response_frame.request_id, "chat-req-1");
        let mut mobile_opener = OpeningChannel::new(&c2m, &c2m_nonce, route);
        let inner = mobile_opener.open(&response_frame).expect("mobile opens response");
        assert_eq!(inner, sse_body());
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
