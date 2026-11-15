//! Changing a running plane's settings without losing its history.
//!
//! A plane is built once, but a hosted plane lives for months: its rules get
//! a new revision, its rate limit is raised, its hold gets a TTL. Replaying a
//! ledger (see [`crate::replay`]) needs the settings each part of it was
//! written under, so a change of settings is itself recorded.
//!
//! [`Floodwall::reconfigure`] swaps the gate, the rate limit, the scheduler
//! settings and the hold settings at once, and appends a `reconfigured`
//! record whose reason is the caller's `label` for the new settings: a
//! digest of how the caller describes them is the natural choice. The record
//! is about no intent; its agent is [`PLANE_AGENT`] and its intent id is 0.
//!
//! [`Floodwall::resume_with`] replays a ledger that holds such records: at
//! each one, it asks the caller for the settings that `label` names and
//! applies them, as the live plane did. [`Floodwall::resume`] knows no
//! labels, so it refuses a ledger with a `reconfigured` record as
//! [`ResumeError::Unreplayable`](crate::ResumeError::Unreplayable).
//!
//! What a change does to work already at the wall:
//!
//! - Waiting intents are ruled on by the new gate at the next pass.
//! - Each agent keeps the tokens it had; the new limit applies from now,
//!   capped at the new burst.
//! - Intents in flight stay in flight. Scheduling limits, the conflict
//!   window, a lease and aging take their new values at the next pass.
//!   Conflict claims already closed under the old window are dropped at
//!   the change, so a wider window does not revive them.
//! - Agents whose buckets are full under the old limit are forgotten at the
//!   change (a full bucket and none are the same), so a bigger burst treats
//!   them alike however lazily the plane had pruned.
//! - Held intents stay held. A new TTL applies to each from the tick it was
//!   held; a smaller capacity evicts nothing now, and only limits new holds.
//!
//! ```
//! use floodwall::{Admission, Floodwall, Gate, Ledger, RateLimit, SchedulerConfig, HoldConfig};
//! use floodwall::reconfigure::Settings;
//!
//! let first = || Settings {
//!     gate: Gate::new(),
//!     rate_limit: RateLimit::new(4.0, 1.0),
//!     scheduler: SchedulerConfig::default(),
//!     hold: HoldConfig::default(),
//! };
//! let second = || Settings {
//!     gate: Gate::new().with_rules("format 1\npolicy \"no-destroy\" {\n  reject \"no destroys\" when destructive\n}\n").unwrap(),
//!     ..first()
//! };
//! let mut plane = first().build(64);
//! plane.reconfigure(second(), "v2", 3).unwrap();
//!
//! // After a restart, the replay asks for "v2" when it reaches that record.
//! let mut export = Vec::new();
//! plane.ledger().export_jsonl(&mut export).unwrap();
//! let ledger = Ledger::read_jsonl(&export[..]).unwrap();
//! let resumed = first()
//!     .build(64)
//!     .resume_with(ledger, 4, |label| (label == "v2").then(second))
//!     .unwrap();
//! assert_eq!(resumed.ledger().head(), plane.ledger().head());
//! ```

use crate::admission::InvalidRateLimit;
use crate::ledger::{self, Evidence};
use crate::{Admission, Floodwall, Gate, HoldConfig, RateLimit, SchedulerConfig};

/// The verdict on the record a change of settings writes.
pub const RECONFIGURED: &str = "reconfigured";

/// The agent named on a record the plane writes about itself.
pub const PLANE_AGENT: &str = "floodwall";

/// Everything about a plane that [`Floodwall::reconfigure`] can change.
pub struct Settings {
    /// The policy stack.
    pub gate: Gate,
    /// Each agent's rate limit.
    pub rate_limit: RateLimit,
    /// When waiting intents may start.
    pub scheduler: SchedulerConfig,
    /// How deferred intents are held.
    pub hold: HoldConfig,
}

impl Settings {
    /// A new plane with these settings and a queue of at most `capacity`
    /// waiting intents.
    ///
    /// # Panics
    ///
    /// Panics if the rate limit is invalid (see [`RateLimit::try_new`]).
    pub fn build(self, capacity: usize) -> Floodwall {
        Floodwall::new(Admission::new(capacity, self.rate_limit), self.gate)
            .with_scheduler(self.scheduler)
            .with_hold(self.hold)
    }
}

impl Floodwall {
    /// Swap this plane's settings at logical time `now`, and record the
    /// change as a `reconfigured` record whose reason is `label` (see
    /// [`crate::reconfigure`]). An invalid rate limit is refused, and
    /// nothing changes.
    ///
    /// # Panics
    ///
    /// Panics if the ledger is on disk and cannot be written (see
    /// [Durability](Floodwall#durability)).
    pub fn reconfigure(
        &mut self,
        settings: Settings,
        label: &str,
        now: u64,
    ) -> Result<(), InvalidRateLimit> {
        settings.rate_limit.validate()?;
        let now = self.advance(now);
        // State a plane drops lazily, in passes and checks that record
        // nothing, is dropped here under the old settings first: a replay
        // does not see those passes, and the new settings could otherwise
        // make the dropped and the kept state rule differently. Claims
        // closed under the old window, and rate-limit buckets already full
        // under the old limit (a full bucket is the same as none), go.
        self.scheduler.drop_closed_claims(now);
        self.admission.prune_idle(now);
        self.apply_settings(settings);
        self.settings_label = Some(label.to_string());
        let tick = self.ledger.advance_clock(now);
        debug_assert_eq!(tick, now, "the ledger's clock ran ahead of the plane's");
        let evidence = Evidence {
            action: "reconfigure".into(),
            reason: Some(label.to_string()),
            ..Evidence::default()
        };
        if let Err(e) = self
            .ledger
            .try_append_with(0, PLANE_AGENT, RECONFIGURED, evidence)
        {
            ledger::write_failed(e);
        }
        Ok(())
    }

    pub(crate) fn apply_settings(&mut self, settings: Settings) {
        self.gate = settings.gate;
        self.admission.set_rate_limit(settings.rate_limit);
        self.scheduler.set_config(settings.scheduler);
        self.hold.set_config(settings.hold);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::{Action, AgentId, BlastRadius, Intent, Priority};
    use crate::{Ledger, ResumeError, Verdict};

    fn open() -> Settings {
        Settings {
            gate: Gate::new(),
            rate_limit: RateLimit::new(8.0, 1.0),
            scheduler: SchedulerConfig::default(),
            hold: HoldConfig::default(),
        }
    }

    fn strict() -> Settings {
        Settings {
            gate: Gate::new()
                .with_rules("format 1\npolicy \"no-destroy\" {\n  reject \"no destroys\" when destructive\n}\n")
                .unwrap(),
            ..open()
        }
    }

    fn destroy(id: u64) -> Intent {
        Intent::new(
            id,
            AgentId::new("janitor"),
            Action::Destroy {
                resource: format!("svc-{id}"),
            },
            Priority::Normal,
            BlastRadius::Service,
        )
    }

    fn reload(plane: &Floodwall) -> Ledger {
        let mut out = Vec::new();
        plane.ledger().export_jsonl(&mut out).unwrap();
        Ledger::read_jsonl(&out[..]).unwrap()
    }

    #[test]
    fn the_new_gate_rules_from_the_next_pass() {
        let mut plane = open().build(16);
        plane.submit(destroy(1), 0).unwrap();
        assert_eq!(plane.tick(0).decisions[0].verdict, Verdict::Admit);
        plane.reconfigure(strict(), "strict", 1).unwrap();
        plane.submit(destroy(2), 2).unwrap();
        assert_eq!(
            plane.tick(2).decisions[0].verdict,
            Verdict::Reject("no destroys".into())
        );
        let change = &plane.ledger().records()[2];
        assert_eq!(change.verdict, RECONFIGURED);
        assert_eq!(change.agent, PLANE_AGENT);
        assert_eq!(change.evidence.reason.as_deref(), Some("strict"));
        assert!(change.intent.is_none());
        assert_eq!(change.tick, 1);
        assert!(plane.ledger().verify());
    }

    #[test]
    fn resume_with_replays_each_change_with_its_settings() {
        let mut plane = open().build(16);
        plane.submit(destroy(1), 0).unwrap();
        plane.tick(0);
        plane.reconfigure(strict(), "strict", 1).unwrap();
        plane.submit(destroy(2), 2).unwrap();
        plane.tick(2);
        plane.reconfigure(open(), "open", 3).unwrap();
        plane.submit(destroy(3), 4).unwrap();
        plane.tick(4);

        let resumed = open()
            .build(16)
            .resume_with(reload(&plane), 5, |label| match label {
                "strict" => Some(strict()),
                "open" => Some(open()),
                _ => None,
            })
            .unwrap();
        assert_eq!(resumed.ledger().head(), plane.ledger().head());
        assert_eq!(resumed.in_flight().count(), 2);
    }

    #[test]
    fn the_settings_in_force_at_the_end_carry_on_after_resume() {
        let mut plane = open().build(16);
        plane.reconfigure(strict(), "strict", 1).unwrap();
        let mut resumed = open()
            .build(16)
            .resume_with(reload(&plane), 2, |label| (label == "strict").then(strict))
            .unwrap();
        resumed.submit(destroy(9), 3).unwrap();
        assert_eq!(
            resumed.tick(3).decisions[0].verdict,
            Verdict::Reject("no destroys".into())
        );
    }

    #[test]
    fn plain_resume_refuses_a_change_it_cannot_name() {
        let mut plane = open().build(16);
        plane.reconfigure(strict(), "strict", 1).unwrap();
        let e = open().build(16).resume(reload(&plane), 2).err().unwrap();
        assert!(matches!(e, ResumeError::Unreplayable { seq: 0, .. }), "{e}");
    }

    #[test]
    fn an_invalid_rate_limit_changes_nothing() {
        let mut plane = open().build(16);
        let bad = Settings {
            rate_limit: RateLimit {
                burst: 0.0,
                refill_per_tick: 1.0,
            },
            ..strict()
        };
        assert!(plane.reconfigure(bad, "bad", 1).is_err());
        assert!(plane.ledger().is_empty());
        plane.submit(destroy(1), 2).unwrap();
        assert_eq!(plane.tick(2).decisions[0].verdict, Verdict::Admit);
    }

    #[test]
    fn a_new_burst_caps_what_an_agent_has_saved() {
        let mut plane = open().build(16);
        let tight = Settings {
            rate_limit: RateLimit::new(1.0, 0.0),
            ..open()
        };
        plane.reconfigure(tight, "tight", 0).unwrap();
        plane.submit(destroy(1), 0).unwrap();
        assert!(plane.submit(destroy(2), 0).is_err());
    }
}
