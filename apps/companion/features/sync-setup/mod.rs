//! T098A (SY-02, SY-03, SY-07) — Home Mac sync opt-in and initial choice.
//!
//! Companion-side counterpart of `packages/sync/preferences`: the per-pair
//! opt-in record the sync transport (T098C) must consult before queueing a
//! single batch. Rules kept here:
//!
//! - opt-in alone never releases data; the initial choice (copy from phone,
//!   copy from Mac, merge) must also be recorded,
//! - disabling sync keeps the record, the choice and the completion stamp —
//!   local chat copies on either side are never touched by this module,
//! - persisted state round-trips exactly (restart survives choice and
//!   disable/re-enable), and malformed stored rows fail closed.

use core::fmt;

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncSetupError {
    pub kind: &'static str,
    pub message: String,
}

impl SyncSetupError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
    fn state(message: impl Into<String>) -> Self {
        Self::new("state", message)
    }
    fn malformed(message: impl Into<String>) -> Self {
        Self::new("malformed", message)
    }
}

impl fmt::Display for SyncSetupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SyncSetupError {}

pub type Result<T, E = SyncSetupError> = core::result::Result<T, E>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncChoice {
    /// Copy this Mac's chats onto the phone.
    CopyMac,
    /// Copy the phone's chats onto this Mac.
    CopyPhone,
    /// Merge both sides.
    Merge,
}

impl SyncChoice {
    pub fn label(self) -> &'static str {
        match self {
            SyncChoice::CopyMac => "Chats copied from the Home Mac",
            SyncChoice::CopyPhone => "Chats copied from this iPhone",
            SyncChoice::Merge => "Both chat sets merged",
        }
    }
    fn token(self) -> &'static str {
        match self {
            SyncChoice::CopyMac => "copy-mac",
            SyncChoice::CopyPhone => "copy-phone",
            SyncChoice::Merge => "merge",
        }
    }
    fn parse(token: &str) -> Result<Self> {
        match token {
            "copy-mac" => Ok(SyncChoice::CopyMac),
            "copy-phone" => Ok(SyncChoice::CopyPhone),
            "merge" => Ok(SyncChoice::Merge),
            other => Err(SyncSetupError::malformed(format!("unknown sync choice {other}"))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairSyncSetup {
    pub route_id: String,
    pub enabled: bool,
    pub choice: Option<SyncChoice>,
    pub initial_sync_done: bool,
}

/// Per-pair setup table keyed by paired route id.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncSetupRegistry {
    by_route: BTreeMap<String, PairSyncSetup>,
}

impl SyncSetupRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn find(&self, route_id: &str) -> Option<&PairSyncSetup> {
        self.by_route.get(route_id)
    }

    /// The pairing-time opt-in (or a later Settings toggle). Re-enabling
    /// after a disable keeps the previous choice and completion stamp.
    pub fn opt_in(&mut self, route_id: &str) {
        let entry = self.by_route.entry(route_id.to_string()).or_insert_with(|| PairSyncSetup {
            route_id: route_id.to_string(),
            enabled: true,
            choice: None,
            initial_sync_done: false,
        });
        entry.enabled = true;
    }

    /// SY-07: flipping sync off changes only this row; both local chat
    /// copies stay intact and the choice is retained for a later re-enable.
    pub fn opt_out(&mut self, route_id: &str) -> Result<()> {
        let entry = self.by_route.get_mut(route_id).ok_or_else(|| {
            SyncSetupError::state("cannot disable sync for a pair that was never enabled")
        })?;
        entry.enabled = false;
        Ok(())
    }

    pub fn set_choice(&mut self, route_id: &str, choice: SyncChoice) -> Result<()> {
        let entry = self.by_route.get_mut(route_id).ok_or_else(|| {
            SyncSetupError::state("opt in to sync before choosing an initial mode")
        })?;
        if entry.initial_sync_done {
            return Err(SyncSetupError::state("the initial sync choice is already recorded"));
        }
        entry.choice = Some(choice);
        Ok(())
    }

    pub fn complete_initial(&mut self, route_id: &str) -> Result<()> {
        let entry = self.by_route.get_mut(route_id).ok_or_else(|| {
            SyncSetupError::state("choose an initial sync mode before completing it")
        })?;
        if entry.choice.is_none() {
            return Err(SyncSetupError::state("choose an initial sync mode before completing it"));
        }
        entry.initial_sync_done = true;
        Ok(())
    }

    /// The gate the transport consults: enabled AND choice recorded.
    pub fn allowed(&self, route_id: &str) -> bool {
        self.by_route
            .get(route_id)
            .is_some_and(|entry| entry.enabled && entry.choice.is_some())
    }

    /// Stable line format: `route\tstate\tchoice\tinitial_done` (choice is
    /// `-` before it is made). Round-trips exactly; unknown shapes reject.
    pub fn to_text(&self) -> String {
        let mut out = String::new();
        for entry in self.by_route.values() {
            let choice = entry.choice.map_or_else(|| "-".to_string(), |c| c.token().to_string());
            out.push_str(&format!(
                "{}\t{}\t{}\t{}\n",
                entry.route_id,
                if entry.enabled { "on" } else { "off" },
                choice,
                if entry.initial_sync_done { "done" } else { "pending" }
            ));
        }
        out
    }

    pub fn from_text(text: &str) -> Result<Self> {
        let mut by_route = BTreeMap::new();
        for (line_no, line) in text.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() != 4 {
                return Err(SyncSetupError::malformed(format!("line {}: expected 4 fields", line_no + 1)));
            }
            let route_id = fields[0].to_string();
            if route_id.is_empty() {
                return Err(SyncSetupError::malformed(format!("line {}: empty route id", line_no + 1)));
            }
            let enabled = match fields[1] {
                "on" => true,
                "off" => false,
                other => {
                    return Err(SyncSetupError::malformed(format!("line {}: bad enabled flag {other}", line_no + 1)))
                }
            };
            let choice = if fields[2] == "-" { None } else { Some(SyncChoice::parse(fields[2])?) };
            let initial_sync_done = match fields[3] {
                "done" => true,
                "pending" => false,
                other => {
                    return Err(SyncSetupError::malformed(format!("line {}: bad initial flag {other}", line_no + 1)))
                }
            };
            if by_route.insert(route_id.clone(), PairSyncSetup { route_id, enabled, choice, initial_sync_done }).is_some() {
                return Err(SyncSetupError::malformed(format!("line {}: duplicate route id", line_no + 1)));
            }
        }
        Ok(Self { by_route })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROUTE: &str = "0198f2a3-0000-7000-8000-0000000000a1";

    #[test]
    fn opt_in_choice_and_restart_round_trip() {
        let mut registry = SyncSetupRegistry::new();
        registry.opt_in(ROUTE);
        assert!(!registry.allowed(ROUTE), "opt-in alone releases nothing");
        registry.set_choice(ROUTE, SyncChoice::Merge).unwrap();
        registry.complete_initial(ROUTE).unwrap();
        assert!(registry.allowed(ROUTE));

        let revived = SyncSetupRegistry::from_text(&registry.to_text()).unwrap();
        assert!(revived.allowed(ROUTE));
        assert_eq!(revived.find(ROUTE).unwrap().choice, Some(SyncChoice::Merge));
        assert_eq!(revived, registry, "round trip is exact");
    }

    #[test]
    fn disable_re_enable_keeps_choice_history_and_local_copies() {
        let mut registry = SyncSetupRegistry::new();
        registry.opt_in(ROUTE);
        registry.set_choice(ROUTE, SyncChoice::CopyMac).unwrap();
        registry.complete_initial(ROUTE).unwrap();

        registry.opt_out(ROUTE).unwrap();
        assert!(!registry.allowed(ROUTE));
        let off = registry.find(ROUTE).unwrap();
        assert!(!off.enabled);
        assert_eq!(off.choice, Some(SyncChoice::CopyMac), "choice retained");
        assert!(off.initial_sync_done, "initial copy never repeated");

        registry.opt_in(ROUTE);
        assert!(registry.allowed(ROUTE));
        // Re-opt-in does not re-open the initial-choice prompt.
        assert!(matches!(
            registry.set_choice(ROUTE, SyncChoice::Merge),
            Err(SyncSetupError { kind: "state", .. })
        ));
    }

    #[test]
    fn stray_operations_fail_closed() {
        let mut registry = SyncSetupRegistry::new();
        assert!(matches!(registry.opt_out(ROUTE), Err(SyncSetupError { kind: "state", .. })));
        assert!(matches!(registry.set_choice(ROUTE, SyncChoice::Merge), Err(SyncSetupError { kind: "state", .. })));
        assert!(matches!(registry.complete_initial(ROUTE), Err(SyncSetupError { kind: "state", .. })));
    }

    #[test]
    fn corrupt_rows_reject() {
        assert!(matches!(
            SyncSetupRegistry::from_text("route-x\ton\tmerge"),
            Err(SyncSetupError { kind: "malformed", .. })
        ));
        assert!(matches!(
            SyncSetupRegistry::from_text("route-x\tmaybe\tmerge\tdone"),
            Err(SyncSetupError { kind: "malformed", .. })
        ));
        assert!(matches!(
            SyncSetupRegistry::from_text("route-x\ton\tsideways\tdone"),
            Err(SyncSetupError { kind: "malformed", .. })
        ));
        assert!(matches!(
            SyncSetupRegistry::from_text("route-x\ton\tmerge\tdone\nroute-x\ton\tmerge\tdone"),
            Err(SyncSetupError { kind: "malformed", .. })
        ));
        assert_eq!(SyncSetupRegistry::from_text("").unwrap(), SyncSetupRegistry::new());
    }

    #[test]
    fn choice_labels_name_the_effect() {
        assert_eq!(SyncChoice::CopyPhone.label(), "Chats copied from this iPhone");
        assert_eq!(SyncChoice::CopyMac.label(), "Chats copied from the Home Mac");
        assert_eq!(SyncChoice::Merge.label(), "Both chat sets merged");
    }
}
