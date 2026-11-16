//! The gate in the floodwall.
//!
//! Every intent that reaches the gate is ruled on by the full policy stack. The
//! gate combines those rulings with *deny-overrides*: the harshest verdict
//! wins, so a single `Reject` blocks the change no matter how many policies
//! admit it.
//!
//! # AI review
//!
//! An intent may carry a model's [`Review`](crate::Review), attached by the
//! plane before it reaches the gate. After every policy has ruled, the gate
//! adds the review to the breakdown as [`AI_REVIEW`]: a `Defer` outcome
//! defers with the model's reason, and `Clear` or `Skipped` admit. Combined
//! deny-overrides like any policy, a review can make the decision stricter
//! but never admit a change another policy deferred or rejected. An intent
//! without a review is ruled on exactly as before, with no such entry.

use crate::intent::{Intent, ReviewOutcome};
use crate::policy::{Policy, Verdict};
use crate::rules::BundleId;

/// The breakdown entry for an intent's AI review (see [AI review](self#ai-review)).
pub const AI_REVIEW: &str = "ai-review";

/// The combined ruling plus the per-policy breakdown that produced it.
#[derive(Debug)]
pub struct GateDecision {
    /// The deny-overrides combination of every policy's verdict.
    pub verdict: Verdict,
    /// Each policy's name and its individual verdict, in evaluation order.
    pub breakdown: Vec<(String, Verdict)>,
}

/// A deny-overrides stack of policies.
#[derive(Default)]
pub struct Gate {
    policies: Vec<Box<dyn Policy>>,
    /// The bundles of the rules files loaded into the stack, in order.
    pub(crate) bundles: Vec<BundleId>,
}

impl Gate {
    /// An empty gate. With no policies it admits everything.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a policy to the stack. Builder style.
    pub fn with(mut self, policy: impl Policy + 'static) -> Self {
        self.policies.push(Box::new(policy));
        self
    }

    /// Number of policies in the stack.
    pub fn len(&self) -> usize {
        self.policies.len()
    }

    /// Whether the stack is empty.
    pub fn is_empty(&self) -> bool {
        self.policies.is_empty()
    }

    /// The policy bundles the stack's rules came from, in the order they
    /// were loaded ([`Gate::with_rules`]; see
    /// [Bundles](crate::rules#bundles)). Every decision records them.
    pub fn bundles(&self) -> &[BundleId] {
        &self.bundles
    }

    /// Rule on one intent, returning the combined verdict and the full
    /// breakdown. The breakdown always records every policy, even once the
    /// combined verdict is already a `Reject`, so the audit trail is complete.
    ///
    /// An intent with a review gets one more entry after the policies,
    /// [`AI_REVIEW`] (see [AI review](self#ai-review)).
    pub fn evaluate(&self, intent: &Intent) -> GateDecision {
        let mut combined = Verdict::Admit;
        let mut breakdown = Vec::with_capacity(self.policies.len() + 1);
        let review = intent.review.as_ref().map(|review| {
            let verdict = match &review.outcome {
                ReviewOutcome::Defer(reason) => Verdict::Defer(reason.clone()),
                ReviewOutcome::Clear | ReviewOutcome::Skipped(_) => Verdict::Admit,
            };
            (AI_REVIEW.to_string(), verdict)
        });
        let rulings = self
            .policies
            .iter()
            .map(|policy| (policy.name().to_string(), policy.evaluate(intent)))
            .chain(review);
        for (name, verdict) in rulings {
            if verdict.rank() > combined.rank() {
                combined = verdict.clone();
            }
            breakdown.push((name, verdict));
        }
        GateDecision {
            verdict: combined,
            breakdown,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::{Action, AgentId, BlastRadius, Intent, Priority, Review};
    use crate::policy::{BlastNeedsPriority, NoGlobalDestroy, ResourceAllowlist};

    fn review(outcome: ReviewOutcome) -> Review {
        Review {
            model: "claude-opus-5-5".into(),
            prompt_sha256: "ab".repeat(32),
            outcome,
        }
    }

    fn intent(priority: Priority, blast: BlastRadius, resource: &str) -> Intent {
        Intent::new(
            0,
            AgentId::new("a"),
            Action::Apply {
                resource: resource.into(),
                manifest: String::new(),
            },
            priority,
            blast,
        )
    }

    #[test]
    fn empty_gate_admits() {
        let gate = Gate::new();
        assert!(gate.is_empty());
        let d = gate.evaluate(&intent(Priority::Bulk, BlastRadius::Global, "x"));
        assert_eq!(d.verdict, Verdict::Admit);
        assert!(d.breakdown.is_empty());
    }

    #[test]
    fn deny_overrides_picks_the_harshest_verdict() {
        // allowlist would Defer "x", blast-needs-priority would Reject a Bulk
        // global. Reject must win over Defer.
        let gate = Gate::new()
            .with(ResourceAllowlist::new(["web"]))
            .with(BlastNeedsPriority);
        let d = gate.evaluate(&intent(Priority::Bulk, BlastRadius::Global, "x"));
        assert!(matches!(d.verdict, Verdict::Reject(_)));
        assert_eq!(d.breakdown.len(), 2);
    }

    #[test]
    fn defer_beats_admit_when_nothing_rejects() {
        let gate = Gate::new()
            .with(NoGlobalDestroy)
            .with(ResourceAllowlist::new(["web"]));
        // "x" is off the allowlist -> Defer; nothing rejects -> combined Defer.
        let d = gate.evaluate(&intent(Priority::Normal, BlastRadius::Cell, "x"));
        assert!(matches!(d.verdict, Verdict::Defer(_)));
    }

    #[test]
    fn all_admit_is_admit() {
        let gate = Gate::new()
            .with(NoGlobalDestroy)
            .with(BlastNeedsPriority)
            .with(ResourceAllowlist::new(["web"]));
        let d = gate.evaluate(&intent(Priority::Normal, BlastRadius::Cell, "web"));
        assert_eq!(d.verdict, Verdict::Admit);
        assert_eq!(d.breakdown.len(), 3);
    }

    #[test]
    fn a_review_is_one_more_entry_after_the_policies() {
        let gate = Gate::new()
            .with(NoGlobalDestroy)
            .with(ResourceAllowlist::new(["web"]));
        let plain = intent(Priority::Normal, BlastRadius::Cell, "web");
        let without = gate.evaluate(&plain);
        assert_eq!(without.verdict, Verdict::Admit);
        assert_eq!(without.breakdown.len(), 2, "no review, no entry");

        let deferred = gate.evaluate(
            &plain
                .clone()
                .with_review(review(ReviewOutcome::Defer("drops a table".into()))),
        );
        assert_eq!(deferred.verdict, Verdict::Defer("drops a table".into()));
        assert_eq!(deferred.breakdown[..2], without.breakdown[..]);
        assert_eq!(
            deferred.breakdown[2],
            (
                AI_REVIEW.to_string(),
                Verdict::Defer("drops a table".into())
            )
        );

        for outcome in [
            ReviewOutcome::Clear,
            ReviewOutcome::Skipped("timeout".into()),
        ] {
            let d = gate.evaluate(&plain.clone().with_review(review(outcome)));
            assert_eq!(d.verdict, Verdict::Admit);
            assert_eq!(d.breakdown[2], (AI_REVIEW.to_string(), Verdict::Admit));
        }
    }

    #[test]
    fn a_review_never_admits_past_another_policy() {
        let gate = Gate::new()
            .with(ResourceAllowlist::new(["web"]))
            .with(BlastNeedsPriority);
        for outcome in [
            ReviewOutcome::Clear,
            ReviewOutcome::Skipped("budget".into()),
            ReviewOutcome::Defer("risky".into()),
        ] {
            // A Bulk global change is rejected: no review admits it, and a
            // review's defer does not soften it.
            let rejected = intent(Priority::Bulk, BlastRadius::Global, "web")
                .with_review(review(outcome.clone()));
            assert!(matches!(
                gate.evaluate(&rejected).verdict,
                Verdict::Reject(_)
            ));
            // "x" is off the allowlist: still deferred, for the allowlist's
            // reason (on a tie the earlier entry's reason stands).
            let deferred =
                intent(Priority::Normal, BlastRadius::Cell, "x").with_review(review(outcome));
            let d = gate.evaluate(&deferred);
            assert!(matches!(d.verdict, Verdict::Defer(_)));
            assert_eq!(d.verdict, d.breakdown[0].1, "the allowlist's defer stands");
        }
    }
}
