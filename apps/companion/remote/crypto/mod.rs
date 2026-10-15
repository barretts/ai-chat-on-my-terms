//! T093: project pairing QR v1 crypto (RE-01/RE-06) — Rust mirror of
//! `packages/remote/crypto/src/index.ts`. The cross-language contract is the
//! golden-vector fixture `packages/remote/crypto/fixtures/pairing-vectors.json`;
//! if this module and the fixture ever disagree, the fixture is the contract.
//!
//! Layout (ASCII info strings, salts concatenated mobile||companion):
//! - Session/nonce keys use salt = mobileSalt||companionSalt||mobileEphemeral
//!   ||companionEphemeral (R007): each side contributes a fresh random
//!   16-byte ephemeral in its handshake frame, so every connection derives
//!   fresh direction keys and replay windows — two sessions from one saved
//!   pairing can never reuse an AES-GCM (key, nonce) pair.
//! - HKDF-SHA256(ikm=32B pairing secret, salt as above,
//!   info="locallab-pairing-{hello|key|nonce|handshake|handshake-nonce}-v1|1.1|<routeId>[|<flow>]").
//!   The hello and handshake-* labels keep the deterministic
//!   mobileSalt||companionSalt salt: they seal only the hello/ready
//!   possession-proof frames, which a restarting peer must be able to open
//!   before any ephemeral is known. Data frames ride the ephemeral-mixed key.
//! - Hello proof = HMAC-SHA256(helloKey, "v1|<routeId>|<mobileSalt b64url>|<companionSalt b64url>").
//! - Frame nonce12 = HMAC-SHA256(nonceKey(flow), "c:" + u64be(sequence))[0..12];
//!   receivers reject frames whose advertised nonce is not deriveNonce(sequence).
//! - AAD = utf8("v1|<routeId>|<requestId>|<sequence>|<contentTag>|<declaredSize>|<nonce16>").
//! - ciphertext = AES-256-GCM(directionKey, iv=nonce12, aad, payloadJson utf8) || tag(16).

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

pub const REPLAY_WINDOW: u64 = 1_000;
pub const REPLAY_TRACK: u64 = 64;
pub const MAX_FRAME_BYTES: usize = 1_048_576;
const HELLO_LABEL: &str = "locallab-pairing-hello-v1|1.1";
const KEY_LABEL: &str = "locallab-pairing-key-v1|1.1";
const NONCE_LABEL: &str = "locallab-pairing-nonce-v1|1.1";
const HANDSHAKE_LABEL: &str = "locallab-pairing-handshake-v1|1.1";
const HANDSHAKE_NONCE_LABEL: &str = "locallab-pairing-handshake-nonce-v1|1.1";
const ROUTE_TICKET_KEY: &[u8] = b"locallab-pairing-route-ticket-v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingCryptoError {
    pub kind: &'static str,
    pub message: String,
}

impl PairingCryptoError {
    fn malformed(message: &str) -> Self {
        Self { kind: "malformed", message: message.to_string() }
    }
    fn unauthorized(message: &str) -> Self {
        Self { kind: "unauthorized", message: message.to_string() }
    }
}

pub type Result<T, E = PairingCryptoError> = core::result::Result<T, E>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Mobile,
    Companion,
}

fn flow_label(from: Role, to: Role) -> String {
    let label = |role: Role| match role {
        Role::Mobile => "mobile",
        Role::Companion => "companion",
    };
    format!("{}->{}", label(from), label(to))
}

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn b64url_encode(data: &[u8]) -> String {
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let bits = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_ALPHABET[((bits >> 18) & 63) as usize] as char);
        out.push(B64_ALPHABET[((bits >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(B64_ALPHABET[((bits >> 6) & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(B64_ALPHABET[(bits & 63) as usize] as char);
        }
    }
    out
}

pub fn b64url_decode(value: &str) -> Result<Vec<u8>> {
    let mut lookup = [0u8; 128];
    for (i, c) in B64_ALPHABET.iter().enumerate() {
        lookup[*c as usize] = i as u8;
    }
    let bytes = value.as_bytes();
    if bytes.len() % 4 == 1 || bytes.iter().any(|b| *b == b'=' || *b >= 128 || (lookup[*b as usize] == 0 && *b != b'A')) {
        return Err(PairingCryptoError::malformed("invalid base64url value"));
    }
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len() / 4 * 3 + 2);
    for chunk in bytes.chunks(4) {
        let mut acc = 0u32;
        for b in chunk {
            acc = (acc << 6) | lookup[*b as usize] as u32;
        }
        let bits = chunk.len() * 6;
        let emit = bits / 8;
        for i in 0..emit {
            out.push(((acc >> (bits - (i + 1) * 8)) & 0xff) as u8);
        }
    }
    if b64url_encode(&out) != value {
        return Err(PairingCryptoError::malformed("invalid base64url value"));
    }
    Ok(out)
}

pub fn hex_encode(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn hex_decode(value: &str) -> Result<Vec<u8>> {
    if value.len() % 2 != 0 {
        return Err(PairingCryptoError::malformed("invalid hex value"));
    }
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).map_err(|_| PairingCryptoError::malformed("invalid hex value")))
        .collect()
}

fn hkdf_expand(secret: &[u8], salt: &[u8], info: &str) -> Result<[u8; 32]> {
    let hk = hkdf::Hkdf::<Sha256>::new(Some(salt), secret);
    let mut okm = [0u8; 32];
    hk.expand(info.as_bytes(), &mut okm)
        .map_err(|_| PairingCryptoError::malformed("hkdf expand failed"))?;
    Ok(okm)
}

fn session_salt(mobile_salt: &[u8; 16], companion_salt: &[u8; 16]) -> [u8; 32] {
    let mut salt = [0u8; 32];
    salt[..16].copy_from_slice(mobile_salt);
    salt[16..].copy_from_slice(companion_salt);
    salt
}

pub fn derive_hello_key(secret: &[u8], mobile_salt: &[u8; 16], companion_salt: &[u8; 16], route_id: &str) -> Result<[u8; 32]> {
    if secret.len() != 32 {
        return Err(PairingCryptoError::malformed("pairingSecret must be exactly 32 bytes"));
    }
    hkdf_expand(secret, &session_salt(mobile_salt, companion_salt), &format!("{HELLO_LABEL}|{route_id}"))
}

/// R007: per-connection ephemerals mixed into the session key derivation.
/// Each side contributes a fresh random 16-byte value in its handshake frame
/// (hello carries mobile_ephemeral, ready carries companion_ephemeral), so
/// data keys and replay windows are fresh per connection while the pairing
/// secret and salts never travel on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionEntropy {
    pub mobile_ephemeral: [u8; 16],
    pub companion_ephemeral: [u8; 16],
}

fn entropy_bytes(mobile_salt: &[u8; 16], companion_salt: &[u8; 16], entropy: &SessionEntropy) -> Vec<u8> {
    let mut salt = Vec::with_capacity(64);
    salt.extend_from_slice(mobile_salt);
    salt.extend_from_slice(companion_salt);
    salt.extend_from_slice(&entropy.mobile_ephemeral);
    salt.extend_from_slice(&entropy.companion_ephemeral);
    salt
}

pub fn derive_handshake_key(secret: &[u8], mobile_salt: &[u8; 16], companion_salt: &[u8; 16], route_id: &str, from: Role, to: Role) -> Result<[u8; 32]> {
    if secret.len() != 32 {
        return Err(PairingCryptoError::malformed("pairingSecret must be exactly 32 bytes"));
    }
    let info = format!("{HANDSHAKE_LABEL}|{route_id}|{}", flow_label(from, to));
    hkdf_expand(secret, &session_salt(mobile_salt, companion_salt), &info)
}

pub fn derive_handshake_nonce_key(secret: &[u8], mobile_salt: &[u8; 16], companion_salt: &[u8; 16], route_id: &str, from: Role, to: Role) -> Result<[u8; 32]> {
    if secret.len() != 32 {
        return Err(PairingCryptoError::malformed("pairingSecret must be exactly 32 bytes"));
    }
    let info = format!("{HANDSHAKE_NONCE_LABEL}|{route_id}|{}", flow_label(from, to));
    hkdf_expand(secret, &session_salt(mobile_salt, companion_salt), &info)
}

pub fn derive_session_key(secret: &[u8], mobile_salt: &[u8; 16], companion_salt: &[u8; 16], entropy: &SessionEntropy, route_id: &str, from: Role, to: Role) -> Result<[u8; 32]> {
    if secret.len() != 32 {
        return Err(PairingCryptoError::malformed("pairingSecret must be exactly 32 bytes"));
    }
    let info = format!("{KEY_LABEL}|{route_id}|{}", flow_label(from, to));
    hkdf_expand(secret, &entropy_bytes(mobile_salt, companion_salt, entropy), &info)
}

pub fn derive_nonce_key(secret: &[u8], mobile_salt: &[u8; 16], companion_salt: &[u8; 16], entropy: &SessionEntropy, route_id: &str, from: Role, to: Role) -> Result<[u8; 32]> {
    if secret.len() != 32 {
        return Err(PairingCryptoError::malformed("pairingSecret must be exactly 32 bytes"));
    }
    let info = format!("{NONCE_LABEL}|{route_id}|{}", flow_label(from, to));
    hkdf_expand(secret, &entropy_bytes(mobile_salt, companion_salt, entropy), &info)
}

pub fn derive_nonce(nonce_key: &[u8; 32], sequence: u64) -> [u8; 12] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(nonce_key).expect("hmac accepts any key length");
    mac.update(b"c:");
    mac.update(&sequence.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(&digest[..12]);
    nonce
}

pub fn hello_proof(secret: &[u8], mobile_salt: &[u8; 16], companion_salt: &[u8; 16], route_id: &str) -> Result<String> {
    let key = derive_hello_key(secret, mobile_salt, companion_salt, route_id)?;
    let transcript = format!(
        "v1|{route_id}|{}|{}",
        b64url_encode(mobile_salt),
        b64url_encode(companion_salt)
    );
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&key).expect("hmac accepts any key length");
    mac.update(transcript.as_bytes());
    Ok(b64url_encode(&mac.finalize().into_bytes()))
}

pub fn verify_hello_proof(proof: &str, secret: &[u8], mobile_salt: &[u8; 16], companion_salt: &[u8; 16], route_id: &str) -> bool {
    let Ok(key) = derive_hello_key(secret, mobile_salt, companion_salt, route_id) else {
        return false;
    };
    let Ok(presented) = b64url_decode(proof) else {
        return false;
    };
    let transcript = format!(
        "v1|{route_id}|{}|{}",
        b64url_encode(mobile_salt),
        b64url_encode(companion_salt)
    );
    let Ok(mut mac) = <Hmac<Sha256> as Mac>::new_from_slice(&key) else {
        return false;
    };
    mac.update(transcript.as_bytes());
    mac.verify_slice(&presented).is_ok()
}

pub fn mobile_route_ticket_hash(mobile_route_ticket: &str) -> Result<String> {
    let bytes = b64url_decode(mobile_route_ticket)?;
    if bytes.len() != 32 {
        return Err(PairingCryptoError::malformed("mobileRouteTicket must be exactly 32 bytes"));
    }
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(ROUTE_TICKET_KEY).expect("static key");
    mac.update(&bytes);
    Ok(hex_encode(&mac.finalize().into_bytes()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub route_id: String,
    pub request_id: String,
    pub sequence: u64,
    pub nonce_base64url: String,
    pub content_tag: String,
    pub declared_size: usize,
    pub ciphertext_base64url: String,
}

fn frame_aad(frame: &Frame) -> Vec<u8> {
    format!(
        "v1|{}|{}|{}|{}|{}|{}",
        frame.route_id, frame.request_id, frame.sequence, frame.content_tag, frame.declared_size, frame.nonce_base64url
    )
    .into_bytes()
}

pub fn seal_bytes(
    direction_key: &[u8; 32],
    nonce_key: &[u8; 32],
    plaintext: &[u8],
    route_id: &str,
    request_id: &str,
    sequence: u64,
    content_tag: &str,
) -> Result<Frame> {
    let nonce = derive_nonce(nonce_key, sequence);
    let frame = Frame {
        route_id: route_id.to_string(),
        request_id: request_id.to_string(),
        sequence,
        nonce_base64url: b64url_encode(&nonce),
        content_tag: content_tag.to_string(),
        declared_size: plaintext.len() + 16,
        ciphertext_base64url: String::new(),
    };
    let aad = frame_aad(&frame);
    let cipher = Aes256Gcm::new_from_slice(direction_key).map_err(|_| PairingCryptoError::malformed("invalid direction key"))?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad: &aad })
        .map_err(|_| PairingCryptoError::unauthorized("encryption failed"))?;
    if ciphertext.len() > MAX_FRAME_BYTES {
        return Err(PairingCryptoError::malformed("frame exceeds maximum size"));
    }
    Ok(Frame { declared_size: ciphertext.len(), ciphertext_base64url: b64url_encode(&ciphertext), ..frame })
}

/// Receiver side: validates one direction, rejecting stale/duplicate/out-of-window sequences.
pub struct OpeningChannel {
    direction_key: [u8; 32],
    nonce_key: [u8; 32],
    route_id: String,
    high_sequence: i128,
    seen_mask: u128,
}

impl OpeningChannel {
    pub fn new(direction_key: &[u8; 32], nonce_key: &[u8; 32], route_id: &str) -> Self {
        Self {
            direction_key: *direction_key,
            nonce_key: *nonce_key,
            route_id: route_id.to_string(),
            high_sequence: -1,
            seen_mask: 0,
        }
    }

    fn accept_sequence(&mut self, sequence: u64) -> Result<()> {
        if (sequence as i128) > self.high_sequence + REPLAY_WINDOW as i128 {
            return Err(PairingCryptoError::unauthorized("frame sequence is beyond the replay window"));
        }
        if (sequence as i128) <= self.high_sequence {
            let back = (self.high_sequence - sequence as i128) as u64;
            if back >= REPLAY_TRACK {
                return Err(PairingCryptoError::unauthorized("frame sequence is below the replay window"));
            }
            if (self.seen_mask >> back) & 1 == 1 {
                return Err(PairingCryptoError::unauthorized("frame sequence was already used"));
            }
            return Ok(());
        }
        let forward = (sequence as i128 - self.high_sequence) as u64;
        self.seen_mask = if forward >= REPLAY_TRACK {
            1
        } else {
            ((self.seen_mask << forward) | 1) & ((1u128 << REPLAY_TRACK) - 1)
        };
        self.high_sequence = sequence as i128;
        Ok(())
    }

    pub fn open(&mut self, frame: &Frame) -> Result<Vec<u8>> {
        if frame.route_id != self.route_id {
            return Err(PairingCryptoError::unauthorized("frame route does not match this session"));
        }
        let advertised = b64url_decode(&frame.nonce_base64url)?;
        let expected = derive_nonce(&self.nonce_key, frame.sequence);
        if advertised.len() != 12 || advertised.ct_eq(&expected).unwrap_u8() != 1 {
            return Err(PairingCryptoError::unauthorized("frame nonce does not match its sequence"));
        }
        let mut ciphertext = b64url_decode(&frame.ciphertext_base64url)?;
        if ciphertext.len() < 16 {
            return Err(PairingCryptoError::unauthorized("frame ciphertext is too short"));
        }
        if ciphertext.len() > MAX_FRAME_BYTES || ciphertext.len() != frame.declared_size {
            return Err(PairingCryptoError::unauthorized("frame size does not match declaration"));
        }
        self.accept_sequence(frame.sequence)?;
        let aad = frame_aad(frame);
        let cipher = Aes256Gcm::new_from_slice(&self.direction_key).map_err(|_| PairingCryptoError::malformed("invalid direction key"))?;
        cipher
            .decrypt(Nonce::from_slice(&advertised), Payload { msg: &mut ciphertext, aad: &aad })
            .map_err(|_| PairingCryptoError::unauthorized("frame authentication failed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture() -> Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/remote/crypto/fixtures/pairing-vectors.json"
        );
        let text = std::fs::read_to_string(path).expect("golden vector fixture must exist");
        serde_json::from_str(&text).expect("fixture must be valid json")
    }

    fn decode(f: &Value, field: &str) -> Vec<u8> {
        b64url_decode(f[field].as_str().expect("string field")).expect("valid base64url")
    }

    fn salt_of(f: &Value, field: &str) -> [u8; 16] {
        decode(f, field).try_into().expect("16-byte salt")
    }

    fn entropy_of(f: &Value) -> SessionEntropy {
        SessionEntropy {
            mobile_ephemeral: salt_of(f, "mobileEphemeralBase64Url"),
            companion_ephemeral: salt_of(f, "companionEphemeralBase64Url"),
        }
    }

    fn frame_of(jf: &Value) -> Frame {
        Frame {
            route_id: jf["routeId"].as_str().expect("routeId").to_string(),
            request_id: jf["requestId"].as_str().expect("requestId").to_string(),
            sequence: jf["sequence"].as_u64().expect("sequence"),
            nonce_base64url: jf["nonceBase64Url"].as_str().expect("nonce").to_string(),
            content_tag: jf["contentTag"].as_str().expect("contentTag").to_string(),
            declared_size: jf["declaredSize"].as_u64().expect("declaredSize") as usize,
            ciphertext_base64url: jf["ciphertextBase64Url"].as_str().expect("ciphertext").to_string(),
        }
    }

    fn sealed<'a>(f: &'a Value) -> &'a [Value] {
        f["sealed"].as_array().expect("sealed array")
    }

    #[test]
    fn golden_vectors_reproduce_keys_proof_and_frames() {
        let f = fixture();
        let secret = decode(&f, "pairingSecretBase64Url");
        let mobile_salt = salt_of(&f, "mobileSaltBase64Url");
        let companion_salt = salt_of(&f, "companionSaltBase64Url");
        let entropy = entropy_of(&f);
        let route = f["routeId"].as_str().expect("routeId");
        assert_eq!(secret.len(), 32);
        let mobile_to_companion =
            derive_session_key(&secret, &mobile_salt, &companion_salt, &entropy, route, Role::Mobile, Role::Companion).expect("key");
        let companion_to_mobile =
            derive_session_key(&secret, &mobile_salt, &companion_salt, &entropy, route, Role::Companion, Role::Mobile).expect("key");
        assert_eq!(hex_encode(&mobile_to_companion), f["mobileToCompanionKeyHex"].as_str().expect("hex"));
        assert_eq!(hex_encode(&companion_to_mobile), f["companionToMobileKeyHex"].as_str().expect("hex"));
        assert_ne!(mobile_to_companion, companion_to_mobile);
        assert_eq!(
            hex_encode(&derive_handshake_key(&secret, &mobile_salt, &companion_salt, route, Role::Mobile, Role::Companion).expect("hs key")),
            f["mobileToCompanionHandshakeKeyHex"].as_str().expect("hs hex")
        );
        assert_eq!(
            hex_encode(&derive_handshake_key(&secret, &mobile_salt, &companion_salt, route, Role::Companion, Role::Mobile).expect("hs key")),
            f["companionToMobileHandshakeKeyHex"].as_str().expect("hs hex")
        );
        assert_eq!(hello_proof(&secret, &mobile_salt, &companion_salt, route).expect("proof"),
            f["helloProofBase64Url"].as_str().expect("proof"));
        assert_eq!(
            mobile_route_ticket_hash(f["mobileRouteTicketBase64Url"].as_str().expect("ticket")).expect("hash"),
            f["mobileRouteTicketHash"].as_str().expect("hash")
        );
        for entry in sealed(&f) {
            let (from, to) = if entry["direction"].as_str() == Some("mobile-to-companion") {
                (Role::Mobile, Role::Companion)
            } else {
                (Role::Companion, Role::Mobile)
            };
            let handshake = entry["channel"].as_str() == Some("handshake");
            let direction_key = if handshake {
                derive_handshake_key(&secret, &mobile_salt, &companion_salt, route, from, to).expect("key")
            } else {
                derive_session_key(&secret, &mobile_salt, &companion_salt, &entropy, route, from, to).expect("key")
            };
            let nonce_key = if handshake {
                derive_handshake_nonce_key(&secret, &mobile_salt, &companion_salt, route, from, to).expect("nonce key")
            } else {
                derive_nonce_key(&secret, &mobile_salt, &companion_salt, &entropy, route, from, to).expect("nonce key")
            };
            let frame = seal_bytes(
                &direction_key,
                &nonce_key,
                entry["payloadJson"].as_str().expect("payloadJson").as_bytes(),
                route,
                entry["requestId"].as_str().expect("requestId"),
                entry["sequence"].as_u64().expect("sequence"),
                entry["contentTag"].as_str().expect("contentTag"),
            )
            .expect("seal");
            let expected = frame_of(&entry["frame"]);
            assert_eq!(frame.nonce_base64url, expected.nonce_base64url, "{}", entry["name"].as_str().unwrap_or("?"));
            assert_eq!(frame.declared_size, expected.declared_size);
            assert_eq!(frame.ciphertext_base64url, expected.ciphertext_base64url);
        }
    }

    #[test]
    fn frames_round_trip_then_replay_stale_and_far_are_rejected() {
        let f = fixture();
        let secret = decode(&f, "pairingSecretBase64Url");
        let mobile_salt = salt_of(&f, "mobileSaltBase64Url");
        let companion_salt = salt_of(&f, "companionSaltBase64Url");
        let entropy = entropy_of(&f);
        let route = f["routeId"].as_str().expect("routeId").to_string();
        let direction_key = derive_session_key(&secret, &mobile_salt, &companion_salt, &entropy, &route, Role::Mobile, Role::Companion).expect("key");
        let nonce_key = derive_nonce_key(&secret, &mobile_salt, &companion_salt, &entropy, &route, Role::Mobile, Role::Companion).expect("nonce key");
        let entries: Vec<&Value> = sealed(&f)
            .iter()
            .filter(|entry| {
                entry["channel"].as_str() == Some("session")
                    && entry["direction"].as_str() == Some("mobile-to-companion")
            })
            .collect();
        assert_eq!(entries.len(), 3);
        let mut receiver = OpeningChannel::new(&direction_key, &nonce_key, &route);
        for entry in &entries {
            let plaintext = receiver.open(&frame_of(&entry["frame"])).expect("open");
            assert_eq!(plaintext, entry["payloadJson"].as_str().expect("payload").as_bytes());
        }
        let err = receiver.open(&frame_of(&entries[1]["frame"])).expect_err("replay must be rejected");
        assert_eq!(err.message, "frame sequence was already used");
        let jump = seal_bytes(&direction_key, &nonce_key, b"{\"tag\":\"health\",\"nonce\":\"jump-rust-0001\"}", &route, "0198f2a3-0000-7000-8000-0000000000f9", 100, "health").expect("seal jump");
        receiver.open(&jump).expect("jump accepted");
        let err = receiver.open(&frame_of(&entries[0]["frame"])).expect_err("stale must be rejected");
        assert_eq!(err.message, "frame sequence is below the replay window");
        let far = seal_bytes(&direction_key, &nonce_key, b"{\"tag\":\"health\",\"nonce\":\"far-rust-000001\"}", &route, "0198f2a3-0000-7000-8000-0000000000fa", 100 + REPLAY_WINDOW + 1, "health").expect("seal far");
        let err = receiver.open(&far).expect_err("far must be rejected");
        assert_eq!(err.message, "frame sequence is beyond the replay window");
    }

    #[test]
    fn tampered_foreign_mismatched_frames_fail_closed() {
        let f = fixture();
        let secret = decode(&f, "pairingSecretBase64Url");
        let mobile_salt = salt_of(&f, "mobileSaltBase64Url");
        let companion_salt = salt_of(&f, "companionSaltBase64Url");
        let entropy = entropy_of(&f);
        let route = f["routeId"].as_str().expect("routeId").to_string();
        let direction_key = derive_session_key(&secret, &mobile_salt, &companion_salt, &entropy, &route, Role::Mobile, Role::Companion).expect("key");
        let nonce_key = derive_nonce_key(&secret, &mobile_salt, &companion_salt, &entropy, &route, Role::Mobile, Role::Companion).expect("nonce key");
        let first = sealed(&f)
            .iter()
            .find(|entry| {
                entry["channel"].as_str() == Some("session")
                    && entry["direction"].as_str() == Some("mobile-to-companion")
                    && entry["sequence"].as_u64() == Some(0)
            })
            .expect("seq0");

        let mut frame = frame_of(&first["frame"]);
        let mut ct = b64url_decode(&frame.ciphertext_base64url).expect("ct");
        ct[0] ^= 0xff;
        frame.ciphertext_base64url = b64url_encode(&ct);
        let err = OpeningChannel::new(&direction_key, &nonce_key, &route).open(&frame).expect_err("tamper must fail");
        assert_eq!(err.message, "frame authentication failed");

        let later = sealed(&f).iter().find(|entry| entry["sequence"].as_u64() == Some(5)).expect("seq5");
        let mut swapped = frame_of(&later["frame"]);
        swapped.nonce_base64url = frame_of(&first["frame"]).nonce_base64url;
        let err = OpeningChannel::new(&direction_key, &nonce_key, &route).open(&swapped).expect_err("foreign nonce must fail");
        assert_eq!(err.message, "frame nonce does not match its sequence");

        let mut misdeclared = frame_of(&first["frame"]);
        misdeclared.declared_size += 1;
        assert!(OpeningChannel::new(&direction_key, &nonce_key, &route).open(&misdeclared).is_err());

        let mut foreign_route = frame_of(&first["frame"]);
        foreign_route.route_id = "0198f2a3-0000-7000-8000-000000000099".to_string();
        assert!(OpeningChannel::new(&direction_key, &nonce_key, &route).open(&foreign_route).is_err());
    }

    #[test]
    fn nonces_unique_per_sequence_and_scoped_per_session() {
        let f = fixture();
        let secret = decode(&f, "pairingSecretBase64Url");
        let mobile_salt = salt_of(&f, "mobileSaltBase64Url");
        let companion_salt = salt_of(&f, "companionSaltBase64Url");
        let entropy = entropy_of(&f);
        let route = f["routeId"].as_str().expect("routeId");
        let nonce_key = derive_nonce_key(&secret, &mobile_salt, &companion_salt, &entropy, route, Role::Mobile, Role::Companion).expect("nonce key");
        let nonces: std::collections::HashSet<[u8; 12]> =
            (0..200u64).map(|sequence| derive_nonce(&nonce_key, sequence)).collect();
        assert_eq!(nonces.len(), 200);
        let other = derive_nonce_key(&secret, b"rust-fresh-salt!", &companion_salt, &entropy, route, Role::Mobile, Role::Companion).expect("other nonce key");
        assert_ne!(derive_nonce(&other, 0), derive_nonce(&nonce_key, 0));
    }

    #[test]
    fn two_sessions_from_one_pairing_never_reuse_key_or_nonce() {
        // R007 regression: the QR-derived salts are deterministic, so a
        // recreated session must mix different ephemerals or it would reuse
        // the previous session's (key, nonce) pairs at sequence 0.
        let f = fixture();
        let secret = decode(&f, "pairingSecretBase64Url");
        let mobile_salt = salt_of(&f, "mobileSaltBase64Url");
        let companion_salt = salt_of(&f, "companionSaltBase64Url");
        let entropy = entropy_of(&f);
        let route = f["routeId"].as_str().expect("routeId");
        let restarted = SessionEntropy {
            mobile_ephemeral: [0x9a; 16],
            companion_ephemeral: [0x2b; 16],
        };
        let old_key = derive_session_key(&secret, &mobile_salt, &companion_salt, &entropy, route, Role::Mobile, Role::Companion).expect("key");
        let new_key = derive_session_key(&secret, &mobile_salt, &companion_salt, &restarted, route, Role::Mobile, Role::Companion).expect("key");
        assert_ne!(old_key, new_key);
        let old_nonce_key = derive_nonce_key(&secret, &mobile_salt, &companion_salt, &entropy, route, Role::Mobile, Role::Companion).expect("nonce key");
        let new_nonce_key = derive_nonce_key(&secret, &mobile_salt, &companion_salt, &restarted, route, Role::Mobile, Role::Companion).expect("nonce key");
        assert_ne!(old_nonce_key, new_nonce_key);
        // A zero counter restart under the restarted keys yields a nonce the
        // old session never used, and old-session frames fail authentication.
        let restarted_frame = seal_bytes(&new_key, &new_nonce_key, b"{\"tag\":\"health\",\"nonce\":\"restart-00000001\"}", route, "0198f2a3-0000-7000-8000-0000000000fb", 0, "health").expect("seal restart");
        let mut old_receiver = OpeningChannel::new(&old_key, &old_nonce_key, route);
        let err = old_receiver.open(&restarted_frame).expect_err("restarted frame must fail old receiver");
        assert!(err.kind == "unauthorized" || err.message.contains("nonce") || err.message.contains("authentication"));
        let first_frame = sealed(&f)
            .iter()
            .find(|entry| {
                entry["channel"].as_str() == Some("session")
                    && entry["direction"].as_str() == Some("mobile-to-companion")
                    && entry["sequence"].as_u64() == Some(0)
            })
            .expect("seq0");
        let mut new_receiver = OpeningChannel::new(&new_key, &new_nonce_key, route);
        let err = new_receiver.open(&frame_of(&first_frame["frame"])).expect_err("old-session frame must fail new receiver");
        assert!(err.kind == "unauthorized" || err.message.contains("nonce") || err.message.contains("authentication"));
    }

    #[test]
    fn hello_proof_verifies_posession_without_exposing_secret() {
        let f = fixture();
        let secret = decode(&f, "pairingSecretBase64Url");
        let mobile_salt = salt_of(&f, "mobileSaltBase64Url");
        let companion_salt = salt_of(&f, "companionSaltBase64Url");
        let route = f["routeId"].as_str().expect("routeId");
        let proof = f["helloProofBase64Url"].as_str().expect("proof");
        assert!(verify_hello_proof(proof, &secret, &mobile_salt, &companion_salt, route));
        assert!(!verify_hello_proof(proof, b"rust-other-secret-32-bytes-aa!", &mobile_salt, &companion_salt, route));
        assert!(!verify_hello_proof(proof, &secret, b"rust-fresh-salt!", &companion_salt, route));
        assert!(!verify_hello_proof(proof, &secret, &mobile_salt, &companion_salt, "0198f2a3-0000-7000-8000-000000000099"));
        assert!(!verify_hello_proof("not-base64url!!", &secret, &mobile_salt, &companion_salt, route));
        assert!(!verify_hello_proof(proof, b"short", &mobile_salt, &companion_salt, route));
    }
}
