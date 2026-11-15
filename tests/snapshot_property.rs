//! Property: a plane resumed from a snapshot and the tail of its ledger is
//! the plane resumed from the whole ledger, and the plane that never
//! stopped (FW-709).
//!
//! Each seed builds a plane with a random configuration and floods it with
//! random calls, as `replay_property` does: arrivals (refusals of every
//! kind included), passes, outcomes, releases, expiries, checkpoints, and
//! changes of settings (`reconfigured` records). At a random step it cuts a
//! checkpoint and takes a snapshot, which goes through its text form. At a
//! later step, two more planes start: one resumed from the whole ledger
//! (`resume_with`), one from the snapshot and only the ledger lines after
//! it (`resume_from_snapshot`). From then on the same calls go to all
//! three, and every call must give all three the same result. At the end:
//!
//! - the same ledger head, the same last checkpoint, and the same queue,
//!   in flight and hold;
//! - the snapshot-resumed ledger verifies, holds only the records after the
//!   snapshot, exports exactly the whole ledger's suffix export from the
//!   snapshot's checkpoint, proves inclusion of each of those records as
//!   the whole ledger does, and, with a signer, has every checkpoint signed;
//! - the two resumed planes count the same stats since they resumed.
//!
//! Some floods sign their intents with a keyring, and some name the
//! settings they start with, so every snapshot names its settings.

use floodwall::intent::{Action, AgentId, BlastRadius, Intent, IntentKey, Priority};
use floodwall::policy::{NoGlobalDestroy, ResourceAllowlist};
use floodwall::reconfigure::Settings;
use floodwall::sha256::sha256;
use floodwall::{
    Aging, Floodwall, Gate, Held, HoldConfig, Keyring, Lease, Ledger, Outcome, RateLimit,
    SchedulerConfig, SigningKey, Snapshot,
};

/// A tiny xorshift PRNG, so every seed is reproducible.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }
}

const AGENTS: [&str; 4] = ["a", "b", "c", "d"];
const RESOURCES: [&str; 5] = ["web", "api", "cache", "db", "queue"];
const LABELS: [&str; 3] = ["s0", "s1", "s2"];

fn key_of(agent: &str) -> SigningKey {
    SigningKey::from_seed(&sha256(format!("snapshot-property/{agent}").as_bytes()))
}

/// One seed's plane, so it can be built again the same way.
#[derive(Clone, Debug)]
struct Config {
    capacity: usize,
    signed: bool,
    checkpoints: Option<u64>,
    signer: bool,
    /// Whether the plane names the settings it starts with.
    labelled: bool,
    /// Per label: burst, refill, allowlist, in-flight limit, hold capacity,
    /// TTL, lease, aging and conflict window.
    settings: Vec<Variant>,
}

#[derive(Clone, Debug)]
struct Variant {
    burst: f64,
    refill: f64,
    no_global_destroy: bool,
    allowlist: Option<Vec<&'static str>>,
    default_limit: usize,
    hold_capacity: usize,
    ttl: Option<u64>,
    lease: Option<Lease>,
    aging: Option<Aging>,
    window: u64,
}

impl Variant {
    fn random(rng: &mut Rng) -> Self {
        Self {
            burst: *rng.pick(&[1.0, 2.0, 3.5, 8.0]),
            refill: *rng.pick(&[0.0, 0.1, 0.3, 0.5, 1.0, 2.5]),
            no_global_destroy: rng.chance(70),
            allowlist: rng.chance(60).then(|| {
                RESOURCES
                    .iter()
                    .copied()
                    .filter(|_| rng.chance(60))
                    .collect()
            }),
            default_limit: *rng.pick(&[1, 2, 3]),
            hold_capacity: *rng.pick(&[0, 1, 3, 64]),
            ttl: *rng.pick(&[None, Some(0), Some(3), Some(15)]),
            lease: *rng.pick(&[None, None, Some(Lease::Report(2)), Some(Lease::Fail(3))]),
            aging: *rng.pick(&[None, None, Some(Aging::new(2, Priority::Urgent))]),
            window: *rng.pick(&[0, 1, 5, 20]),
        }
    }
}

impl Config {
    fn random(rng: &mut Rng, signed: bool) -> Self {
        Self {
            capacity: *rng.pick(&[2, 8, 32, 128]),
            signed,
            checkpoints: rng.chance(50).then(|| *rng.pick(&[1, 3, 16])),
            signer: rng.chance(30),
            labelled: rng.chance(50),
            settings: (0..LABELS.len()).map(|_| Variant::random(rng)).collect(),
        }
    }

    fn settings(&self, label: &str) -> Option<Settings> {
        let v = &self.settings[LABELS.iter().position(|l| *l == label)?];
        let mut gate = Gate::new();
        if v.no_global_destroy {
            gate = gate.with(NoGlobalDestroy);
        }
        if let Some(list) = &v.allowlist {
            gate = gate.with(ResourceAllowlist::new(list.iter().copied()));
        }
        Some(Settings {
            gate,
            rate_limit: RateLimit::new(v.burst, v.refill),
            scheduler: SchedulerConfig::default()
                .with_default_limit(v.default_limit)
                .with_conflict_window(v.window)
                .with_lease(v.lease)
                .with_aging(v.aging),
            hold: HoldConfig::default()
                .with_capacity(v.hold_capacity)
                .with_ttl(v.ttl),
        })
    }

    /// A newly built plane, with the settings the ledger starts under.
    fn plane(&self) -> Floodwall {
        let mut plane = self.settings(LABELS[0]).unwrap().build(self.capacity);
        if self.labelled {
            plane = plane.with_settings_label(LABELS[0]);
        }
        if self.signed {
            let keyring = AGENTS.iter().fold(Keyring::new(), |ring, a| {
                ring.with(*a, key_of(a).verifying_key())
            });
            plane = plane.with_keyring(keyring);
        }
        plane
    }

    /// `ledger`, set up as the plane's.
    fn ledger(&self, mut ledger: Ledger) -> Ledger {
        if let Some(every) = self.checkpoints {
            ledger = ledger.with_checkpoints(every);
        }
        if self.signer {
            ledger = ledger.with_signer(key_of("plane"));
        }
        ledger
    }
}

fn random_intent(rng: &mut Rng, agent: &str, id: u64, signed: bool) -> Intent {
    let resource = rng.pick(&RESOURCES).to_string();
    let action = match rng.below(3) {
        0 => Action::Apply {
            resource,
            manifest: format!("v{}", rng.below(3)),
        },
        1 => Action::Scale {
            resource,
            replicas: rng.below(4) as u32,
        },
        _ => Action::Destroy { resource },
    };
    let priority = *rng.pick(&[
        Priority::Bulk,
        Priority::Normal,
        Priority::Urgent,
        Priority::Pager,
    ]);
    let blast = match rng.below(20) {
        0 => BlastRadius::Global,
        1..=3 => BlastRadius::Region,
        4..=9 => BlastRadius::Service,
        _ => BlastRadius::Cell,
    };
    let intent = Intent::new(id, AgentId::new(agent), action, priority, blast);
    if !signed {
        return intent;
    }
    // Now and then a forgery: signed with another agent's key.
    let signer = if rng.chance(5) {
        AGENTS[(AGENTS.iter().position(|a| *a == agent).unwrap() + 1) % AGENTS.len()]
    } else {
        agent
    };
    intent.signed(&key_of(signer))
}

/// One call to a plane.
#[derive(Clone, Debug)]
enum Op {
    Submit(Intent, u64),
    Tick(u64),
    Complete(IntentKey, Outcome, u64),
    Release(IntentKey, &'static str, u64),
    Expire(IntentKey, u64),
    Reconfigure(&'static str, u64),
    Checkpoint,
}

/// Make `op` on `p`, and say what happened.
fn run(p: &mut Floodwall, config: &Config, op: &Op) -> String {
    match op {
        Op::Submit(intent, at) => format!("submit {:?}", p.submit(intent.clone(), *at)),
        Op::Tick(now) => {
            let r = p.tick(*now);
            let keys = |list: &mut dyn Iterator<Item = String>| list.collect::<Vec<_>>();
            format!(
                "tick {:?} expired {:?} lapsed {:?} overdue {:?}",
                keys(&mut r.decisions.iter().map(|d| format!(
                    "{} {:?} {:?}",
                    d.intent.key(),
                    d.verdict,
                    d.breakdown
                ))),
                keys(&mut r.expired.iter().map(|h| h.intent.key().to_string())),
                keys(&mut r.lapsed.iter().map(|f| f.intent.key().to_string())),
                keys(
                    &mut r
                        .overdue
                        .iter()
                        .map(|f| format!("{} {}", f.intent.key(), f.since))
                ),
            )
        }
        Op::Complete(key, outcome, now) => format!(
            "complete {:?}",
            p.complete(key, outcome.clone(), *now).map(|i| i.key())
        ),
        Op::Release(key, by, now) => format!("release {:?}", p.release(key, by, *now)),
        Op::Expire(key, now) => format!(
            "expire {:?}",
            p.expire(key, "carol", *now).map(|h| h.intent.key())
        ),
        Op::Reconfigure(label, now) => format!(
            "reconfigure {:?}",
            p.reconfigure(config.settings(label).unwrap(), label, *now)
        ),
        Op::Checkpoint => format!("checkpoint {}", p.checkpoint().size),
    }
}

/// One step's calls, worked out from what `p` holds.
fn step_ops(
    rng: &mut Rng,
    p: &Floodwall,
    config: &Config,
    next_id: &mut [u64],
    now: u64,
) -> Vec<Op> {
    let mut ops = Vec::new();
    for _ in 0..rng.below(8) {
        let who = rng.below(AGENTS.len() as u64) as usize;
        let id = if rng.chance(10) && next_id[who] > 0 {
            rng.below(next_id[who]) + 1 // perhaps still live: a duplicate
        } else {
            next_id[who] += 1;
            next_id[who]
        };
        let intent = random_intent(rng, AGENTS[who], id, config.signed);
        ops.push(Op::Submit(intent, now.saturating_sub(rng.below(2))));
    }
    if rng.chance(5) {
        ops.push(Op::Reconfigure(
            LABELS[rng.below(LABELS.len() as u64) as usize],
            now,
        ));
    }
    if rng.chance(80) {
        ops.push(Op::Tick(now));
    }
    // What is in flight and held is read before the pass above runs, so
    // some of these find their intent gone: that is a result too.
    for f in p.in_flight() {
        if rng.chance(40) {
            let outcome = if rng.chance(15) {
                Outcome::Failed("broke".into())
            } else {
                Outcome::Succeeded
            };
            ops.push(Op::Complete(f.intent.key(), outcome, now));
        }
    }
    let held: Vec<&Held> = p.held().collect();
    for h in held {
        match rng.below(10) {
            0 | 1 => ops.push(Op::Release(h.intent.key(), "alice", now)),
            2 => ops.push(Op::Expire(h.intent.key(), now)),
            _ => {}
        }
    }
    if rng.chance(10) {
        ops.push(Op::Checkpoint);
    }
    ops
}

fn state(p: &Floodwall) -> String {
    let queued: Vec<&Intent> = p.queued().collect();
    let in_flight: Vec<(&Intent, u64)> = p.in_flight().map(|f| (&f.intent, f.since)).collect();
    let held: Vec<&Held> = p.held().collect();
    format!(
        "clock {}\nqueued {queued:?}\nin flight {in_flight:?}\nheld {held:?}",
        p.clock()
    )
}

#[derive(Default, Debug)]
struct Coverage {
    floods: usize,
    tail_records: usize,
    snapshot_queued: usize,
    snapshot_in_flight: usize,
    snapshot_held: usize,
    snapshot_released: usize,
    labelled_snapshots: usize,
    reconfigured_in_tail: usize,
    calls_after_resume: usize,
}

fn check(seed: u64, signed: bool, cov: &mut Coverage) {
    let mut rng = Rng::new(seed ^ 0x5a5a);
    let config = Config::random(&mut rng, signed);
    let settings = |label: &str| config.settings(label);
    let snap_at = rng.below(30) as usize;
    let resume_at = snap_at + rng.below(10) as usize;

    let mut a = config.plane().with_ledger(config.ledger(Ledger::new()));
    let mut resumed: Option<(Floodwall, Floodwall)> = None;
    let mut snapshot: Option<Snapshot> = None;
    let mut next_id = [0u64; AGENTS.len()];
    let mut now = 0u64;
    for step in 0..40 {
        for op in step_ops(&mut rng, &a, &config, &mut next_id, now) {
            let want = run(&mut a, &config, &op);
            if let Some((b, c)) = &mut resumed {
                assert_eq!(run(b, &config, &op), want, "seed {seed} step {step}: whole");
                assert_eq!(
                    run(c, &config, &op),
                    want,
                    "seed {seed} step {step}: snapshot"
                );
                cov.calls_after_resume += 1;
            }
        }
        if step == snap_at {
            a.checkpoint();
            let taken = a.snapshot().expect("at a checkpoint");
            let text = taken.to_json();
            let read = Snapshot::from_json(&text).unwrap();
            assert_eq!(read, taken, "seed {seed}");
            cov.snapshot_queued += a.pending();
            cov.snapshot_in_flight += a.in_flight().count();
            cov.snapshot_held += a.held().count();
            cov.snapshot_released += usize::from(text.contains("\"by\":"));
            cov.labelled_snapshots += usize::from(read.settings_label().is_some());
            snapshot = Some(read);
        }
        if step == resume_at {
            let snap = snapshot.as_ref().unwrap();
            let mut whole = Vec::new();
            a.ledger().export_jsonl(&mut whole).unwrap();
            let b = config
                .plane()
                .resume_with(
                    config.ledger(Ledger::read_jsonl(&whole[..]).unwrap()),
                    a.clock(),
                    settings,
                )
                .unwrap_or_else(|e| panic!("seed {seed}: the whole ledger: {e}"));
            let mut tail = Vec::new();
            a.ledger()
                .export_jsonl_from(snap.checkpoint(), &mut tail)
                .unwrap();
            let tail = config.ledger(snap.read_tail(&tail).unwrap());
            cov.tail_records += tail.len();
            cov.reconfigured_in_tail += tail
                .records()
                .iter()
                .filter(|r| r.verdict == "reconfigured")
                .count();
            let c = config
                .plane()
                .resume_from_snapshot(snap, tail, a.clock(), settings)
                .unwrap_or_else(|e| panic!("seed {seed}: the snapshot: {e}"));
            for p in [&b, &c] {
                assert_eq!(p.ledger().head(), a.ledger().head(), "seed {seed}");
                assert_eq!(state(p), state(&a), "seed {seed}");
                assert_eq!(p.settings_label(), b.settings_label(), "seed {seed}");
            }
            resumed = Some((b, c));
        }
        now += rng.below(3);
    }

    let (b, c) = resumed.expect("resumed before the end");
    let snap = snapshot.unwrap();
    for p in [&b, &c] {
        assert_eq!(p.ledger().head(), a.ledger().head(), "seed {seed}");
        assert_eq!(p.ledger().size(), a.ledger().size(), "seed {seed}");
        assert_eq!(
            p.ledger().checkpoints().last(),
            a.ledger().checkpoints().last(),
            "seed {seed}"
        );
        assert_eq!(state(p), state(&a), "seed {seed}");
        assert!(p.ledger().verify(), "seed {seed}");
    }
    assert_eq!(
        b.stats().prometheus(),
        c.stats().prometheus(),
        "seed {seed}"
    );

    // The snapshot-resumed ledger is the whole one's suffix.
    let ledger = c.ledger();
    assert_eq!(
        ledger.len() as u64,
        a.ledger().size() - snap.checkpoint().size,
        "seed {seed}"
    );
    let (mut mine, mut theirs) = (Vec::new(), Vec::new());
    ledger.export_jsonl(&mut mine).unwrap();
    a.ledger()
        .export_jsonl_from(snap.checkpoint(), &mut theirs)
        .unwrap();
    assert_eq!(mine, theirs, "seed {seed}: suffix export");
    let size = ledger.size();
    for seq in (snap.checkpoint().size..size).step_by(7) {
        assert_eq!(
            ledger.prove_inclusion(seq, size),
            a.ledger().prove_inclusion(seq, size),
            "seed {seed}: proof of {seq}"
        );
    }
    if config.signer {
        assert_eq!(
            ledger.verify_checkpoint_signatures(&key_of("plane").verifying_key()),
            Ok(ledger.checkpoints().len()),
            "seed {seed}"
        );
    }
    cov.floods += 1;
}

#[test]
fn a_snapshot_and_its_tail_resume_like_the_whole_ledger() {
    let mut cov = Coverage::default();
    for seed in 0..120 {
        check(seed, false, &mut cov);
    }
    println!("{cov:#?}");
    assert_eq!(cov.floods, 120);
    assert!(cov.tail_records > 500, "{cov:?}");
    assert!(cov.calls_after_resume > 1000, "{cov:?}");
    assert!(cov.snapshot_queued > 50, "{cov:?}");
    assert!(cov.snapshot_in_flight > 50, "{cov:?}");
    assert!(cov.snapshot_held > 20, "{cov:?}");
    assert!(cov.snapshot_released > 5, "{cov:?}");
    assert!(cov.labelled_snapshots > 30, "{cov:?}");
    assert!(cov.reconfigured_in_tail > 5, "{cov:?}");
}

#[test]
fn signed_floods_resume_from_snapshots_too() {
    let mut cov = Coverage::default();
    for seed in 2000..2006 {
        check(seed, true, &mut cov);
    }
    assert!(
        cov.tail_records > 0 && cov.calls_after_resume > 0,
        "{cov:?}"
    );
}
