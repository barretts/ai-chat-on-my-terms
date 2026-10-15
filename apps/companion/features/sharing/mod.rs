//! T102 (RE-07, UI-15): the menu-bar sharing service surface.
//!
//! Pure behavior layer behind the native tray menu: which commands are
//! available in which state, the pairing QR payload the tray re-displays
//! ("Show QR again" — identical to the QR first presented at pairing),
//! connection-health lines, and the keys/routes/voice-pack control
//! entry points. The QR payload contract is the PairingQrV1 object in
//! `packages/service-contracts/src/pairing.ts` — same strict fields, and
//! parse/encode here fail closed exactly like the TS side, so a corrupt
//! or foreign payload can never be re-broadcast to a scanning iPhone.
//! Quit semantics live in `lifecycle` (window close ≠ Quit); this module
//! only owns the command surface.

use core::fmt;

use serde_json::{Map, Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharingError {
    pub kind: &'static str,
    pub message: String,
}

impl SharingError {
    fn malformed(message: impl Into<String>) -> Self {
        Self { kind: "malformed", message: message.into() }
    }
    fn state(message: impl Into<String>) -> Self {
        Self { kind: "state", message: message.into() }
    }
}

impl fmt::Display for SharingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SharingError {}

pub type Result<T, E = SharingError> = core::result::Result<T, E>;

/// Companion-side builder for PairingQrV1 payloads. Raw material (the
/// 32-byte pairing secret, the mobile route ticket, the v7 route id)
/// comes from the OS-backed host — this layer validates and encodes
/// canonically, and can be exercised without a camera or a Mac keychain.
pub struct PairingQrInput<'a> {
    pub relay_url: &'a str,
    pub server_identity_fingerprint: &'a str,
    pub companion_route_id: &'a str,
    pub pairing_secret_b64url: &'a str,
    pub mobile_route_ticket_b64url: &'a str,
    pub protocol_minor: u32,
}

fn is_b64url_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

/// Exactly 43 base64url chars (= 32 bytes, unpadded).
fn valid_b64url32(value: &str) -> bool {
    value.len() == 43 && value.chars().all(is_b64url_char)
}

fn valid_fingerprint(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit())
}

fn valid_relay_url(value: &str) -> bool {
    (value.starts_with("wss://") || value.starts_with("ws://")) && value.len() > "wss://".len()
}

fn valid_route_id(value: &str) -> bool {
    (value.len() == 36 || value.len() == 32)
        && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Canonical payload JSON (stable field order — the QR is often
/// re-encoded by hand and users re-scan old screenshots).
pub fn create_pairing_qr_payload(input: &PairingQrInput) -> Result<String> {
    if !valid_relay_url(input.relay_url) {
        return Err(SharingError::malformed("relayUrl must be a ws(s) URL"));
    }
    if !valid_fingerprint(input.server_identity_fingerprint) {
        return Err(SharingError::malformed("serverIdentityFingerprint must be sha256:<64 hex>"));
    }
    if !valid_route_id(input.companion_route_id) {
        return Err(SharingError::malformed("companionRouteId must be an entity id"));
    }
    if !valid_b64url32(input.pairing_secret_b64url) {
        return Err(SharingError::malformed("pairingSecret must be 43 base64url chars"));
    }
    if !valid_b64url32(input.mobile_route_ticket_b64url) {
        return Err(SharingError::malformed("mobileRouteTicket must be 43 base64url chars"));
    }
    let payload = json!({
        "protocol": { "major": 1, "minor": input.protocol_minor },
        "companionRouteId": input.companion_route_id,
        "relayUrl": input.relay_url,
        "mobileRouteTicket": input.mobile_route_ticket_b64url,
        "pairingSecret": input.pairing_secret_b64url,
        "serverIdentityFingerprint": input.server_identity_fingerprint,
    });
    Ok(payload.to_string())
}

/// Strict re-parse so the tray can display a stored payload only when it
/// is still a valid v1 pairing QR. Unknown or missing fields fail closed.
pub fn parse_pairing_qr_payload(text: &str) -> Result<Map<String, Value>> {
    let parsed: Value = serde_json::from_str(text)
        .map_err(|_| SharingError::malformed("Pairing QR payload is not valid JSON"))?;
    let Value::Object(fields) = parsed else {
        return Err(SharingError::malformed("Pairing QR payload must be an object"));
    };
    let expected = [
        "protocol",
        "companionRouteId",
        "relayUrl",
        "mobileRouteTicket",
        "pairingSecret",
        "serverIdentityFingerprint",
    ];
    for key in expected {
        if !fields.contains_key(key) {
            return Err(SharingError::malformed(format!("Pairing QR missing {key}")));
        }
    }
    if fields.len() != expected.len() {
        return Err(SharingError::malformed("Pairing QR carries unknown fields"));
    }
    let protocol = fields["protocol"].as_object().ok_or_else(|| SharingError::malformed("protocol must be an object"))?;
    if protocol.len() != 2 || protocol["major"].as_u64() != Some(1) {
        return Err(SharingError::malformed("protocol must be {{major:1,minor:n}}"));
    }
    if protocol["minor"].as_u64().is_none() {
        return Err(SharingError::malformed("protocol minor must be a number"));
    }
    let str_of = |key: &'static str| -> String {
        fields[key].as_str().unwrap_or_default().to_string()
    };
    if !valid_relay_url(&str_of("relayUrl"))
        || !valid_fingerprint(&str_of("serverIdentityFingerprint"))
        || !valid_route_id(&str_of("companionRouteId"))
        || !valid_b64url32(&str_of("pairingSecret"))
        || !valid_b64url32(&str_of("mobileRouteTicket"))
    {
        return Err(SharingError::malformed("Pairing QR fields fail validation"));
    }
    Ok(fields)
}

/// Stable command ids: the native tray maps these to menu items.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayCommand {
    OpenLocalLab,
    StartSharing,
    StopSharing,
    ShowPairingQr,
    ConnectionHealth,
    ManageKeys,
    ManageRoutes,
    ManageVoicePacks,
    QuitSharing,
}

impl TrayCommand {
    pub fn id(self) -> &'static str {
        match self {
            TrayCommand::OpenLocalLab => "open",
            TrayCommand::StartSharing => "start-sharing",
            TrayCommand::StopSharing => "stop-sharing",
            TrayCommand::ShowPairingQr => "show-qr",
            TrayCommand::ConnectionHealth => "health",
            TrayCommand::ManageKeys => "keys",
            TrayCommand::ManageRoutes => "routes",
            TrayCommand::ManageVoicePacks => "voice-packs",
            TrayCommand::QuitSharing => "quit",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            TrayCommand::OpenLocalLab => "Open LocalLab",
            TrayCommand::StartSharing => "Start Sharing",
            TrayCommand::StopSharing => "Stop Sharing",
            TrayCommand::ShowPairingQr => "Show Pairing QR",
            TrayCommand::ConnectionHealth => "Connection Health",
            TrayCommand::ManageKeys => "Manage Paired Devices",
            TrayCommand::ManageRoutes => "Model Routes",
            TrayCommand::ManageVoicePacks => "Voice Packs",
            TrayCommand::QuitSharing => "Quit LocalLab Connect",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrayEffect {
    DisplayQr(String),
    ShowHealth(Vec<String>),
    OpenPanel(&'static str),
    StartService,
    StopService,
    Quit,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SharingStatus {
    pub sharing_enabled: bool,
    pub paired_devices: usize,
    pub voice_pack_ready: bool,
    pub usb_active: bool,
}

/// The tray's current world. `current_qr` holds the payload of the live
/// pairing so "Show Pairing QR" re-displays exactly what was shown at
/// pairing time (rotation replaces it; revoking clears it).
#[derive(Debug, Default)]
pub struct TraySurface {
    status: SharingStatus,
    current_qr: Option<String>,
    health_lines: Vec<String>,
}

impl TraySurface {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn status(&self) -> &SharingStatus {
        &self.status
    }

    pub fn set_status(&mut self, status: SharingStatus) {
        self.status = status;
    }

    pub fn set_current_qr(&mut self, payload: Option<String>) {
        self.current_qr = payload;
    }

    pub fn current_qr(&self) -> Option<&str> {
        self.current_qr.as_deref()
    }

    pub fn set_health_snapshot(&mut self, snapshot: &[(String, bool)]) {
        self.health_lines = snapshot
            .iter()
            .map(|(label, ok)| format!("{}: {}", label, if *ok { "ok" } else { "not reachable" }))
            .collect();
    }

    pub fn available_commands(&self) -> Vec<TrayCommand> {
        let mut commands = vec![TrayCommand::OpenLocalLab];
        if self.status.sharing_enabled {
            commands.push(TrayCommand::StopSharing);
        } else {
            commands.push(TrayCommand::StartSharing);
        }
        if self.status.sharing_enabled && self.current_qr.is_some() {
            commands.push(TrayCommand::ShowPairingQr);
        }
        if self.status.sharing_enabled {
            commands.push(TrayCommand::ConnectionHealth);
            commands.push(TrayCommand::ManageKeys);
            commands.push(TrayCommand::ManageRoutes);
        }
        commands.push(TrayCommand::ManageVoicePacks);
        commands.push(TrayCommand::QuitSharing);
        commands
    }

    pub fn handle(&self, command: TrayCommand) -> Result<TrayEffect> {
        let available = self.available_commands();
        if !available.contains(&command) {
            return Err(SharingError::state(format!("{} is not available right now", command.title())));
        }
        Ok(match command {
            TrayCommand::OpenLocalLab => TrayEffect::OpenPanel("main"),
            TrayCommand::StartSharing => TrayEffect::StartService,
            TrayCommand::StopSharing => TrayEffect::StopService,
            TrayCommand::ShowPairingQr => {
                TrayEffect::DisplayQr(self.current_qr.clone().ok_or_else(|| SharingError::state("no live pairing QR"))?)
            }
            TrayCommand::ConnectionHealth => TrayEffect::ShowHealth(self.health_lines.clone()),
            TrayCommand::ManageKeys => TrayEffect::OpenPanel("keys"),
            TrayCommand::ManageRoutes => TrayEffect::OpenPanel("routes"),
            TrayCommand::ManageVoicePacks => TrayEffect::OpenPanel("voice-packs"),
            TrayCommand::QuitSharing => TrayEffect::Quit,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn qr_input<'a>(secret: &'a str, ticket: &'a str) -> PairingQrInput<'a> {
        PairingQrInput {
            relay_url: "wss://relay.example.org/ws",
            server_identity_fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            companion_route_id: "0198f2a3-0000-7000-8000-0000000000c3",
            pairing_secret_b64url: secret,
            mobile_route_ticket_b64url: ticket,
            protocol_minor: 0,
        }
    }

    fn secrets() -> (String, String) {
        ("A".repeat(43), "B".repeat(43))
    }

    #[test]
    fn qr_payload_is_the_strict_v1_object() {
        let (secret, ticket) = secrets();
        let payload = create_pairing_qr_payload(&qr_input(&secret, &ticket)).expect("valid input builds");
        let fields = parse_pairing_qr_payload(&payload).expect("round trip");
        assert_eq!(fields.len(), 6);
        assert_eq!(fields["protocol"]["major"].as_u64(), Some(1));
        assert_eq!(fields["companionRouteId"].as_str(), Some("0198f2a3-0000-7000-8000-0000000000c3"));
    }

    #[test]
    fn malformed_qr_material_fails_closed() {
        let (secret, ticket) = secrets();
        let mut bad = qr_input(&secret, &ticket);
        bad.pairing_secret_b64url = "short";
        assert_eq!(create_pairing_qr_payload(&bad).expect_err("short secret").kind, "malformed");
        let mut bad = qr_input(&secret, &ticket);
        bad.relay_url = "http://relay.example.org";
        assert_eq!(create_pairing_qr_payload(&bad).expect_err("plain http relay").kind, "malformed");
        let mut bad = qr_input(&secret, &ticket);
        bad.server_identity_fingerprint = "md5:deadbeef";
        assert_eq!(create_pairing_qr_payload(&bad).expect_err("bad fingerprint").kind, "malformed");
        let short = "A".repeat(42);
        let bad = qr_input(&short, &ticket);
        assert_eq!(create_pairing_qr_payload(&bad).expect_err("off-by-one secret").kind, "malformed");
    }

    #[test]
    fn foreign_qr_cannot_be_rebroadcast() {
        let ticket = "B".repeat(43);
        let secret = "A".repeat(43);
        let foreign = format!(
            "{{\"protocol\":{{\"major\":2,\"minor\":0}},\"companionRouteId\":\"0198f2a3-0000-7000-8000-0000000000c3\",\"relayUrl\":\"wss://x.example\",\"mobileRouteTicket\":\"{ticket}\",\"pairingSecret\":\"{secret}\",\"serverIdentityFingerprint\":\"sha256:0000000000000000000000000000000000000000000000000000000000000000\"}}"
        );
        assert_eq!(parse_pairing_qr_payload(&foreign).expect_err("v2 must fail").kind, "malformed");
        assert_eq!(parse_pairing_qr_payload("not json").expect_err("junk").kind, "malformed");
    }

    #[test]
    fn tray_gates_qr_and_manage_items_by_state() {
        let (secret, ticket) = secrets();
        let mut surface = TraySurface::new();
        let idle = surface.available_commands();
        assert!(idle.contains(&TrayCommand::StartSharing));
        assert!(!idle.contains(&TrayCommand::ShowPairingQr), "no QR before sharing");
        surface.set_status(SharingStatus { sharing_enabled: true, paired_devices: 1, voice_pack_ready: false, usb_active: false });
        let no_pairing = surface.available_commands();
        assert!(!no_pairing.contains(&TrayCommand::ShowPairingQr), "sharing but no live pairing");
        surface.set_current_qr(Some(create_pairing_qr_payload(&qr_input(&secret, &ticket)).expect("qr")));
        let ready = surface.available_commands();
        assert!(ready.contains(&TrayCommand::ShowPairingQr));
        assert!(ready.contains(&TrayCommand::QuitSharing), "quit is always available");
    }

    #[test]
    fn show_qr_redisplays_the_live_pairing_and_rotation_replaces_it() {
        let (secret, ticket) = secrets();
        let mut surface = TraySurface::new();
        surface.set_status(SharingStatus { sharing_enabled: true, paired_devices: 1, voice_pack_ready: false, usb_active: false });
        let first = create_pairing_qr_payload(&qr_input(&secret, &ticket)).expect("qr");
        surface.set_current_qr(Some(first.clone()));
        let effect = surface.handle(TrayCommand::ShowPairingQr).expect("available");
        assert_eq!(effect, TrayEffect::DisplayQr(first.clone()));
        let rotated = "C".repeat(43);
        surface.set_current_qr(Some(create_pairing_qr_payload(&qr_input(&rotated, &ticket)).expect("rotated qr")));
        let TrayEffect::DisplayQr(shown) = surface.handle(TrayCommand::ShowPairingQr).expect("rotated") else {
            panic!("expected DisplayQr");
        };
        assert_ne!(shown, first);
        surface.set_current_qr(None);
        assert_eq!(surface.handle(TrayCommand::ShowPairingQr).expect_err("revoked clears QR").kind, "state");
    }

    #[test]
    fn health_snapshot_and_panels_have_stable_surfaces() {
        let mut surface = TraySurface::new();
        surface.set_status(SharingStatus { sharing_enabled: true, paired_devices: 1, voice_pack_ready: true, usb_active: true });
        surface.set_health_snapshot(&[("LM Studio".to_string(), true), ("Ollama".to_string(), false)]);
        let TrayEffect::ShowHealth(lines) = surface.handle(TrayCommand::ConnectionHealth).expect("health") else {
            panic!("expected ShowHealth");
        };
        assert_eq!(lines, vec!["LM Studio: ok".to_string(), "Ollama: not reachable".to_string()]);
        assert_eq!(surface.handle(TrayCommand::ManageVoicePacks).expect("voice"), TrayEffect::OpenPanel("voice-packs"));
        assert_eq!(surface.handle(TrayCommand::QuitSharing).expect("quit"), TrayEffect::Quit);
        // Stopped sharing must not offer the management items.
        surface.set_status(SharingStatus::default());
        assert_eq!(surface.handle(TrayCommand::ManageKeys).expect_err("not while stopped").kind, "state");
    }
}
