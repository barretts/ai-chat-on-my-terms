//! T101 (RE-11): authenticated iPhone↔Mac USB route handshake.
//!
//! USB is a PRIVATE channel between two devices that already share a
//! pairing (QR pairing established the 256-bit secret; the companion
//! vault holds the per-pairing record). No relay, no tickets: the wire
//! is just
//!   hello {tag:"usb-hello", side, protocol, routeId, proof, sessionSalt}
//!   ready {tag:"usb-ready", protocol, proof, sessionSalt, routes}
//! where proof = helloProof(secret, mobileSalt, companionSalt, routeId)
//! — identical to the relay pairing-hello proof, and the ready echo of
//! the same proof proves companion possession before either side puts
//! chat or sync traffic on the cable. `sessionSalt` is each side's fresh
//! random 16-byte ephemeral (R007): the sealed data keys mix both
//! ephemerals, so two cable sessions over one saved pairing never reuse
//! a (key, nonce) pair. The secret NEVER touches the wire; a cable
//! attached to an untrusted Mac cannot produce a valid proof, so the
//! handshake fails closed.
//!
//! After authentication, both sides run the pairing crypto's sealed
//! Frame envelopes (crypto::seal_bytes / OpeningChannel) serialized via
//! frames::frame_to_json inside the length-prefixed USB codec — so
//! replay windows, AAD binding and size caps are identical to remote
//! mode even though the transport is physical.

use serde_json::{json, Value};

use crate::remote::crypto::{b64url_decode, b64url_encode, verify_hello_proof, Role};

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
    /// Mobile's fresh per-connection ephemeral (from the hello's
    /// sessionSalt). Mix it — with the companion ephemeral handed to
    /// handle_hello — into SessionEntropy for the data direction keys.
    pub mobile_ephemeral: [u8; 16],
}

fn str_field<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    value[name].as_str()
}

/// Companion side: verify the iPhone hello against the vault records.
/// Unknown routes and bad proofs are indistinguishable to the caller's
/// peer (both map to "unauthorized") so a probing cable learns nothing.
/// `companion_ephemeral` must be freshly random per cable session; it is
/// echoed in the ready (sessionSalt) and mixed into the data keys.
pub fn handle_hello(
    hello: &Value,
    records: &[UsbPairingRecord],
    routes: &Value,
    companion_ephemeral: &[u8; 16],
) -> Result<HelloOutcome> {
    if str_field(hello, "tag") != Some("usb-hello") || str_field(hello, "side") != Some("mobile") {
        return Err(UsbSessionError { kind: "malformed", message: "expected a usb-hello from the mobile side".into() });
    }
    if str_field(hello, "protocol") != Some(USB_PROTOCOL) {
        return Err(UsbSessionError { kind: "version-mismatch", message: format!("this companion speaks {USB_PROTOCOL}") });
    }
    let route_id = str_field(hello, "routeId").ok_or_else(|| UsbSessionError { kind: "malformed", message: "routeId missing".into() })?;
    let proof = str_field(hello, "proof").ok_or_else(|| UsbSessionError { kind: "malformed", message: "proof missing".into() })?;
    let ephemeral_b64 = str_field(hello, "sessionSalt").ok_or_else(|| UsbSessionError { kind: "malformed", message: "sessionSalt missing".into() })?;
    let mobile_ephemeral: [u8; 16] = b64url_decode(ephemeral_b64)
        .ok()
        .filter(|bytes| bytes.len() == 16)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| UsbSessionError { kind: "malformed", message: "sessionSalt must be 16 base64url bytes".into() })?;
    let Some(record) = records.iter().find(|r| r.route_id == route_id) else {
        return Err(UsbSessionError { kind: "unauthorized", message: "route not paired with this companion".into() });
    };
    if !verify_hello_proof(proof, &record.pairing_secret, &record.mobile_salt, &record.companion_salt, route_id) {
        return Err(UsbSessionError { kind: "unauthorized", message: "hello proof rejected".into() });
    }
    Ok(HelloOutcome {
        route_id: route_id.to_string(),
        ready: json!({
            "tag": "usb-ready",
            "protocol": USB_PROTOCOL,
            "proof": proof,
            "sessionSalt": b64url_encode(companion_ephemeral),
            "routes": routes,
        }),
        mobile_ephemeral,
    })
}

/// Mobile-side mirror used by the iOS integration tests: the phone only
/// trusts the cable after the companion echoes the proof back. On success
/// returns the companion's ephemeral (ready sessionSalt) to mix into the
/// data keys; None means do not trust this cable.
pub fn verify_ready(ready: &Value, record: &UsbPairingRecord) -> Option<[u8; 16]> {
    let proof = str_field(ready, "proof")?;
    if str_field(ready, "tag") != Some("usb-ready")
        || str_field(ready, "protocol") != Some(USB_PROTOCOL)
        || !verify_hello_proof(proof, &record.pairing_secret, &record.mobile_salt, &record.companion_salt, &record.route_id)
    {
        return None;
    }
    str_field(ready, "sessionSalt")
        .and_then(|value| b64url_decode(value).ok())
        .filter(|bytes| bytes.len() == 16)
        .and_then(|bytes| bytes.try_into().ok())
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
    use crate::remote::crypto::{
        b64url_decode, b64url_encode, derive_nonce_key, derive_session_key, hex_encode,
        seal_bytes, OpeningChannel, Role, SessionEntropy,
    };
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
            "sessionSalt": f["mobileEphemeralBase64Url"].as_str().expect("mobile ephemeral"),
        })
    }

    fn ephemeral_of(f: &Value) -> SessionEntropy {
        SessionEntropy {
            mobile_ephemeral: b64url_decode(f["mobileEphemeralBase64Url"].as_str().expect("meph"))
                .expect("meph b64url")
                .try_into()
                .expect("16-byte mobile ephemeral"),
            companion_ephemeral: b64url_decode(f["companionEphemeralBase64Url"].as_str().expect("ceph"))
                .expect("ceph b64url")
                .try_into()
                .expect("16-byte companion ephemeral"),
        }
    }

    fn companion_ephemeral_of(f: &Value) -> [u8; 16] {
        ephemeral_of(f).companion_ephemeral
    }

    #[test]
    fn usb_handshake_authenticates_with_pairing_vectors() {
        let f = pairing_fixture();
        let record = record_from(&f);
        let routes = json!([{ "id": "default", "backend": "lmstudio", "label": "LM Studio" }]);
        let outcome = handle_hello(
            &hello_for(&f),
            &[record.clone()],
            &routes,
            &companion_ephemeral_of(&f),
        )
        .expect("handshake must authenticate");
        assert_eq!(outcome.route_id, record.route_id);
        assert_eq!(outcome.mobile_ephemeral, ephemeral_of(&f).mobile_ephemeral);
        let ready_ephemeral = verify_ready(&outcome.ready, &record).expect("cable trusted");
        assert_eq!(ready_ephemeral, ephemeral_of(&f).companion_ephemeral);
    }

    #[test]
    fn hello_without_ephemeral_is_malformed() {
        // R007: a hello predating ephemeral negotiation must not silently
        // fall back to deterministic keys.
        let f = pairing_fixture();
        let record = record_from(&f);
        let mut stale = hello_for(&f);
        stale.as_object_mut().expect("object").remove("sessionSalt");
        let err = handle_hello(&stale, &[record], &json!([]), &[0x11; 16]).expect_err("missing sessionSalt must fail");
        assert_eq!(err.kind, "malformed");
    }

    #[test]
    fn reattach_gets_fresh_ephemerals_both_directions() {
        let f = pairing_fixture();
        let record = record_from(&f);
        let mut hello2 = hello_for(&f);
        hello2["sessionSalt"] = json!(b64url_encode(&[0x77; 16]));
        let first = handle_hello(&hello_for(&f), &[record.clone()], &json!([]), &[0x31; 16]).expect("first");
        let second = handle_hello(&hello2, &[record.clone()], &json!([]), &[0x32; 16]).expect("second");
        assert_ne!(first.mobile_ephemeral, second.mobile_ephemeral);
        assert_ne!(
            verify_ready(&first.ready, &record).expect("first trusted"),
            verify_ready(&second.ready, &record).expect("second trusted"),
        );
    }

    #[test]
    fn forged_proof_and_unknown_route_both_fail_closed() {
        let f = pairing_fixture();
        let record = record_from(&f);
        let routes = json!([]);
        let mut forged = hello_for(&f);
        forged["proof"] = json!("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        let err = handle_hello(&forged, &[record.clone()], &routes, &[0x22; 16]).expect_err("forged proof must fail");
        assert_eq!(err.kind, "unauthorized");
        let mut wrong_route = hello_for(&f);
        wrong_route["routeId"] = json!("0198f2a3-0000-7000-8000-0000000000ff");
        let err = handle_hello(&wrong_route, &[record], &routes, &[0x22; 16]).expect_err("unknown route must fail");
        assert_eq!(err.kind, "unauthorized");
    }

    #[test]
    fn protocol_mismatch_points_at_version_not_auth() {
        let f = pairing_fixture();
        let record = record_from(&f);
        let mut stale = hello_for(&f);
        stale["protocol"] = json!("locallab-usb-v0");
        let err = handle_hello(&stale, &[record], &json!([]), &[0x33; 16]).expect_err("stale protocol must fail");
        assert_eq!(err.kind, "version-mismatch");
    }

    #[test]
    fn sealed_frames_run_over_the_usb_codec_unchanged() {
        // After handshake: mobile seals a chat frame; companion decodes
        // the codec, parses the frame JSON, and opens it with the same
        // crypto + replay window it uses for relay frames. Data keys mix
        // both handshake ephemerals (R007).
        let f = pairing_fixture();
        let record = record_from(&f);
        let entropy = ephemeral_of(&f);
        let route = record.route_id.as_str();
        let m2c = derive_session_key(&record.pairing_secret, &record.mobile_salt, &record.companion_salt, &entropy, route, Role::Mobile, Role::Companion).expect("m2c key");
        let nonce_key = derive_nonce_key(&record.pairing_secret, &record.mobile_salt, &record.companion_salt, &entropy, route, Role::Mobile, Role::Companion).expect("nonce key");
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
