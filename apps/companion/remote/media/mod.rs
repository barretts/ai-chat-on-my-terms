//! T097 (RE-04, IM-12) — companion-side encrypted binary forwarding engine.
//!
//! Transport-neutral chunking/reassembly for image, video and audio
//! payloads (ComfyUI images, Kokoro audio) that travel to the phone inside
//! encrypted relay frames (`binary-start` / `binary-chunk` / `binary-end`).
//! The JSON/relay wiring lands with the T102 companion service; this module
//! freezes the engine invariants the wire layer must preserve:
//!
//! - declared MIME and bounded declared length,
//! - lossless byte chunks (never re-encoded as lossy text),
//! - sha256 integrity with fail-closed assembly (gaps, overruns, tampering
//!   reject the whole transfer),
//! - duplicate chunk tolerance for slow relays and reconnects,
//! - credit-based flow control (`MediaWindow`), and
//! - clean cancellation (partial state discarded, restart allowed).

use core::fmt;

use sha2::{Digest, Sha256};

pub const MAX_MEDIA_CHUNK_BYTES: usize = 262_144;
pub const MAX_BINARY_TOTAL_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaTransferError {
    pub kind: &'static str,
    pub message: String,
}

impl MediaTransferError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
    fn oversize(message: impl Into<String>) -> Self {
        Self::new("oversize", message)
    }
    fn sequence(message: impl Into<String>) -> Self {
        Self::new("sequence", message)
    }
    fn checksum(message: impl Into<String>) -> Self {
        Self::new("checksum", message)
    }
    fn state(message: impl Into<String>) -> Self {
        Self::new("state", message)
    }
}

impl fmt::Display for MediaTransferError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for MediaTransferError {}

pub type Result<T, E = MediaTransferError> = core::result::Result<T, E>;

/// One transfer frame; mirrors the sealed relay payload at byte level.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaFrame {
    Start {
        transfer_id: String,
        mime_type: String,
        length: u64,
        sha256: String,
    },
    Chunk {
        transfer_id: String,
        index: u64,
        bytes: Vec<u8>,
    },
    End {
        transfer_id: String,
    },
    Cancel {
        reason: String,
    },
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Pull-style sender: the caller paces `next_frame()` through a `MediaWindow`
/// so no more than the credited number of chunks is ever in flight.
#[derive(Debug)]
pub struct MediaSender<'a> {
    transfer_id: String,
    mime_type: String,
    bytes: &'a [u8],
    digest: String,
    next_index: u64,
    phase: SenderPhase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SenderPhase {
    PendingStart,
    Streaming,
    Done,
}

impl<'a> MediaSender<'a> {
    pub fn new(
        transfer_id: impl Into<String>,
        mime_type: impl Into<String>,
        bytes: &'a [u8],
    ) -> Result<Self> {
        let mime_type = mime_type.into();
        if mime_type.is_empty() || mime_type.len() > 128 {
            return Err(MediaTransferError::state("mime type must be 1..128 bytes"));
        }
        if bytes.len() > MAX_BINARY_TOTAL_BYTES {
            return Err(MediaTransferError::oversize(format!(
                "transfer exceeds {} bytes",
                MAX_BINARY_TOTAL_BYTES
            )));
        }
        Ok(Self {
            transfer_id: transfer_id.into(),
            mime_type,
            bytes,
            digest: sha256_hex(bytes),
            next_index: 0,
            phase: SenderPhase::PendingStart,
        })
    }

    pub fn sha256(&self) -> &str {
        &self.digest
    }

    pub fn next_frame(&mut self) -> Option<MediaFrame> {
        match self.phase {
            SenderPhase::PendingStart => {
                self.phase = SenderPhase::Streaming;
                Some(MediaFrame::Start {
                    transfer_id: self.transfer_id.clone(),
                    mime_type: self.mime_type.clone(),
                    length: self.bytes.len() as u64,
                    sha256: self.digest.clone(),
                })
            }
            SenderPhase::Streaming => {
                let offset = self.next_index as usize * MAX_MEDIA_CHUNK_BYTES;
                if offset >= self.bytes.len() {
                    self.phase = SenderPhase::Done;
                    return Some(MediaFrame::End {
                        transfer_id: self.transfer_id.clone(),
                    });
                }
                let end = (offset + MAX_MEDIA_CHUNK_BYTES).min(self.bytes.len());
                let frame = MediaFrame::Chunk {
                    transfer_id: self.transfer_id.clone(),
                    index: self.next_index,
                    bytes: self.bytes[offset..end].to_vec(),
                };
                self.next_index += 1;
                Some(frame)
            }
            SenderPhase::Done => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceptOutcome {
    Accepted,
    Duplicate,
    Finished,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssemblerPhase {
    Idle,
    Receiving,
    Done,
}

/// Fail-closed receiver: duplicate chunks are idempotent, gaps/overruns and
/// checksum mismatch reject the transfer, cancel discards partial state.
pub struct TransferAssembler {
    phase: AssemblerPhase,
    transfer_id: String,
    mime_type: String,
    length: u64,
    declared_sha: String,
    total_bytes: u64,
    chunk_count: u64,
    received: std::collections::BTreeSet<u64>,
    chunks: std::collections::BTreeMap<u64, Vec<u8>>,
    assembled: Option<Vec<u8>>,
}

impl Default for TransferAssembler {
    fn default() -> Self {
        Self::new()
    }
}

impl TransferAssembler {
    pub fn new() -> Self {
        Self {
            phase: AssemblerPhase::Idle,
            transfer_id: String::new(),
            mime_type: String::new(),
            length: 0,
            declared_sha: String::new(),
            total_bytes: 0,
            chunk_count: 0,
            received: std::collections::BTreeSet::new(),
            chunks: std::collections::BTreeMap::new(),
            assembled: None,
        }
    }

    pub fn mime_type(&self) -> &str {
        &self.mime_type
    }

    pub fn accept(&mut self, frame: MediaFrame) -> Result<AcceptOutcome> {
        match frame {
            MediaFrame::Start {
                transfer_id,
                mime_type,
                length,
                sha256,
            } => {
                if self.phase != AssemblerPhase::Idle {
                    return Err(MediaTransferError::state("a transfer is already in progress"));
                }
                if length > MAX_BINARY_TOTAL_BYTES as u64 {
                    return Err(MediaTransferError::oversize("declared transfer exceeds the bound"));
                }
                self.phase = AssemblerPhase::Receiving;
                self.transfer_id = transfer_id;
                self.mime_type = mime_type;
                self.length = length;
                self.declared_sha = sha256.to_lowercase();
                self.total_bytes = 0;
                self.chunk_count = 0;
                self.received.clear();
                self.chunks.clear();
                self.assembled = None;
                Ok(AcceptOutcome::Accepted)
            }
            MediaFrame::Chunk {
                transfer_id,
                index,
                bytes,
            } => {
                if self.phase != AssemblerPhase::Receiving {
                    return Err(MediaTransferError::state("chunk before binary-start"));
                }
                if transfer_id != self.transfer_id {
                    return Err(MediaTransferError::state("chunk belongs to a different transfer"));
                }
                if bytes.len() > MAX_MEDIA_CHUNK_BYTES {
                    return Err(MediaTransferError::oversize("chunk exceeds the chunk bound"));
                }
                if self.received.contains(&index) {
                    return Ok(AcceptOutcome::Duplicate);
                }
                if self.total_bytes + bytes.len() as u64 > self.length {
                    return Err(MediaTransferError::oversize(
                        "chunk stream exceeds the declared length",
                    ));
                }
                self.received.insert(index);
                self.chunk_count += 1;
                self.total_bytes += bytes.len() as u64;
                self.chunks.insert(index, bytes);
                Ok(AcceptOutcome::Accepted)
            }
            MediaFrame::End { transfer_id } => {
                if self.phase != AssemblerPhase::Receiving {
                    return Err(MediaTransferError::state("end before binary-start"));
                }
                if transfer_id != self.transfer_id {
                    return Err(MediaTransferError::state("end belongs to a different transfer"));
                }
                if self.total_bytes != self.length {
                    return Err(MediaTransferError::sequence(format!(
                        "transfer ended after {} of {} bytes",
                        self.total_bytes, self.length
                    )));
                }
                // Contiguity: arriving indices must be exactly 0..n-1 where n
                // is the number of distinct chunks seen. The byte-total check
                // above plus this prefix check rules out gaps and index holes.
                let mut expected = 0u64;
                while expected < self.chunk_count {
                    if !self.received.contains(&expected) {
                        return Err(MediaTransferError::sequence("transfer is missing chunks"));
                    }
                    expected += 1;
                }
                let mut out = Vec::with_capacity(self.total_bytes as usize);
                for index in 0..self.chunk_count {
                    match self.chunks.get(&index) {
                        Some(chunk) => out.extend_from_slice(chunk),
                        None => return Err(MediaTransferError::sequence("missing chunk in gap")),
                    }
                }
                if sha256_hex(&out) != self.declared_sha {
                    return Err(MediaTransferError::checksum(
                        "assembled bytes do not match the declared sha256",
                    ));
                }
                self.assembled = Some(out);
                self.phase = AssemblerPhase::Done;
                Ok(AcceptOutcome::Finished)
            }
            MediaFrame::Cancel { .. } => {
                self.reset();
                Ok(AcceptOutcome::Accepted)
            }
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new();
    }

    pub fn take_bytes(&mut self) -> Result<Vec<u8>> {
        if self.phase != AssemblerPhase::Done {
            return Err(MediaTransferError::state("transfer has not completed"));
        }
        self.assembled
            .take()
            .ok_or_else(|| MediaTransferError::state("assembled bytes were already taken"))
    }
}

/// Credit accounting for forward pressure: at most `window_chunks` un-acked
/// chunks may be in flight; acks are monotonic (never rewind credit).
#[derive(Debug)]
pub struct MediaWindow {
    window_chunks: u64,
    sent: u64,
    acked_through: i64,
}

impl MediaWindow {
    pub fn new(window_chunks: u64) -> Result<Self> {
        if window_chunks < 1 {
            return Err(MediaTransferError::state("window must be >= 1 chunk"));
        }
        Ok(Self {
            window_chunks,
            sent: 0,
            acked_through: -1,
        })
    }

    pub fn can_send(&self) -> bool {
        self.sent.saturating_sub((self.acked_through + 1) as u64) < self.window_chunks
    }

    pub fn on_sent(&mut self) {
        self.sent += 1;
    }

    pub fn ack(&mut self, index: u64) {
        if index as i64 > self.acked_through {
            self.acked_through = index as i64;
        }
    }

    pub fn in_flight(&self) -> u64 {
        self.sent.saturating_sub((self.acked_through + 1) as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pseudo_random(seed: u32, length: usize) -> Vec<u8> {
        let mut state = seed;
        (0..length)
            .map(|i| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                if i % 97 == 0 {
                    0xff
                } else {
                    (state & 0xff) as u8
                }
            })
            .collect()
    }

    const TRANSFER: &str = "0198f2a3-0000-7000-8000-0000000000b1";

    fn drive(frames: impl IntoIterator<Item = MediaFrame>) -> Result<Vec<u8>> {
        let mut assembler = TransferAssembler::new();
        for frame in frames {
            let outcome = assembler.accept(frame)?;
            if outcome == AcceptOutcome::Finished {
                return assembler.take_bytes();
            }
        }
        Err(MediaTransferError::state("stream ended without completion"))
    }

    fn frames_of(bytes: &[u8], mime: &str) -> Vec<MediaFrame> {
        let mut sender = MediaSender::new(TRANSFER, mime, bytes).unwrap();
        let mut frames = Vec::new();
        while let Some(frame) = sender.next_frame() {
            frames.push(frame);
        }
        frames
    }

    #[test]
    fn round_trip_is_lossless_and_checksum_matches() {
        let bytes = pseudo_random(0xc0ffee, MAX_MEDIA_CHUNK_BYTES + 40_000);
        let mut sender = MediaSender::new(TRANSFER, "image/png", &bytes).unwrap();
        assert_eq!(sender.sha256(), sha256_hex(&bytes));
        let got = drive(std::iter::from_fn(|| sender.next_frame())).unwrap();
        assert_eq!(got, bytes);
    }

    #[test]
    fn known_sha256_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn duplicate_chunks_are_idempotent() {
        let bytes = pseudo_random(7, MAX_MEDIA_CHUNK_BYTES + 5);
        let mut sender = MediaSender::new(TRANSFER, "audio/wav", &bytes).unwrap();
        let mut assembler = TransferAssembler::new();
        while let Some(frame) = sender.next_frame() {
            match frame {
                MediaFrame::End { .. } => {
                    assembler.accept(frame).unwrap();
                    break;
                }
                MediaFrame::Chunk { index, .. } if index == 1 => {
                    assembler.accept(frame.clone()).unwrap();
                    assert_eq!(assembler.accept(frame.clone()).unwrap(), AcceptOutcome::Duplicate);
                    assert_eq!(assembler.accept(frame).unwrap(), AcceptOutcome::Duplicate);
                }
                other => {
                    assembler.accept(other).unwrap();
                }
            }
        }
        let got = assembler.take_bytes().unwrap();
        assert_eq!(sha256_hex(&got), sha256_hex(&bytes));
    }

    #[test]
    fn gaps_and_truncation_fail_closed() {
        let bytes = pseudo_random(11, MAX_MEDIA_CHUNK_BYTES * 2 + 10);
        let frames = frames_of(&bytes, "image/jpeg");

        let gapped: Vec<MediaFrame> = frames
            .iter()
            .filter(|f| !matches!(f, MediaFrame::Chunk { index: 1, .. }))
            .cloned()
            .collect();
        let error = drive(gapped).unwrap_err();
        assert_eq!(error.kind, "sequence");

        let truncated: Vec<MediaFrame> = frames
            .iter()
            .filter(|f| !matches!(f, MediaFrame::Chunk { index: 2, .. }))
            .cloned()
            .collect();
        let error = drive(truncated).unwrap_err();
        assert_eq!(error.kind, "sequence");
        assert!(error.message.contains("of"));
    }

    #[test]
    fn tampered_checksum_is_rejected() {
        let bytes = pseudo_random(5, 1234);
        let frames = frames_of(&bytes, "image/png");
        let tampered: Vec<MediaFrame> = frames
            .into_iter()
            .map(|frame| match frame {
                MediaFrame::Start {
                    transfer_id,
                    mime_type,
                    length,
                    ..
                } => MediaFrame::Start {
                    transfer_id,
                    mime_type,
                    length,
                    sha256: "00".repeat(32),
                },
                other => other,
            })
            .collect();
        let error = drive(tampered).unwrap_err();
        assert_eq!(error.kind, "checksum");
    }

    #[test]
    fn oversize_declared_and_chunk_are_rejected() {
        let mut assembler = TransferAssembler::new();
        let error = assembler
            .accept(MediaFrame::Start {
                transfer_id: TRANSFER.to_string(),
                mime_type: "image/png".to_string(),
                length: (MAX_BINARY_TOTAL_BYTES + 1) as u64,
                sha256: "ab".repeat(32),
            })
            .unwrap_err();
        assert_eq!(error.kind, "oversize");

        let mut assembler = TransferAssembler::new();
        assembler
            .accept(MediaFrame::Start {
                transfer_id: TRANSFER.to_string(),
                mime_type: "image/png".to_string(),
                length: (MAX_MEDIA_CHUNK_BYTES + 1) as u64,
                sha256: "ab".repeat(32),
            })
            .unwrap();
        let error = assembler
            .accept(MediaFrame::Chunk {
                transfer_id: TRANSFER.to_string(),
                index: 0,
                bytes: vec![0u8; MAX_MEDIA_CHUNK_BYTES + 1],
            })
            .unwrap_err();
        assert_eq!(error.kind, "oversize");

        let huge = vec![0u8; MAX_BINARY_TOTAL_BYTES + 64];
        let error = MediaSender::new(TRANSFER, "image/png", &huge).unwrap_err();
        assert_eq!(error.kind, "oversize");
    }

    #[test]
    fn cancel_discards_partial_state_and_restart_works() {
        let bytes = pseudo_random(3, MAX_MEDIA_CHUNK_BYTES + 9);
        let mut sender = MediaSender::new(TRANSFER, "audio/mp4", &bytes).unwrap();
        let mut assembler = TransferAssembler::new();
        assembler.accept(sender.next_frame().unwrap()).unwrap();
        assembler.accept(sender.next_frame().unwrap()).unwrap();
        assembler
            .accept(MediaFrame::Cancel {
                reason: "backend stopped".to_string(),
            })
            .unwrap();
        assert_eq!(assembler.take_bytes().unwrap_err().kind, "state");

        let mut restart =
            MediaSender::new("0198f2a3-0000-7000-8000-0000000000b2", "audio/mp4", &bytes).unwrap();
        let got = drive(std::iter::from_fn(|| restart.next_frame())).unwrap();
        assert_eq!(sha256_hex(&got), sha256_hex(&bytes));
    }

    #[test]
    fn flow_control_window_credits_chunks_monotonically() {
        let mut window = MediaWindow::new(2).unwrap();
        assert!(window.can_send());
        window.on_sent();
        window.on_sent();
        assert!(!window.can_send());
        window.ack(0);
        assert_eq!(window.in_flight(), 1);
        assert!(window.can_send());
        window.on_sent();
        window.ack(1);
        window.ack(0); // stale acks never rewind credit
        assert_eq!(window.in_flight(), 1);
        assert_eq!(MediaWindow::new(0).unwrap_err().kind, "state");
    }

    #[test]
    fn sender_emits_start_then_equal_chunks_then_end() {
        let bytes = pseudo_random(42, MAX_MEDIA_CHUNK_BYTES * 2 + 1);
        let mut sender = MediaSender::new(TRANSFER, "video/mp4", &bytes).unwrap();
        assert!(matches!(
            sender.next_frame(),
            Some(MediaFrame::Start { length, .. }) if length == bytes.len() as u64
        ));
        assert_eq!(sender.sha256().len(), 64);
        let mut chunk_count = 0;
        while let Some(frame) = sender.next_frame() {
            match frame {
                MediaFrame::Chunk { index, bytes: chunk, .. } => {
                    assert_eq!(index as usize, chunk_count);
                    assert!(chunk.len() <= MAX_MEDIA_CHUNK_BYTES);
                    chunk_count += 1;
                }
                MediaFrame::End { .. } => break,
                other => panic!("unexpected mid frame: {other:?}"),
            }
        }
        assert_eq!(chunk_count, 3);
        assert!(matches!(sender.next_frame(), None));
    }

    #[test]
    fn empty_transfer_completes_with_checksum_of_empty_input() {
        let bytes: Vec<u8> = Vec::new();
        let mut sender = MediaSender::new(TRANSFER, "application/octet-stream", &bytes).unwrap();
        let got = drive(std::iter::from_fn(|| sender.next_frame())).unwrap();
        assert!(got.is_empty());
        assert_eq!(
            sha256_hex(&got),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
