//! T102 (RE-07, RE-10, UI-15): startup, window-close vs Quit,
//! sleep/wake reconciliation and protocol version compatibility.
//!
//! Decisions (the native shell executes the emitted effects):
//! - closing the app WINDOW never stops the authorized sharing service
//!   when keep_sharing_on_close is set — the menu-bar item keeps
//!   serving paired iPhones; an explicit Quit ALWAYS stops it,
//! - optional start-at-login is a persisted setting surfaced as a
//!   SetLoginItem effect for the native launch-at-login API,
//! - wake from sleep re-attaches live transports (relay reconnect, USB
//!   session re-hello) instead of silently serving on dead sockets,
//! - protocol compatibility mirrors `assertProtocolCompatible` from
//!   `packages/service-contracts/src/pairing.ts`: major must match, and
//!   a peer requiring a minor level this build does not know fails
//!   closed with an upgrade prompt pointing at the side that is behind.

use core::fmt;

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleError {
    pub kind: &'static str,
    pub message: String,
}

impl LifecycleError {
    fn malformed(message: impl Into<String>) -> Self {
        Self { kind: "malformed", message: message.into() }
    }
}

impl fmt::Display for LifecycleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for LifecycleError {}

pub type Result<T, E = LifecycleError> = core::result::Result<T, E>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LifecycleSettings {
    pub start_at_login: bool,
    pub keep_sharing_on_close: bool,
}

impl Default for LifecycleSettings {
    fn default() -> Self {
        // Official behavior parity: window close keeps sharing, and
        // start-at-login is OFF until the user opts in.
        Self { start_at_login: false, keep_sharing_on_close: true }
    }
}

impl LifecycleSettings {
    pub fn encode(&self) -> String {
        format!(
            "start-at-login={}\nkeep-sharing-on-close={}\n",
            u8::from(self.start_at_login),
            u8::from(self.keep_sharing_on_close),
        )
    }

    /// Fail closed: unknown keys, bad booleans or missing keys reject the
    /// whole store rather than half-applying settings after an upgrade.
    pub fn parse(text: &str) -> Result<Self> {
        let mut start_at_login = None;
        let mut keep_sharing_on_close = None;
        for line in text.lines() {
            if line.is_empty() {
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                return Err(LifecycleError::malformed("lifecycle row is not key=value"));
            };
            let bit = match value {
                "0" => false,
                "1" => true,
                _ => return Err(LifecycleError::malformed(format!("lifecycle value for {key} is not a bit"))),
            };
            match key {
                "start-at-login" => start_at_login = Some(bit),
                "keep-sharing-on-close" => keep_sharing_on_close = Some(bit),
                _ => return Err(LifecycleError::malformed(format!("unknown lifecycle key {key}"))),
            }
        }
        match (start_at_login, keep_sharing_on_close) {
            (Some(a), Some(b)) => Ok(Self { start_at_login: a, keep_sharing_on_close: b }),
            _ => Err(LifecycleError::malformed("lifecycle store is missing a key")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProtocolVersion {
    pub major: u32,
    pub minor: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionVerdict {
    Compatible,
    /// The phone speaks a minor level this Mac build does not know.
    MacNeedsUpdate(String),
    /// Major differs: the prompt names the side that is actually behind.
    MajorMismatch {
        peer_newer: bool,
        prompt: String,
    },
}

/// Mirror of TS assertProtocolCompatible, as prompts instead of throws.
pub fn version_verdict(local: ProtocolVersion, peer: ProtocolVersion) -> VersionVerdict {
    if local.major != peer.major {
        let prompt = if peer.major > local.major {
            format!(
                "The iPhone requires LocalLab Connect {peer_major}.x. Update LocalLab Connect on this Mac to keep pairing.",
                peer_major = peer.major
            )
        } else {
            format!(
                "This iPhone is too old for this Mac's LocalLab Connect. Update the iPhone app to keep pairing."
            )
        };
        return VersionVerdict::MajorMismatch { peer_newer: peer.major > local.major, prompt };
    }
    if peer.minor > local.minor {
        return VersionVerdict::MacNeedsUpdate(format!(
            "The iPhone uses a newer LocalLab protocol (1.{peer_minor}). Update LocalLab Connect on this Mac to keep pairing.",
            peer_minor = peer.minor
        ));
    }
    VersionVerdict::Compatible
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LifecycleEvent {
    WindowClosed,
    WindowReopened,
    QuitRequested,
    SleepDetected,
    WakeDetected,
    /// A paired device announced its protocol at (re)connect.
    PeerProtocol { route_id: String, peer: ProtocolVersion },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LifecycleEffect {
    /// Window closed with keep-sharing: the menu-bar service keeps serving.
    ContinueSharingInTray,
    StopSharing,
    StopAll,
    Reconnect,
    ShowUpgradePrompt(String),
    SetLoginItem(bool),
}

#[derive(Debug)]
pub struct LifecycleMachine {
    settings: LifecycleSettings,
    window_open: bool,
    sharing_enabled: bool,
    suspended: bool,
    incompatible_peers: BTreeMap<String, String>,
}
impl LifecycleMachine {
    pub fn new(settings: LifecycleSettings) -> Self {
        Self {
            settings,
            window_open: true,
            sharing_enabled: false,
            suspended: false,
            incompatible_peers: BTreeMap::new(),
        }
    }

    pub fn window_open(&self) -> bool {
        self.window_open
    }

    pub fn settings(&self) -> LifecycleSettings {
        self.settings
    }

    pub fn sharing_enabled(&self) -> bool {
        self.sharing_enabled
    }

    pub fn start_sharing(&mut self) {
        self.sharing_enabled = true;
        self.suspended = false;
    }

    pub fn toggle_start_at_login(&mut self, enabled: bool) -> Vec<LifecycleEffect> {
        self.settings.start_at_login = enabled;
        vec![LifecycleEffect::SetLoginItem(enabled)]
    }

    pub fn set_keep_sharing_on_close(&mut self, enabled: bool) {
        self.settings.keep_sharing_on_close = enabled;
    }

    /// Prompt copy stays visible until the pairing rotates or updates.
    pub fn incompatible_prompt(&self, route_id: &str) -> Option<&str> {
        self.incompatible_peers.get(route_id).map(String::as_str)
    }

    pub fn handle(&mut self, event: LifecycleEvent, local: ProtocolVersion) -> Vec<LifecycleEffect> {
        match event {
            LifecycleEvent::WindowClosed => {
                self.window_open = false;
                if self.sharing_enabled && self.settings.keep_sharing_on_close {
                    vec![LifecycleEffect::ContinueSharingInTray]
                } else if self.sharing_enabled {
                    self.sharing_enabled = false;
                    vec![LifecycleEffect::StopSharing]
                } else {
                    Vec::new()
                }
            }
            LifecycleEvent::WindowReopened => {
                self.window_open = true;
                Vec::new()
            }
            LifecycleEvent::QuitRequested => {
                // Explicit Quit always stops the authorized service —
                // even with keep-sharing-on-close set (UI-15 semantics).
                self.window_open = false;
                self.sharing_enabled = false;
                vec![LifecycleEffect::StopAll]
            }
            LifecycleEvent::SleepDetected => {
                self.suspended = true;
                Vec::new()
            }
            LifecycleEvent::WakeDetected => {
                if self.suspended && self.sharing_enabled {
                    self.suspended = false;
                    vec![LifecycleEffect::Reconnect]
                } else {
                    Vec::new()
                }
            }
            LifecycleEvent::PeerProtocol { route_id, peer } => match version_verdict(local, peer) {
                VersionVerdict::Compatible => {
                    self.incompatible_peers.remove(&route_id);
                    Vec::new()
                }
                VersionVerdict::MacNeedsUpdate(prompt) | VersionVerdict::MajorMismatch { prompt, .. } => {
                    self.incompatible_peers.insert(route_id, prompt.clone());
                    vec![LifecycleEffect::ShowUpgradePrompt(prompt)]
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local() -> ProtocolVersion {
        ProtocolVersion { major: 1, minor: 0 }
    }

    #[test]
    fn closing_the_window_keeps_the_authorized_service_and_quit_stops_it() {
        let mut machine = LifecycleMachine::new(LifecycleSettings::default());
        machine.start_sharing();
        let effects = machine.handle(LifecycleEvent::WindowClosed, local());
        assert_eq!(effects, vec![LifecycleEffect::ContinueSharingInTray]);
        assert!(machine.sharing_enabled(), "service still serving from the menu bar");
        let effects = machine.handle(LifecycleEvent::QuitRequested, local());
        assert_eq!(effects, vec![LifecycleEffect::StopAll]);
        assert!(!machine.sharing_enabled());
    }

    #[test]
    fn keep_sharing_disabled_makes_close_stop_the_service() {
        let settings = LifecycleSettings { start_at_login: false, keep_sharing_on_close: false };
        let mut machine = LifecycleMachine::new(settings);
        machine.start_sharing();
        let effects = machine.handle(LifecycleEvent::WindowClosed, local());
        assert_eq!(effects, vec![LifecycleEffect::StopSharing]);
        assert!(!machine.sharing_enabled());
    }

    #[test]
    fn sleep_then_wake_restores_connections_once() {
        let mut machine = LifecycleMachine::new(LifecycleSettings::default());
        machine.start_sharing();
        assert!(machine.handle(LifecycleEvent::WakeDetected, local()).is_empty(), "no phantom reconnect");
        machine.handle(LifecycleEvent::SleepDetected, local());
        let effects = machine.handle(LifecycleEvent::WakeDetected, local());
        assert_eq!(effects, vec![LifecycleEffect::Reconnect]);
        assert!(machine.handle(LifecycleEvent::WakeDetected, local()).is_empty(), "wake is consumed");
    }

    #[test]
    fn version_mismatch_prompts_upgrade_naming_the_behind_side() {
        let mut machine = LifecycleMachine::new(LifecycleSettings::default());
        machine.start_sharing();
        let effects = machine.handle(
            LifecycleEvent::PeerProtocol { route_id: "route-a".into(), peer: ProtocolVersion { major: 1, minor: 3 } },
            local(),
        );
        let [LifecycleEffect::ShowUpgradePrompt(prompt)] = effects.as_slice() else {
            panic!("minor-ahead peer must prompt: {effects:?}");
        };
        assert!(prompt.contains("Update LocalLab Connect on this Mac"), "{prompt}");
        assert_eq!(machine.incompatible_prompt("route-a"), Some(prompt.as_str()));
        // The phone being far behind names the phone's side instead.
        let effects = machine.handle(
            LifecycleEvent::PeerProtocol { route_id: "route-b".into(), peer: ProtocolVersion { major: 2, minor: 0 } },
            local(),
        );
        let [LifecycleEffect::ShowUpgradePrompt(prompt)] = effects.as_slice() else {
            panic!("major mismatch must prompt");
        };
        assert!(prompt.contains("Update LocalLab Connect on this Mac"), "{prompt}");
        let effects = machine.handle(
            LifecycleEvent::PeerProtocol { route_id: "route-c".into(), peer: ProtocolVersion { major: 0, minor: 9 } },
            local(),
        );
        let [LifecycleEffect::ShowUpgradePrompt(prompt)] = effects.as_slice() else {
            panic!("older major must prompt");
        };
        assert!(prompt.contains("Update the iPhone app"), "{prompt}");
        // A compatible re-handshake clears the prompt.
        let effects = machine.handle(
            LifecycleEvent::PeerProtocol { route_id: "route-b".into(), peer: ProtocolVersion { major: 1, minor: 0 } },
            local(),
        );
        assert!(effects.is_empty());
        assert_eq!(machine.incompatible_prompt("route-b"), None);
    }

    #[test]
    fn settings_round_trip_and_fail_closed_store() {
        let settings = LifecycleSettings { start_at_login: true, keep_sharing_on_close: false };
        let text = settings.encode();
        assert_eq!(LifecycleSettings::parse(&text).expect("round trip"), settings);
        assert_eq!(LifecycleSettings::parse("").expect_err("missing keys").kind, "malformed");
        assert_eq!(LifecycleSettings::parse("start-at-login=1\nkeep-sharing-on-close=yes\n").expect_err("bad bit").kind, "malformed");
        assert_eq!(LifecycleSettings::parse("start-at-login=1\nkeep-sharing-on-close=1\nextra=1\n").expect_err("unknown key").kind, "malformed");
        let default = LifecycleSettings::default();
        assert!(!default.start_at_login, "startup stays opt-in");
        assert!(default.keep_sharing_on_close, "close keeps sharing by default");
    }

    #[test]
    fn login_item_toggle_persists_into_the_store() {
        let mut machine = LifecycleMachine::new(LifecycleSettings::default());
        let effects = machine.toggle_start_at_login(true);
        assert_eq!(effects, vec![LifecycleEffect::SetLoginItem(true)]);
        let text = machine.settings().encode();
        assert_eq!(LifecycleSettings::parse(&text).expect("persisted").start_at_login, true);
    }
}
