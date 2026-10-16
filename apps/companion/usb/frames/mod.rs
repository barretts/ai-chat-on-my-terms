//! T101 (RE-11): length-prefixed framing for the iPhone↔Mac USB mux
//! channel. The verified multiplexing transport (usbmuxd-style stream to
//! the app's service port) is byte-transparent; this codec is the ONE
//! framing both sides speak, shared as golden vectors with the iOS
//! module (`modules/usb/ios/fixtures/usb-frame-vectors.json`) so the two
//! implementations are proven byte-compatible without a cable.
//!
//! Frame = `u32 BE payload length` + payload. The cap matches the
//! pairing crypto's MAX_FRAME_BYTES so sealed frames never straddle a
//! transport limit.

use crate::remote::crypto::{b64url_decode, Frame, MAX_FRAME_BYTES, FRAME_PROTOCOL_MAJOR, FRAME_PROTOCOL_MINOR};

pub const MAX_USB_PAYLOAD_BYTES: usize = MAX_FRAME_BYTES;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsbFrameError {
    pub kind: &'static str,
    pub message: String,
}

pub type Result<T, E = UsbFrameError> = core::result::Result<T, E>;

/// Encode one payload into a length-prefixed USB frame.
pub fn encode_frame(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 4);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Reassembles frames from arbitrarily chunked channel reads. A declared
/// length beyond the cap kills the channel (a hostile or broken peer
/// must not force unbounded buffering).
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>> {
        self.buffer.extend_from_slice(bytes);
        let mut frames: Vec<Vec<u8>> = Vec::new();
        loop {
            if self.buffer.len() < 4 {
                break;
            }
            let len = u32::from_be_bytes([self.buffer[0], self.buffer[1], self.buffer[2], self.buffer[3]]) as usize;
            if len > MAX_USB_PAYLOAD_BYTES {
                self.buffer.clear();
                return Err(UsbFrameError {
                    kind: "oversize",
                    message: format!("frame declares {len} bytes, over the {MAX_USB_PAYLOAD_BYTES} cap"),
                });
            }
            if self.buffer.len() < 4 + len {
                break;
            }
            frames.push(self.buffer.drain(4..4 + len).collect());
            self.buffer.drain(0..4);
        }
        Ok(frames)
    }

    pub fn buffered(&self) -> usize {
        self.buffer.len()
    }
}

/// Convert a sealed pairing-crypto frame to its transport JSON
/// (identical field names to the relay envelope golden vectors).
pub fn frame_to_json(frame: &Frame) -> serde_json::Value {
    serde_json::json!({
        // R028: sealed relay frames ride this codec and MUST satisfy the
        // TypeScript receiver's strict `EncryptedRelayFrameV1` schema, which
        // requires the protocol version pair; the golden vectors carry it too.
        "protocol": { "major": frame.protocol_major, "minor": frame.protocol_minor },
        "routeId": frame.route_id,
        "requestId": frame.request_id,
        "sequence": frame.sequence,
        "nonceBase64Url": frame.nonce_base64url,
        "contentTag": frame.content_tag,
        "declaredSize": frame.declared_size,
        "ciphertextBase64Url": frame.ciphertext_base64url,
    })
}

pub fn frame_from_json(value: &serde_json::Value) -> Result<Frame> {
    let string_field = |name: &'static str| -> Result<String> {
        let raw = value[name]
            .as_str()
            .ok_or_else(|| UsbFrameError { kind: "malformed", message: format!("frame {name} missing") })?
            .to_string();
        if name != "routeId" && name != "requestId" && name != "contentTag" {
            b64url_decode(&raw)
                .map_err(|_| UsbFrameError { kind: "malformed", message: format!("frame {name} not base64url") })?;
        }
        Ok(raw)
    };
    let sequence = value["sequence"]
        .as_u64()
        .ok_or_else(|| UsbFrameError { kind: "malformed", message: "frame sequence must be a number".into() })?;
    let declared = value["declaredSize"]
        .as_u64()
        .ok_or_else(|| UsbFrameError { kind: "malformed", message: "frame declaredSize must be a number".into() })?
        as usize;
    if declared > MAX_FRAME_BYTES {
        return Err(UsbFrameError { kind: "oversize", message: "frame size exceeds cap".into() });
    }
    let protocol = &value["protocol"];
    let (protocol_major, protocol_minor) = if protocol.is_null() {
        (FRAME_PROTOCOL_MAJOR, FRAME_PROTOCOL_MINOR)
    } else {
        (
            protocol["major"]
                .as_u64()
                .filter(|major| *major as u32 == FRAME_PROTOCOL_MAJOR)
                .ok_or_else(|| UsbFrameError { kind: "malformed", message: "frame protocol.major must be 1".into() })? as u32,
            protocol["minor"]
                .as_u64()
                .ok_or_else(|| UsbFrameError { kind: "malformed", message: "frame protocol.minor missing".into() })? as u32,
        )
    };
    Ok(Frame {
        protocol_major,
        protocol_minor,
        route_id: string_field("routeId")?,
        request_id: string_field("requestId")?,
        sequence,
        nonce_base64url: string_field("nonceBase64Url")?,
        content_tag: string_field("contentTag")?,
        declared_size: declared,
        ciphertext_base64url: string_field("ciphertextBase64Url")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::crypto::hex_decode;

    fn fixture() -> serde_json::Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../modules/usb/ios/fixtures/usb-frame-vectors.json"
        );
        let text = std::fs::read_to_string(path).expect("USB frame vectors must exist");
        serde_json::from_str(&text).expect("USB frame vectors must be valid json")
    }

    #[test]
    fn golden_frame_vectors_round_trip() {
        let f = fixture();
        assert_eq!(f["protocol"].as_str().expect("protocol"), "locallab-usb-v1");
        let frames = f["frames"].as_array().expect("frames array");
        assert!(!frames.is_empty());
        for vector in frames {
            let name = vector["name"].as_str().expect("name");
            let payload = b64url_decode(vector["payloadBase64Url"].as_str().expect("payload")).expect("payload b64url");
            let want = hex_decode(vector["frameHex"].as_str().expect("frameHex")).expect("frame hex");
            assert_eq!(encode_frame(&payload), want, "encode vector {name}");
            let mut decoder = FrameDecoder::new();
            let got = decoder.push(&want).expect("decode vector {name}");
            assert_eq!(got.len(), 1);
            assert_eq!(got[0], payload, "decode vector {name}");
            assert_eq!(decoder.buffered(), 0);
        }
    }

    #[test]
    fn fragmented_delivery_reassembles_in_order() {
        let a = encode_frame(b"one");
        let b = encode_frame(b"two!");
        let c = encode_frame(b"three");
        let stream: Vec<u8> = a.iter().chain(b.iter()).chain(c.iter()).copied().collect();
        let mut decoder = FrameDecoder::new();
        let mut all: Vec<Vec<u8>> = Vec::new();
        for chunk in stream.chunks(3) {
            all.extend(decoder.push(chunk).expect("push"));
        }
        assert_eq!(all, vec![b"one".to_vec(), b"two!".to_vec(), b"three".to_vec()]);
        assert_eq!(decoder.buffered(), 0);
    }

    #[test]
    fn oversize_declaration_kills_the_channel() {
        let mut decoder = FrameDecoder::new();
        let header = (MAX_USB_PAYLOAD_BYTES as u32 + 1).to_be_bytes();
        let error = decoder.push(&header).expect_err("oversize must fail");
        assert_eq!(error.kind, "oversize");
        // Channel is dead; further pushes must not resurrect partial state.
        assert_eq!(decoder.buffered(), 0);
    }

    #[test]
    fn empty_payload_frame_is_just_the_header() {
        assert_eq!(encode_frame(&[]), vec![0, 0, 0, 0]);
        let mut decoder = FrameDecoder::new();
        let frames = decoder.push(&[0, 0, 0, 0]).expect("empty frame");
        assert_eq!(frames, vec![Vec::<u8>::new()]);
    }
}
