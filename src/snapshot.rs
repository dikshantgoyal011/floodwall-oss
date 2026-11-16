//! Snapshots: waking a plane without replaying its whole ledger.
//!
//! [`Floodwall::resume`] rebuilds a plane by replaying every record its
//! ledger holds (see [`crate::replay`]), so the longer a plane lives, the
//! longer it takes to wake. A [`Snapshot`] is the plane's state at a
//! checkpoint of its ledger: [`Floodwall::resume_from_snapshot`] takes that
//! state up and replays only the records after the checkpoint, checking
//! them digest for digest as [`Floodwall::resume`] does, and the plane
//! carries on exactly as if it had replayed everything.
//!
//! ```
//! use floodwall::{Admission, Floodwall, Gate, Ledger, RateLimit, Snapshot};
//! use floodwall::intent::{Action, AgentId, BlastRadius, Intent, Priority};
//!
//! let plane = || Floodwall::new(Admission::new(64, RateLimit::new(4.0, 1.0)), Gate::new());
//! let scale = |id| Intent::new(
//!     id,
//!     AgentId::new("deployer"),
//!     Action::Scale { resource: format!("svc-{id}"), replicas: 2 },
//!     Priority::Normal,
//!     BlastRadius::Service,
//! );
//! let mut before = plane();
//! before.submit(scale(1), 0).unwrap();
//! before.tick(1); // svc-1 is in flight
//!
//! // A snapshot is taken at a checkpoint that covers every record, and
//! // stored with the ledger: in its text form, say.
//! before.checkpoint();
//! let stored = before.snapshot().unwrap().to_json();
//!
//! before.submit(scale(2), 2).unwrap(); // svc-2 is queued
//!
//! // The plane stops. Another, built the same way, picks up from the
//! // snapshot and only the ledger after it.
//! let snapshot = Snapshot::from_json(&stored).unwrap();
//! let mut tail = Vec::new();
//! before.ledger().export_jsonl_from(snapshot.checkpoint(), &mut tail).unwrap();
//! let tail = snapshot.read_tail(&tail).unwrap();
//! let after = plane().resume_from_snapshot(&snapshot, tail, 2, |_| None).unwrap();
//! assert_eq!(after.in_flight().count(), 1);
//! assert_eq!(after.pending(), 1);
//! assert_eq!(after.ledger().head(), before.ledger().head());
//! assert_eq!(after.ledger().records().len(), 1); // only the tail
//! ```
//!
//! # What a snapshot holds
//!
//! Everything a replay would rebuild that is not configuration: the queue,
//! in order, with each intent's place in it and the tick it joined; each
//! agent's rate-limit bucket; what is in flight and since when; each
//! resource's conflict claims, in flight or completed and still in their
//! window; what is held, why and since when; which held intents were
//! released back into the queue and by whom; with a keyring, the highest id
//! queued for each agent; and the clock. It also names the checkpoint it was
//! taken at, with the tick the ledger had reached there, and the label of
//! the settings in force (see [`crate::reconfigure`]).
//!
//! Configuration is not in it: the queue's capacity, and the gate, rate
//! limit, scheduler and hold settings, come from the plane resumed, as for
//! [`Floodwall::resume`] (see [What must match](crate::replay#what-must-match)).
//! Build the plane with the settings the ledger started under; if the
//! snapshot names a label (the latest `reconfigured` record's, or one given
//! to [`Floodwall::with_settings_label`]), resuming asks for the settings it
//! names and applies them, as replaying the `reconfigured` record would.
//!
//! # When a snapshot is taken
//!
//! A snapshot is the plane's state right after a checkpoint:
//! [`Floodwall::snapshot`] gives one only while the ledger's latest
//! checkpoint covers every record, so cut one first with
//! [`Floodwall::checkpoint`]. A checkpoint the ledger cuts by itself every
//! so many records ([`Ledger::with_checkpoints`]) can land partway through a
//! call, where there is no state to take.
//!
//! # Trust
//!
//! A snapshot is the plane's own summary of its history, kept beside its
//! ledger: whoever can rewrite it can rewrite what the plane does next, as
//! whoever can rewrite the ledger can. What resuming checks is that the
//! snapshot is consistent with itself and with the plane (its intents, with
//! a keyring, signed by their agents) and that the ledger after it chains
//! from its checkpoint and replays exactly. Its digest catches corruption,
//! not forgery: to trust the history before the checkpoint, check the
//! checkpoint's signature against the plane's key, and audit the ledger up
//! to it (see [`crate::checkpoint`]).
//!
//! # Text form
//!
//! [`Snapshot::to_json`] writes one line of JSON, in the style of the
//! [ledger export](crate::export): exactly these keys, in this order, ticks
//! and ids as decimal strings, digests and signatures as lowercase hex.
//!
//! ```text
//! {"type":"snapshot","version":1,
//!  "checkpoint":<a checkpoint line, as in the export>,
//!  "ledger_clock":"12","clock":"14","settings":"<label>"|null,
//!  "admission":{"seq":"9","prune_at":"1024","clock":"14",
//!    "queue":[{"seq":"8","since":"13","intent":<intent>},...],
//!    "buckets":[{"agent":"deployer","tokens":"<f64 bits, 16 hex>","last":"13"},...]},
//!  "in_flight":[{"intent":<intent>,"since":"12"},...],
//!  "claims":[{"resource":"web","claims":[
//!    {"agent":"deployer","id":"7","action":<action>,"done_at":"12"|null},...]},...],
//!  "hold":{"next":"3","held":[{"slot":"2","intent":<intent>,"since":"11","reason":"..."},...]},
//!  "released":[{"agent":"deployer","id":"5","by":"alice"},...],
//!  "signed_ids":[{"agent":"deployer","id":"9"},...],
//!  "digest":"<hex>"}
//! ```
//!
//! Each `<intent>` is in the export's intent form, with its `review` when
//! a model reviewed it (see [`crate::export`]), so a held intent keeps the
//! review that holds it.
//!
//! `digest` is SHA-256 over the field `floodwall/snapshot/v1` (its length as
//! a little-endian `u64`, then the bytes) followed by the line's bytes up to
//! the comma before `"digest"`. [`Snapshot::from_json`] refuses a line whose
//! digest does not match, and, like the ledger reader, anything not written
//! exactly as `to_json` writes it.
//!
//! [`Ledger::with_checkpoints`]: crate::Ledger::with_checkpoints

use std::collections::HashSet;

use crate::admission::AdmissionState;
use crate::checkpoint::Checkpoint;
use crate::durable::{self, ReadError};
use crate::export::{
    action_json, checkpoint_line, decimal, fields, hex, intent_json, json_str, number, read_action,
    read_checkpoint, read_intent, read_line, string, Line,
};
use crate::hold::Held;
use crate::intent::{AgentId, Intent, IntentKey};
use crate::json::{self, Value};
use crate::ledger::{Digest, Ledger};
use crate::reconfigure::Settings;
use crate::replay::{authenticate, ResumeError};
use crate::scheduler::{Claim, InFlight};
use crate::sha256::Sha256;
use crate::Floodwall;

/// The `version` a snapshot's text form names.
pub const VERSION: u64 = 1;

const SNAPSHOT_DOMAIN: &[u8] = b"floodwall/snapshot/v1";

/// A plane's state at a checkpoint of its ledger (see [`crate::snapshot`]).
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    checkpoint: Checkpoint,
    ledger_clock: u64,
    clock: u64,
    settings: Option<String>,
    admission: AdmissionState,
    in_flight: Vec<InFlight>,
    claims: Vec<(String, Vec<Claim>)>,
    held: Vec<(u64, Held)>,
    hold_next: u64,
    released: Vec<(IntentKey, String)>,
    signed_ids: Vec<(AgentId, u64)>,
}

impl Snapshot {
    /// The checkpoint the snapshot was taken at. The ledger to resume with
    /// holds the records after it.
    pub fn checkpoint(&self) -> &Checkpoint {
        &self.checkpoint
    }

    /// The tick the ledger had reached at the checkpoint: no record after
    /// it is earlier.
    pub fn ledger_clock(&self) -> u64 {
        self.ledger_clock
    }

    /// The plane's clock when the snapshot was taken.
    pub fn clock(&self) -> u64 {
        self.clock
    }

    /// The label of the settings in force when the snapshot was taken, if
    /// the plane had one (see [What a snapshot holds](self#what-a-snapshot-holds)).
    pub fn settings_label(&self) -> Option<&str> {
        self.settings.as_deref()
    }

    /// A ledger that starts at the snapshot's checkpoint
    /// ([`Ledger::starting_at`]), holding the records in `lines`: export
    /// lines (records and checkpoints, each ending with `\n`) that follow
    /// the checkpoint, as a plane writes them. They may start with the
    /// checkpoint's own line, and with the header of a suffix export from
    /// it ([`Ledger::export_jsonl_from`]). Every line is checked as
    /// [`Ledger::read_jsonl`] checks it, from the checkpoint's head and
    /// frontier.
    pub fn read_tail(&self, lines: &[u8]) -> Result<Ledger, ReadError> {
        let ledger =
            Ledger::starting_at(self.checkpoint.clone(), self.ledger_clock).map_err(|problem| {
                ReadError::Invalid {
                    line: 1,
                    offset: 0,
                    problem,
                }
            })?;
        let mut rest = lines;
        if lines.starts_with(b"{\"type\":\"header\"") {
            let end = lines
                .iter()
                .position(|&b| b == b'\n')
                .unwrap_or(lines.len());
            let invalid = |problem: String| ReadError::Invalid {
                line: 1,
                offset: 0,
                problem,
            };
            let text = std::str::from_utf8(&lines[..end])
                .map_err(|_| invalid("the line is not UTF-8".into()))?;
            match read_line(text).map_err(invalid)? {
                Line::Header { from } if from == self.checkpoint.size => {}
                _ => {
                    return Err(invalid(format!(
                        "not the header of an export from the snapshot's checkpoint (size {})",
                        self.checkpoint.size
                    )))
                }
            }
            rest = lines.get(end + 1..).unwrap_or_default();
        }
        durable::load_into(ledger, rest, false)
    }

    /// The snapshot as one line of JSON (see [Text form](self#text-form)).
    pub fn to_json(&self) -> String {
        let mut s = String::from("{\"type\":\"snapshot\",\"version\":");
        s.push_str(&VERSION.to_string());
        s.push_str(",\"checkpoint\":");
        s.push_str(&checkpoint_line(&self.checkpoint));
        s.push_str(&format!(
            ",\"ledger_clock\":\"{}\",\"clock\":\"{}\",\"settings\":",
            self.ledger_clock, self.clock
        ));
        match &self.settings {
            Some(label) => json_str(&mut s, label),
            None => s.push_str("null"),
        }
        let a = &self.admission;
        s.push_str(&format!(
            ",\"admission\":{{\"seq\":\"{}\",\"prune_at\":\"{}\",\"clock\":\"{}\",\"queue\":[",
            a.seq, a.prune_at, a.clock
        ));
        for (i, (seq, since, intent)) in a.queue.iter().enumerate() {
            comma(&mut s, i);
            s.push_str(&format!(
                "{{\"seq\":\"{seq}\",\"since\":\"{since}\",\"intent\":"
            ));
            intent_json(&mut s, intent);
            s.push('}');
        }
        s.push_str("],\"buckets\":[");
        for (i, (agent, tokens, last)) in a.buckets.iter().enumerate() {
            comma(&mut s, i);
            s.push_str("{\"agent\":");
            json_str(&mut s, agent.as_str());
            s.push_str(&format!(
                ",\"tokens\":\"{:016x}\",\"last\":\"{last}\"}}",
                tokens.to_bits()
            ));
        }
        s.push_str("]},\"in_flight\":[");
        for (i, f) in self.in_flight.iter().enumerate() {
            comma(&mut s, i);
            s.push_str("{\"intent\":");
            intent_json(&mut s, &f.intent);
            s.push_str(&format!(",\"since\":\"{}\"}}", f.since));
        }
        s.push_str("],\"claims\":[");
        for (i, (resource, claims)) in self.claims.iter().enumerate() {
            comma(&mut s, i);
            s.push_str("{\"resource\":");
            json_str(&mut s, resource);
            s.push_str(",\"claims\":[");
            for (j, c) in claims.iter().enumerate() {
                comma(&mut s, j);
                key_fields(&mut s, &c.key);
                s.push_str(",\"action\":");
                action_json(&mut s, &c.action);
                s.push_str(",\"done_at\":");
                match c.done_at {
                    Some(t) => s.push_str(&format!("\"{t}\"")),
                    None => s.push_str("null"),
                }
                s.push('}');
            }
            s.push_str("]}");
        }
        s.push_str(&format!(
            "],\"hold\":{{\"next\":\"{}\",\"held\":[",
            self.hold_next
        ));
        for (i, (slot, held)) in self.held.iter().enumerate() {
            comma(&mut s, i);
            s.push_str(&format!("{{\"slot\":\"{slot}\",\"intent\":"));
            intent_json(&mut s, &held.intent);
            s.push_str(&format!(",\"since\":\"{}\",\"reason\":", held.since));
            json_str(&mut s, &held.reason);
            s.push('}');
        }
        s.push_str("]},\"released\":[");
        for (i, (key, by)) in self.released.iter().enumerate() {
            comma(&mut s, i);
            key_fields(&mut s, key);
            s.push_str(",\"by\":");
            json_str(&mut s, by);
            s.push('}');
        }
        s.push_str("],\"signed_ids\":[");
        for (i, (agent, id)) in self.signed_ids.iter().enumerate() {
            comma(&mut s, i);
            key_fields(&mut s, &IntentKey::new(agent.as_str(), *id));
            s.push('}');
        }
        s.push(']');
        let digest = body_digest(&s);
        s.push_str(&format!(",\"digest\":\"{digest}\"}}"));
        s
    }

    /// Read a snapshot back from [`Snapshot::to_json`]'s text. Refuses
    /// anything else: another version, a digest that does not match, text
    /// not written exactly as `to_json` writes it, or a snapshot that is
    /// not consistent with itself.
    pub fn from_json(text: &str) -> Result<Snapshot, String> {
        let value = json::parse(text).map_err(|e| format!("not JSON this reader accepts: {e}"))?;
        let f = fields(
            &value,
            &[
                "type",
                "version",
                "checkpoint",
                "ledger_clock",
                "clock",
                "settings",
                "admission",
                "in_flight",
                "claims",
                "hold",
                "released",
                "signed_ids",
                "digest",
            ],
            "the snapshot",
        )?;
        if string(f[0], "type")? != "snapshot" {
            return Err("not a snapshot".into());
        }
        let version = number(f[1], "version")?;
        if version != VERSION {
            return Err(format!("unsupported snapshot version {version}"));
        }
        // The digest first: a damaged snapshot is reported as such.
        let digest = Digest(hex(f[12], "digest")?);
        let tail = format!(",\"digest\":\"{digest}\"}}");
        let body = text
            .strip_suffix(&tail)
            .ok_or("the snapshot does not end with its digest")?;
        if body_digest(body) != digest {
            return Err("the snapshot does not match its digest".into());
        }

        let checkpoint = read_checkpoint(f[2])?;
        if !checkpoint.is_well_formed() {
            return Err("the snapshot's checkpoint is not well formed".into());
        }
        let settings = match f[5] {
            Value::Null => None,
            v => Some(string(v, "settings")?.to_string()),
        };
        let a = fields(
            f[6],
            &["seq", "prune_at", "clock", "queue", "buckets"],
            "admission",
        )?;
        let queue = array(a[3], "admission.queue")?
            .iter()
            .map(|v| {
                let q = fields(v, &["seq", "since", "intent"], "admission.queue[]")?;
                Ok((
                    decimal(q[0], "admission.queue[].seq")?,
                    decimal(q[1], "admission.queue[].since")?,
                    read_intent(q[2])?,
                ))
            })
            .collect::<Result<_, String>>()?;
        let buckets = array(a[4], "admission.buckets")?
            .iter()
            .map(|v| {
                let b = fields(v, &["agent", "tokens", "last"], "admission.buckets[]")?;
                let bits = u64::from_be_bytes(hex::<8>(b[1], "admission.buckets[].tokens")?);
                Ok((
                    AgentId::new(string(b[0], "admission.buckets[].agent")?),
                    f64::from_bits(bits),
                    decimal(b[2], "admission.buckets[].last")?,
                ))
            })
            .collect::<Result<_, String>>()?;
        let admission = AdmissionState {
            seq: decimal(a[0], "admission.seq")?,
            prune_at: decimal(a[1], "admission.prune_at")?,
            clock: decimal(a[2], "admission.clock")?,
            queue,
            buckets,
        };
        let in_flight = array(f[7], "in_flight")?
            .iter()
            .map(|v| {
                let i = fields(v, &["intent", "since"], "in_flight[]")?;
                Ok(InFlight {
                    intent: read_intent(i[0])?,
                    since: decimal(i[1], "in_flight[].since")?,
                })
            })
            .collect::<Result<_, String>>()?;
        let claims = array(f[8], "claims")?
            .iter()
            .map(|v| {
                let r = fields(v, &["resource", "claims"], "claims[]")?;
                let list = array(r[1], "claims[].claims")?
                    .iter()
                    .map(|c| {
                        let what = "claims[].claims[]";
                        let c = fields(c, &["agent", "id", "action", "done_at"], what)?;
                        Ok(Claim {
                            key: read_key(c[0], c[1], what)?,
                            action: read_action(c[2], &format!("{what}.action"))?,
                            done_at: match c[3] {
                                Value::Null => None,
                                v => Some(decimal(v, &format!("{what}.done_at"))?),
                            },
                        })
                    })
                    .collect::<Result<_, String>>()?;
                Ok((string(r[0], "claims[].resource")?.to_string(), list))
            })
            .collect::<Result<_, String>>()?;
        let h = fields(f[9], &["next", "held"], "hold")?;
        let held = array(h[1], "hold.held")?
            .iter()
            .map(|v| {
                let e = fields(v, &["slot", "intent", "since", "reason"], "hold.held[]")?;
                Ok((
                    decimal(e[0], "hold.held[].slot")?,
                    Held {
                        intent: read_intent(e[1])?,
                        since: decimal(e[2], "hold.held[].since")?,
                        reason: string(e[3], "hold.held[].reason")?.to_string(),
                    },
                ))
            })
            .collect::<Result<_, String>>()?;
        let released = array(f[10], "released")?
            .iter()
            .map(|v| {
                let r = fields(v, &["agent", "id", "by"], "released[]")?;
                Ok((
                    read_key(r[0], r[1], "released[]")?,
                    string(r[2], "released[].by")?.to_string(),
                ))
            })
            .collect::<Result<_, String>>()?;
        let signed_ids = array(f[11], "signed_ids")?
            .iter()
            .map(|v| {
                let k = fields(v, &["agent", "id"], "signed_ids[]")?;
                let key = read_key(k[0], k[1], "signed_ids[]")?;
                Ok((key.agent, key.id))
            })
            .collect::<Result<_, String>>()?;
        let snapshot = Snapshot {
            checkpoint,
            ledger_clock: decimal(f[3], "ledger_clock")?,
            clock: decimal(f[4], "clock")?,
            settings,
            admission,
            in_flight,
            claims,
            held,
            hold_next: decimal(h[0], "hold.next")?,
            released,
            signed_ids,
        };
        if snapshot.to_json() != text {
            return Err(
                "the snapshot is not written as floodwall writes it (spacing, key order, escapes, \
                 number forms or ordering)"
                    .into(),
            );
        }
        Ok(snapshot)
    }
}

/// SHA-256 over the snapshot domain and `body`, the text before the
/// digest.
fn body_digest(body: &str) -> Digest {
    let mut h = Sha256::new();
    h.update(&(SNAPSHOT_DOMAIN.len() as u64).to_le_bytes());
    h.update(SNAPSHOT_DOMAIN);
    h.update(body.as_bytes());
    Digest(h.finalize())
}

fn comma(s: &mut String, i: usize) {
    if i > 0 {
        s.push(',');
    }
}

/// `{"agent":...,"id":"..."`, left open for more fields.
fn key_fields(s: &mut String, key: &IntentKey) {
    s.push_str("{\"agent\":");
    json_str(s, key.agent.as_str());
    s.push_str(&format!(",\"id\":\"{}\"", key.id));
}

fn read_key(agent: &Value, id: &Value, what: &str) -> Result<IntentKey, String> {
    Ok(IntentKey::new(
        string(agent, &format!("{what}.agent"))?,
        decimal(id, &format!("{what}.id"))?,
    ))
}

fn array<'a>(value: &'a Value, what: &str) -> Result<&'a [Value], String> {
    match value {
        Value::Array(items) => Ok(items),
        other => Err(format!("{what} is {}, not an array", other.kind())),
    }
}

impl Floodwall {
    /// The plane's state now, at its ledger's latest checkpoint (see
    /// [`crate::snapshot`]), or `None` unless that checkpoint covers every
    /// record: cut one with [`Floodwall::checkpoint`] first.
    pub fn snapshot(&self) -> Option<Snapshot> {
        let checkpoint = self.ledger.checkpoints().last()?;
        if checkpoint.size != self.ledger.size() {
            return None;
        }
        let (held, hold_next) = self.hold.slots();
        let mut released: Vec<(IntentKey, String)> = self
            .released
            .iter()
            .map(|(key, by)| (key.clone(), by.clone()))
            .collect();
        released.sort();
        Some(Snapshot {
            checkpoint: checkpoint.clone(),
            ledger_clock: self.ledger.clock(),
            clock: self.clock,
            settings: self.settings_label.clone(),
            admission: self.admission.state(),
            in_flight: self.scheduler.in_flight().cloned().collect(),
            claims: self.scheduler.claims(),
            held,
            hold_next,
            released,
            signed_ids: self
                .signed_ids
                .iter()
                .map(|(agent, id)| (agent.clone(), *id))
                .collect(),
        })
    }

    /// Pick up where a plane left off from a [`Snapshot`] and the ledger
    /// after it: take up the snapshot's state on this plane, which must be
    /// newly built with the configuration the ledger started under, replay
    /// the records `tail` holds, and keep recording in `tail` from there,
    /// at tick `now`. See [`crate::snapshot`].
    ///
    /// `tail` must start at the snapshot's checkpoint: read it with
    /// [`Snapshot::read_tail`], or build it with [`Ledger::starting_at`].
    /// Set it up as the plane's ledger was ([`Ledger::with_checkpoints`],
    /// [`Ledger::with_signer`]). Its records are replayed and checked
    /// digest for digest exactly as [`Floodwall::resume_with`] replays a
    /// whole ledger: a call `tail` ends partway through is finished, and
    /// `settings` is asked for the settings each `reconfigured` record
    /// names, and first for the ones the snapshot names, if it names any.
    ///
    /// With a keyring, every intent the snapshot holds and every intent in
    /// `tail` must be signed by its agent (current or retired key), and
    /// pending intents are checked again when next ruled on, as after
    /// [`Floodwall::resume`]. The resumed plane's stats start afresh.
    ///
    /// Afterwards [`Ledger::records`] holds only the records after the
    /// checkpoint; the ledger appends, cuts checkpoints and proves
    /// inclusion from there as the whole ledger would (see
    /// [Starting at a checkpoint](crate::ledger#starting-at-a-checkpoint)).
    ///
    /// Fails with [`ResumeError::NotFresh`] if this plane has queued or
    /// recorded anything; [`ResumeError::Snapshot`] if `tail` does not start
    /// at the snapshot's checkpoint, the settings it names are not given,
    /// or the plane cannot hold its state (a smaller queue, say);
    /// [`ResumeError::Unverified`] if `tail` does not verify;
    /// [`ResumeError::Unauthenticated`] if an intent in `tail` is not its
    /// agent's; and [`ResumeError::Unreplayable`] or
    /// [`ResumeError::Diverged`] at the first record the replay cannot
    /// reproduce.
    ///
    /// # Panics
    ///
    /// Panics if finishing a call needs to write to a ledger on disk and the
    /// write fails (see [Durability](Floodwall#durability)).
    ///
    /// [`Ledger::with_checkpoints`]: crate::Ledger::with_checkpoints
    /// [`Ledger::with_signer`]: crate::Ledger::with_signer
    pub fn resume_from_snapshot(
        mut self,
        snapshot: &Snapshot,
        tail: Ledger,
        now: u64,
        mut settings: impl FnMut(&str) -> Option<Settings>,
    ) -> Result<Floodwall, ResumeError> {
        self.check_fresh()?;
        let same = |c: &Checkpoint| {
            let s = &snapshot.checkpoint;
            (c.size, c.head, c.root, &c.frontier) == (s.size, s.head, s.root, &s.frontier)
        };
        if !tail.start().is_some_and(same) {
            return Err(ResumeError::Snapshot(
                "the ledger does not start at the snapshot's checkpoint".into(),
            ));
        }
        if !tail.verify() {
            return Err(ResumeError::Unverified);
        }
        if let Some(keyring) = &self.keyring {
            authenticate(tail.records(), keyring)?;
            for intent in snapshot_intents(snapshot) {
                let signed = intent.signature.is_some_and(|sig| {
                    let digest = intent.digest();
                    keyring
                        .audit_keys(&intent.agent)
                        .any(|key| key.verify(digest.as_bytes(), &sig))
                });
                if !signed {
                    return Err(ResumeError::Snapshot(format!(
                        "{} is not signed by its agent",
                        intent.key()
                    )));
                }
            }
        }
        if let Some(label) = &snapshot.settings {
            let new = settings(label).ok_or_else(|| {
                ResumeError::Snapshot(format!("no settings were given for {label:?}"))
            })?;
            new.rate_limit
                .validate()
                .map_err(|e| ResumeError::Snapshot(format!("the settings for {label:?}: {e}")))?;
            self.apply_settings(new);
            self.settings_label = Some(label.clone());
        }
        self.take_up(snapshot).map_err(ResumeError::Snapshot)?;
        self.ledger = Ledger::starting_at(snapshot.checkpoint.clone(), snapshot.ledger_clock)
            .map_err(ResumeError::Snapshot)?;
        self.catch_up(tail, now, settings)
    }

    /// Take up the state `snapshot` holds on this newly built plane.
    fn take_up(&mut self, snapshot: &Snapshot) -> Result<(), String> {
        if snapshot.ledger_clock > snapshot.clock {
            return Err("the ledger's clock is ahead of the plane's".into());
        }
        self.admission.restore(&snapshot.admission)?;
        self.scheduler
            .restore(&snapshot.in_flight, &snapshot.claims)?;
        self.hold.restore(&snapshot.held, snapshot.hold_next)?;
        let mut live = HashSet::new();
        for intent in snapshot_intents(snapshot) {
            let key = intent.key();
            if !live.insert(key.clone()) {
                return Err(format!("{key} is live twice"));
            }
        }
        let queued: HashSet<IntentKey> = snapshot
            .admission
            .queue
            .iter()
            .map(|(_, _, i)| i.key())
            .collect();
        for (key, by) in &snapshot.released {
            if !queued.contains(key) || self.released.insert(key.clone(), by.clone()).is_some() {
                return Err(format!("{key} is released but not queued"));
            }
        }
        for (agent, id) in &snapshot.signed_ids {
            if self.signed_ids.insert(agent.clone(), *id).is_some() {
                return Err(format!("{agent} has two marks"));
            }
        }
        self.live = live;
        self.clock = snapshot.clock;
        Ok(())
    }
}

/// Every intent a snapshot holds: queued, in flight or held.
fn snapshot_intents(snapshot: &Snapshot) -> impl Iterator<Item = &Intent> {
    snapshot
        .admission
        .queue
        .iter()
        .map(|(_, _, i)| i)
        .chain(snapshot.in_flight.iter().map(|f| &f.intent))
        .chain(snapshot.held.iter().map(|(_, h)| &h.intent))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::{Action, BlastRadius, Priority};
    use crate::policy::ResourceAllowlist;
    use crate::{
        Admission, Gate, HoldConfig, Keyring, Outcome, RateLimit, SchedulerConfig, SigningKey,
    };

    fn key(agent: &str) -> SigningKey {
        SigningKey::from_seed(&crate::sha256::sha256(agent.as_bytes()))
    }

    fn plane() -> Floodwall {
        Floodwall::new(
            Admission::new(8, RateLimit::new(3.0, 0.5)),
            Gate::new().with(ResourceAllowlist::new(["web", "api", "db"])),
        )
        .with_scheduler(SchedulerConfig::default().with_conflict_window(5))
        .with_hold(HoldConfig::default().with_ttl(Some(20)))
        .with_keyring(
            Keyring::new()
                .with("a", key("a").verifying_key())
                .with("b", key("b").verifying_key()),
        )
    }

    fn ledger() -> Ledger {
        Ledger::new().with_checkpoints(3).with_signer(key("plane"))
    }

    fn scale(agent: &str, id: u64, resource: &str, replicas: u32) -> Intent {
        Intent::new(
            id,
            AgentId::new(agent),
            Action::Scale {
                resource: resource.into(),
                replicas,
            },
            Priority::Normal,
            BlastRadius::Service,
        )
        .signed(&key(agent))
    }

    /// A plane with something queued, in flight, held, released and
    /// completed, at a checkpoint.
    fn busy() -> Floodwall {
        let mut p = plane().with_ledger(ledger());
        p.submit(scale("a", 1, "web", 2), 0).unwrap();
        p.submit(scale("b", 1, "cache", 1), 0).unwrap(); // held: off the list
        p.submit(scale("b", 2, "web", 5), 0).unwrap(); // contradicts a#1
        p.tick(1);
        p.complete(&IntentKey::new("a", 1), Outcome::Succeeded, 2)
            .unwrap();
        p.release(&IntentKey::new("b", 1), "alice", 3).unwrap();
        p.submit(scale("a", 2, "db", 1), 3).unwrap();
        p.checkpoint();
        p
    }

    #[test]
    fn a_snapshot_is_taken_only_at_a_checkpoint_covering_everything() {
        let mut p = plane().with_ledger(Ledger::new());
        assert!(p.snapshot().is_none(), "no checkpoint yet");
        p.submit(scale("a", 1, "web", 2), 0).unwrap();
        p.checkpoint();
        assert!(p.snapshot().is_some());
        p.tick(0);
        assert!(p.snapshot().is_none(), "records after the checkpoint");
    }

    #[test]
    fn the_text_form_reads_back_exactly() {
        let p = busy();
        let snapshot = p.snapshot().unwrap();
        assert!(!snapshot.held.is_empty() || !snapshot.released.is_empty());
        assert!(!snapshot.claims.is_empty() && !snapshot.admission.queue.is_empty());
        let text = snapshot.to_json();
        assert!(!text.contains('\n'));
        assert_eq!(Snapshot::from_json(&text).unwrap(), snapshot);

        // Any change is refused: as damage, or as not floodwall's writing.
        let damaged = text.replacen("\"alice\"", "\"mallory\"", 1);
        assert_ne!(damaged, text);
        assert_eq!(
            Snapshot::from_json(&damaged).unwrap_err(),
            "the snapshot does not match its digest"
        );
        let respaced = text.replacen("\"version\":1", "\"version\": 1", 1);
        assert!(Snapshot::from_json(&respaced).is_err());
        let newer = text.replacen("\"version\":1", "\"version\":2", 1);
        assert!(Snapshot::from_json(&newer)
            .unwrap_err()
            .contains("unsupported snapshot version"));
        assert!(Snapshot::from_json("{}").is_err());
        assert!(Snapshot::from_json(&text[..text.len() - 1]).is_err());
    }

    /// The tail lines after `snapshot`, as the plane wrote them.
    fn tail(p: &Floodwall, snapshot: &Snapshot) -> Vec<u8> {
        let mut out = Vec::new();
        p.ledger()
            .export_jsonl_from(snapshot.checkpoint(), &mut out)
            .unwrap();
        out
    }

    fn resumed(p: &Floodwall, snapshot: &Snapshot, now: u64) -> Floodwall {
        let tail = snapshot.read_tail(&tail(p, snapshot)).unwrap();
        let tail = tail.with_checkpoints(3).with_signer(key("plane"));
        plane()
            .resume_from_snapshot(snapshot, tail, now, |_| None)
            .unwrap()
    }

    fn state(p: &Floodwall) -> String {
        format!(
            "{:?} {:?} {:?} {}",
            p.queued().collect::<Vec<_>>(),
            p.in_flight().collect::<Vec<_>>(),
            p.held().collect::<Vec<_>>(),
            p.clock()
        )
    }

    #[test]
    fn resuming_from_a_snapshot_carries_on_like_the_whole_ledger() {
        let mut p = busy();
        let snapshot = Snapshot::from_json(&p.snapshot().unwrap().to_json()).unwrap();
        p.tick(4);
        p.submit(scale("b", 3, "api", 1), 5).unwrap();
        let now = p.clock();

        let mut q = resumed(&p, &snapshot, now);
        assert_eq!(q.ledger().head(), p.ledger().head());
        assert_eq!(q.ledger().size(), p.ledger().size());
        let after = p.ledger().records_after(&snapshot.checkpoint).unwrap();
        assert_eq!(q.ledger().len(), after.len());
        assert!(q.ledger().verify());
        assert_eq!(state(&q), state(&p));

        // Both carry on the same way: decisions, records, checkpoints.
        for plane in [&mut p, &mut q] {
            plane.tick(9);
            let _ = plane.complete(&IntentKey::new("b", 1), Outcome::Succeeded, 10);
            plane.submit(scale("a", 3, "web", 1), 11).unwrap();
            plane.tick(11);
            plane.checkpoint();
        }
        assert_eq!(q.ledger().head(), p.ledger().head());
        assert_eq!(
            q.ledger().checkpoints().last(),
            p.ledger().checkpoints().last()
        );
        assert!(q.ledger().verify());
        let plane_key = key("plane").verifying_key();
        assert_eq!(
            q.ledger().verify_checkpoint_signatures(&plane_key),
            Ok(q.ledger().checkpoints().len())
        );
        // Inclusion proofs for records after the snapshot, none before.
        let size = q.ledger().size();
        for seq in snapshot.checkpoint.size..size {
            assert_eq!(
                q.ledger().prove_inclusion(seq, size),
                p.ledger().prove_inclusion(seq, size)
            );
        }
        assert_eq!(q.ledger().prove_inclusion(0, size), None);
        // Its export is the whole ledger's suffix export.
        let (mut mine, mut theirs) = (Vec::new(), Vec::new());
        q.ledger().export_jsonl(&mut mine).unwrap();
        p.ledger()
            .export_jsonl_from(&snapshot.checkpoint, &mut theirs)
            .unwrap();
        assert_eq!(mine, theirs);
        assert_eq!(state(&q), state(&p));
    }

    #[test]
    fn a_tail_that_does_not_chain_from_the_snapshot_is_refused() {
        let mut p = busy();
        let snapshot = p.snapshot().unwrap();
        p.tick(4);
        // From another checkpoint.
        let mut other = busy();
        other.tick(4);
        other.checkpoint();
        let elsewhere = other.snapshot().unwrap();
        let wrong = Ledger::starting_at(elsewhere.checkpoint.clone(), 0).unwrap();
        assert!(matches!(
            plane().resume_from_snapshot(&snapshot, wrong, 4, |_| None),
            Err(ResumeError::Snapshot(_))
        ));
        // A whole ledger.
        assert!(matches!(
            plane().resume_from_snapshot(&snapshot, Ledger::new(), 4, |_| None),
            Err(ResumeError::Snapshot(_))
        ));
        // Lines that do not link to the checkpoint's head: another
        // checkpoint's, or the tail with its first record left out.
        assert!(snapshot.read_tail(&tail(&other, &elsewhere)).is_err());
        let records = p.ledger().records_after(&snapshot.checkpoint).unwrap();
        assert!(records.len() >= 2);
        let mut skipped = String::new();
        for r in &records[1..] {
            skipped.push_str(&crate::export::record_line(r));
            skipped.push('\n');
        }
        assert!(snapshot.read_tail(skipped.as_bytes()).is_err());
        // A tail the plane would not have written diverges.
        let mut forged = Ledger::starting_at(snapshot.checkpoint.clone(), 0).unwrap();
        forged.advance_clock(4);
        forged.append_intent(&scale("a", 9, "web", 1), "admit", None, Vec::new());
        assert!(matches!(
            plane().resume_from_snapshot(&snapshot, forged, 4, |_| None),
            Err(ResumeError::Diverged { .. })
        ));
        // A tail cannot be resumed as if it were a whole ledger.
        let tail_ledger = snapshot.read_tail(&tail(&p, &snapshot)).unwrap();
        assert_eq!(
            plane().resume(tail_ledger, 4).err(),
            Some(ResumeError::NotFromGenesis)
        );
    }

    #[test]
    fn a_snapshot_names_its_settings_and_they_are_asked_for() {
        let settings = || Settings {
            gate: Gate::new(),
            rate_limit: RateLimit::new(9.0, 2.0),
            scheduler: SchedulerConfig::default(),
            hold: HoldConfig::default(),
        };
        let mut p = plane().with_settings_label("v1").with_ledger(Ledger::new());
        assert_eq!(p.settings_label(), Some("v1"));
        p.submit(scale("a", 1, "cache", 1), 0).unwrap();
        p.reconfigure(settings(), "v2", 1).unwrap();
        p.checkpoint();
        let snapshot = p.snapshot().unwrap();
        assert_eq!(snapshot.settings_label(), Some("v2"));
        p.tick(2); // admitted under v2's gate, which allows any resource
        let lines = tail(&p, &snapshot);
        let refused =
            plane()
                .resume_from_snapshot(&snapshot, snapshot.read_tail(&lines).unwrap(), 2, |_| None);
        assert!(matches!(refused, Err(ResumeError::Snapshot(_))));
        let q = plane()
            .resume_from_snapshot(&snapshot, snapshot.read_tail(&lines).unwrap(), 2, |l| {
                (l == "v2").then(settings)
            })
            .unwrap();
        assert_eq!(q.ledger().head(), p.ledger().head());
        assert_eq!(q.settings_label(), Some("v2"));
        assert_eq!(q.in_flight().count(), 1);
    }

    #[test]
    fn a_snapshot_must_fit_the_plane() {
        let p = busy();
        let snapshot = p.snapshot().unwrap();
        let tail = || snapshot.read_tail(b"").unwrap();
        // A queue too small for what was queued.
        let small = Floodwall::new(Admission::new(0, RateLimit::new(3.0, 0.5)), Gate::new());
        assert!(matches!(
            small.resume_from_snapshot(&snapshot, tail(), 4, |_| None),
            Err(ResumeError::Snapshot(_))
        ));
        // Another keyring: the intents it holds are not its agents'.
        let strangers = plane().with_keyring(
            Keyring::new()
                .with("a", key("x").verifying_key())
                .with("b", key("y").verifying_key()),
        );
        assert!(matches!(
            strangers.resume_from_snapshot(&snapshot, tail(), 4, |_| None),
            Err(ResumeError::Snapshot(_))
        ));
        // A plane that has done something already.
        let mut used = plane();
        used.submit(scale("a", 1, "web", 1), 0).unwrap();
        assert_eq!(
            used.resume_from_snapshot(&snapshot, tail(), 4, |_| None)
                .err(),
            Some(ResumeError::NotFresh)
        );
        // The same plane, built right, takes it.
        let q = plane()
            .resume_from_snapshot(&snapshot, tail(), 4, |_| None)
            .unwrap();
        assert_eq!(q.clock(), 4);
        let (mine, theirs) = (state(&q), state(&p));
        assert!(mine.ends_with(" 4") && theirs.ends_with(" 3"));
        assert_eq!(mine[..mine.len() - 1], theirs[..theirs.len() - 1]);
    }
}
