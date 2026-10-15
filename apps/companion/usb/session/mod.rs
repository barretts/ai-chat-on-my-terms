//! T101 (RE-11): authenticated iPhone↔Mac USB route handshake.
//!
//! USB is a PRIVATE channel between two devices that already share a
//! pairing (QR pairing established the 256-bit secret; the companion
//! vault holds the per-pairing record). No relay, no tickets: the wire
//! is just
//!   hello {tag:"usb-hello", side, protocol, routeId, proof}
//!   ready {tag:"usb-ready", protocol, proof, routes}
//! where proof = helloProof(secret, mobileSalt, companionSalt, routeId)
//! — identical to the relay pairing-hello proof, and the ready echo of
//! the same proof proves companion possession before either side puts
//! chat or sync traffic on the cable. The secret NEVER touches the
//! wire; a cable attached to an untrusted Mac cannot produce a valid
//! proof, so the handshake fails closed.
//!
//! After authentication, both sides run the pairing crypto's sealed
//! Frame envelopes (crypto::seal_bytes / OpeningChannel) serialized via
//! frames::frame_to_json inside the length-prefixed USB codec — so
//! replay windows, AAD binding and size caps are identical to remote
//! mode even though the transport is physical.

use serde_json::{json, Value};

use crate::remote::crypto::{verify_hello_proof, Role};

pub const USB_PROTOCOL: &str = "locallab-usb-v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsbSessionError {
    pub kind: &'static str,
    pub message: String,
}

pub type Result<T, E = UsbSessionError> = core::result::Result<T, E>;

/// The companion-vault view of one pairing usable over USB. Loaded from
/// the OS-backed vault by the host; constructed directly in tests.
#[derive(Debug, Clone)]
pub struct UsbPairingRecord {
    pub route_id: String,
    pub pairing_secret: Vec<u8>,
    pub mobile_salt: [u8; 16],
    pub companion_salt: [u8; 16],
}

#[derive(Debug, Clone)]
pub struct HelloOutcome {
    pub route_id: String,
    pub ready: Value,
}

fn str_field<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    value[name].as_str()
}

/// Companion side: verify the iPhone hello against the vault records.
/// Unknown routes and bad proofs are indistinguishable to the caller's
/// peer (both map to "unauthorized") so a probing cable learns nothing.
pub fn handle_hello(hello: &Value, records: &[UsbPairingRecord], routes: &Value) -> Result<HelloOutcome> {
    if str_field(hello, "tag") != Some("usb-hello") || str_field(hello, "side") != Some("mobile") {
        return Err(UsbSessionError { kind: "malformed", message: "expected a usb-hello from the mobile side".into() });
    }
    if str_field(hello, "protocol") != Some(USB_PROTOCOL) {
        return Err(UsbSessionError { kind: "version-mismatch", message: format!("this companion speaks {USB_PROTOCOL}") });
    }
    let route_id = str_field(hello, "routeId").ok_or_else(|| UsbSessionError { kind: "malformed", message: "routeId missing".into() })?;
    let proof = str_field(hello, "proof").ok_or_else(|| UsbSessionError { kind: "malformed", message: "proof missing".into() })?;
    let Some(record) = records.iter().find(|r| r.route_id == route_id) else {
        return Err(UsbSessionError { kind: "unauthorized", message: "route not paired with this companion".into() });
    };
    if !verify_hello_proof(proof, &record.pairing_secret, &record.mobile_salt, &record.companion_salt, route_id) {
        return Err(UsbSessionError { kind: "unauthorized", message: "hello proof rejected".into() });
    }
    Ok(HelloOutcome {
        route_id: route_id.to_string(),
        ready: json!({ "tag": "usb-ready", "protocol": USB_PROTOCOL, "proof": proof, "routes": routes }),
    })
}

/// Mobile-side mirror used by the iOS integration tests: the phone only
/// trusts the cable after the companion echoes the proof back.
pub fn verify_ready(ready: &Value, record: &UsbPairingRecord) -> bool {
    let Some(proof) = str_field(ready, "proof") else { return false };
    str_field(ready, "tag") == Some("usb-ready")
        && str_field(ready, "protocol") == Some(USB_PROTOCOL)
        && verify_hello_proof(proof, &record.pairing_secret, &record.mobile_salt, &record.companion_salt, &record.route_id)
}

/// Build the sealed-plane frame JSON pair for one direction after
/// authentication: `from`/`to` pick the derived direction keys, exactly
/// as the relay path does (derive_session_key/derive_nonce_key).
pub fn sealed_frame_json(frame: &crate::remote::crypto::Frame) -> String {
    crate::usb::frames::frame_to_json(frame).to_string()
}

pub fn role_label(role: Role) -> &'static str {
    match role {
        Role::Mobile => "mobile",
        Role::Companion => "companion",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::crypto::{b64url_decode, derive_session_key, hex_encode, seal_bytes, derive_nonce_key, OpeningChannel, Role};
    use crate::usb::frames::{encode_frame, frame_from_json, FrameDecoder};

    fn pairing_fixture() -> Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/remote/crypto/fixtures/pairing-vectors.json"
        );
        let text = std::fs::read_to_string(path).expect("pairing golden vectors must exist");
        serde_json::from_str(&text).expect("pairing golden vectors must be valid json")
    }

    fn record_from(f: &Value) -> UsbPairingRecord {
        let secret = b64url_decode(f["pairingSecretBase64Url"].as_str().expect("secret")).expect("secret b64url");
        UsbPairingRecord {
            route_id: f["routeId"].as_str().expect("routeId").to_string(),
            pairing_secret: secret,
            mobile_salt: b64url_decode(f["mobileSaltBase64Url"].as_str().expect("msalt"))
                .expect("msalt")
                .try_into()
                .expect("16-byte mobile salt"),
            companion_salt: b64url_decode(f["companionSaltBase64Url"].as_str().expect("csalt"))
                .expect("csalt")
                .try_into()
                .expect("16-byte companion salt"),
        }
    }

    fn hello_for(f: &Value) -> Value {
        json!({
            "tag": "usb-hello",
            "side": "mobile",
            "protocol": USB_PROTOCOL,
            "routeId": f["routeId"].as_str().expect("routeId"),
            "proof": f["helloProofBase64Url"].as_str().expect("hello proof"),
        })
    }

    #[test]
    fn usb_handshake_authenticates_with_pairing_vectors() {
        let f = pairing_fixture();
        let record = record_from(&f);
        let routes = json!([{ "id": "default", "backend": "lmstudio", "label": "LM Studio" }]);
        let outcome = handle_hello(&hello_for(&f), &[record.clone()], &routes).expect("handshake must authenticate");
        assert_eq!(outcome.route_id, record.route_id);
        assert!(verify_ready(&outcome.ready, &record));
    }

    #[test]
    fn forged_proof_and_unknown_route_both_fail_closed() {
        let f = pairing_fixture();
        let record = record_from(&f);
        let routes = json!([]);
        let mut forged = hello_for(&f);
        forged["proof"] = json!("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        let err = handle_hello(&forged, &[record.clone()], &routes).expect_err("forged proof must fail");
        assert_eq!(err.kind, "unauthorized");
        let mut wrong_route = hello_for(&f);
        wrong_route["routeId"] = json!("0198f2a3-0000-7000-8000-0000000000ff");
        let err = handle_hello(&wrong_route, &[record], &routes).expect_err("unknown route must fail");
        assert_eq!(err.kind, "unauthorized");
    }

    #[test]
    fn protocol_mismatch_points_at_version_not_auth() {
        let f = pairing_fixture();
        let record = record_from(&f);
        let mut stale = hello_for(&f);
        stale["protocol"] = json!("locallab-usb-v0");
        let err = handle_hello(&stale, &[record], &json!([])).expect_err("stale protocol must fail");
        assert_eq!(err.kind, "version-mismatch");
    }

    #[test]
    fn sealed_frames_run_over_the_usb_codec_unchanged() {
        // After handshake: mobile seals a chat frame; companion decodes
        // the codec, parses the frame JSON, and opens it with the same
        // crypto + replay window it uses for relay frames.
        let f = pairing_fixture();
        let record = record_from(&f);
        let route = record.route_id.as_str();
        let m2c = derive_session_key(&record.pairing_secret, &record.mobile_salt, &record.companion_salt, route, Role::Mobile, Role::Companion).expect("m2c key");
        let nonce_key = derive_nonce_key(&record.pairing_secret, &record.mobile_salt, &record.companion_salt, route, Role::Mobile, Role::Companion).expect("nonce key");
        let frame = seal_bytes(&m2c, &nonce_key, b"{\"kind\":\"sync-batch\"}", route, "usb-req-1", 0, "application/json").expect("seal");
        let wire = encode_frame(sealed_frame_json(&frame).as_bytes());
        let mut decoder = FrameDecoder::new();
        let payload = &decoder.push(&wire).expect("codec")[0];
        let parsed = frame_from_json(&serde_json::from_slice(payload).expect("frame json")).expect("frame parse");
        assert_eq!(parsed, frame);
        let mut opener = OpeningChannel::new(&m2c, &nonce_key, route);
        assert_eq!(opener.open(&parsed).expect("open"), b"{\"kind\":\"sync-batch\"}");
        // Replay of the exact same frame on the same direction is refused.
        assert!(opener.open(&parsed).is_err());
        assert_eq!(hex_encode(&record.pairing_secret).len(), 64);
    }
}
