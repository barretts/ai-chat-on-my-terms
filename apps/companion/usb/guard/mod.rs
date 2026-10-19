//! T101 (RE-11): mutual exclusion + device visibility for the USB route.
//!
//! A paired device talks to the companion through EXACTLY ONE path at a
//! time — remote (relay, Wi-Fi) or USB (cable) — so sequence windows,
//! sync cursors and media windows can never fork into two live sessions
//! for the same pairing. ModeGuard enforces that at session-admission
//! time from either side; UsbDeviceTracker is the Mac companion UI's
//! source of truth for "is the iPhone on the cable right now", including
//! the untrusted-attach state Apple's CoreDevice pairing prompt requires.

use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceMode {
    Remote,
    Usb,
}

impl DeviceMode {
    pub fn label(self) -> &'static str {
        match self {
            DeviceMode::Remote => "remote",
            DeviceMode::Usb => "usb",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsbGuardError {
    pub kind: &'static str,
    pub message: String,
}

/// One active session per pairing, whichever path claimed it first.
/// Re-claiming the SAME mode is idempotent (session resume after a
/// brief cable wobble); the other mode is refused until release.
#[derive(Debug, Default)]
pub struct ModeGuard {
    active: BTreeMap<String, DeviceMode>,
}

impl ModeGuard {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn claim(&mut self, device_id: &str, mode: DeviceMode) -> Result<(), UsbGuardError> {
        match self.active.get(device_id) {
            None => {
                self.active.insert(device_id.to_string(), mode);
                Ok(())
            }
            Some(current) if *current == mode => Ok(()),
            Some(current) => Err(UsbGuardError {
                kind: "excluded",
                message: format!(
                    "this iPhone already has a live {current} session; {mode} is refused until it closes",
                    current = current.label(),
                    mode = mode.label()
                ),
            }),
        }
    }

    /// Release only closes the mode that still matches — a late release
    /// from a dead remote socket must never evict a fresh USB session.
    pub fn release(&mut self, device_id: &str, mode: DeviceMode) -> bool {
        match self.active.get(device_id) {
            Some(current) if *current == mode => {
                self.active.remove(device_id);
                true
            }
            _ => false,
        }
    }

    pub fn mode_of(&self, device_id: &str) -> Option<DeviceMode> {
        self.active.get(device_id).copied()
    }
}

/// Cable-attach state machine driven by macOS USB/CoreDevice events.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum UsbDeviceState {
    #[default]
    Unattached,
    /// On the cable but the iPhone has NOT trusted this Mac yet.
    Untrusted,
    /// Cable + Apple trust established, session not yet authenticated.
    Trusted,
    /// usb-hello/ready handshake done; sealed traffic is live.
    Active,
}

#[derive(Debug, Default)]
pub struct UsbDeviceTracker {
    state: UsbDeviceState,
}

impl UsbDeviceTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self) -> UsbDeviceState {
        self.state
    }

    pub fn attach(&mut self, trusted: bool) {
        self.state = if trusted { UsbDeviceState::Trusted } else { UsbDeviceState::Untrusted };
    }

    pub fn trust_granted(&mut self) {
        if self.state == UsbDeviceState::Untrusted {
            self.state = UsbDeviceState::Trusted;
        }
    }

    /// Only a trusted device can go Active — the handshake itself
    /// happens on top of an Apple-verified cable.
    pub fn mark_active(&mut self) -> bool {
        if self.state == UsbDeviceState::Trusted {
            self.state = UsbDeviceState::Active;
            true
        } else {
            false
        }
    }

    pub fn detach(&mut self) {
        self.state = UsbDeviceState::Unattached;
    }

    /// Copy for the Mac companion UI (T102 renders this verbatim).
    pub fn ui_note(&self) -> &'static str {
        match self.state {
            UsbDeviceState::Unattached => "No iPhone connected over USB.",
            UsbDeviceState::Untrusted => "iPhone detected — unlock it and choose Trust to allow the connection.",
            UsbDeviceState::Trusted => "iPhone trusted on this Mac — ready to start a USB session.",
            UsbDeviceState::Active => "iPhone connected over USB — chat and sync use the cable; remote mode is off.",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usb_and_remote_are_mutually_exclusive_per_device() {
        let mut guard = ModeGuard::new();
        assert_eq!(guard.mode_of("dev-1"), None);
        guard.claim("dev-1", DeviceMode::Remote).expect("remote first");
        let err = guard.claim("dev-1", DeviceMode::Usb).expect_err("usb must be refused");
        assert_eq!(err.kind, "excluded");
        assert!(err.message.contains("remote session"));
        // Same-mode re-claim is idempotent (resume after cable wobble).
        guard.claim("dev-1", DeviceMode::Remote).expect("same mode re-claim");
        // Different devices never collide.
        guard.claim("dev-2", DeviceMode::Usb).expect("other device unaffected");
        assert!(guard.release("dev-1", DeviceMode::Remote));
        guard.claim("dev-1", DeviceMode::Usb).expect("usb after release");
    }

    #[test]
    fn stale_release_cannot_evict_the_live_mode() {
        let mut guard = ModeGuard::new();
        guard.claim("dev-1", DeviceMode::Usb).expect("usb first");
        assert!(!guard.release("dev-1", DeviceMode::Remote));
        assert_eq!(guard.mode_of("dev-1"), Some(DeviceMode::Usb));
    }

    #[test]
    fn tracker_requires_trust_before_active_and_resets_on_unplug() {
        let mut tracker = UsbDeviceTracker::new();
        assert_eq!(tracker.state(), UsbDeviceState::Unattached);
        tracker.attach(false);
        assert_eq!(tracker.state(), UsbDeviceState::Untrusted);
        assert!(!tracker.mark_active(), "untrusted cable can never go Active");
        tracker.trust_granted();
        assert_eq!(tracker.state(), UsbDeviceState::Trusted);
        assert!(tracker.mark_active());
        tracker.detach();
        assert_eq!(tracker.state(), UsbDeviceState::Unattached);
    }

    #[test]
    fn ui_copy_covers_every_cable_state() {
        let mut tracker = UsbDeviceTracker::new();
        let unattached = tracker.ui_note();
        tracker.attach(false);
        let untrusted = tracker.ui_note();
        tracker.trust_granted();
        let trusted = tracker.ui_note();
        tracker.mark_active();
        let active = tracker.ui_note();
        let notes = [unattached, untrusted, trusted, active];
        for note in notes {
            assert!(note.contains("iPhone"), "copy names the device: {note}");
        }
        assert!(active.contains("remote mode is off"));
    }
}
