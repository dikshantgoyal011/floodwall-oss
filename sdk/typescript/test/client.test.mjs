import assert from "node:assert/strict";
import test from "node:test";
import { Floodwall, FloodwallError, NotAdmitted, intentBytes } from "../src/index.js";

/** A stand-in plane: answers each request from `handler`, and keeps the calls. */
function stub(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url: new URL(url), method: init.method, headers: init.headers, redirect: init.redirect, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const [status, body, headers] = await handler(call);
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  };
  return { calls, fetch };
}

const client = (fetch, extra = {}) => new Floodwall({ apiKey: "fw_test_x", plane: "p1", agent: "deployer", fetch, ...extra });

test("guard applies an admitted change and reports it succeeded", async () => {
  const s = stub(async (call) => {
    if (call.method === "POST" && call.url.pathname === "/v1/planes/p1/intents") {
      return [200, { key: { agent: "deployer", id: call.body.id }, verdict: "admit", reason: null, policies: [] }];
    }
    return [200, { ok: true }];
  });
  const result = await client(s.fetch).guard({ action: { kind: "scale", resource: "web", replicas: 3 } }, () => "applied");
  assert.equal(result, "applied");
  assert.equal(s.calls[0].headers.Authorization, "Bearer fw_test_x");
  assert.deepEqual(Object.keys(s.calls[0].body), ["id", "agent", "action", "priority", "blast_radius", "signature"]);
  assert.match(s.calls[1].url.pathname, /\/intents\/deployer\/\d+\/outcome$/);
  assert.deepEqual(s.calls[1].body, { outcome: "succeeded", reason: null });
});

test("guard waits out a hold, then applies once released", async () => {
  let polls = 0;
  const s = stub(async (call) => {
    if (call.method === "POST" && call.url.pathname.endsWith("/intents")) return [200, { verdict: "defer", reason: "off the allowlist" }];
    if (call.method === "GET") return [200, { status: ++polls < 2 ? "held" : "in_flight" }];
    return [200, {}];
  });
  let applied = false;
  await client(s.fetch).guard({ action: { kind: "destroy", resource: "db" } }, () => (applied = true));
  assert.ok(applied);
  assert.equal(polls, 2);
  assert.equal(s.calls.at(-1).body.outcome, "succeeded");
});

test("a rejected change is never applied", async () => {
  const s = stub(async () => [200, { verdict: "reject", reason: "no destroys" }]);
  await assert.rejects(
    client(s.fetch).guard({ action: { kind: "destroy", resource: "db" } }, () => assert.fail("applied")),
    (e) => e instanceof NotAdmitted && e.decision.reason === "no destroys",
  );
  assert.equal(s.calls.length, 1);
});

test("a failing change is reported failed and its error rethrown", async () => {
  const s = stub(async (call) => (call.method === "POST" && call.url.pathname.endsWith("/intents") ? [200, { verdict: "admit" }] : [200, {}]));
  await assert.rejects(client(s.fetch).guard({ action: { kind: "scale", resource: "web", replicas: 1 } }, () => {
    throw new Error("kubectl exploded");
  }), /kubectl exploded/);
  assert.deepEqual(s.calls.at(-1).body, { outcome: "failed", reason: "kubectl exploded" });
});

test("rate limits are waited out as the plane says", async () => {
  let tries = 0;
  const s = stub(async () => (++tries < 2 ? [429, { error: "slow down" }, { "Retry-After": "0" }] : [200, { verdict: "admit" }]));
  const d = await client(s.fetch).submit({ action: { kind: "scale", resource: "web", replicas: 1 } });
  assert.equal(d.status, "admit");
  assert.equal(tries, 2);
});

test("unreachable: closed refuses, open applies and says so", async () => {
  const down = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(client(down).guard({ action: { kind: "scale", resource: "web", replicas: 1 } }, () => assert.fail()), /fetch failed/);
  const unchecked = [];
  const result = await client(down, { whenUnreachable: "open", onFailOpen: (c) => unchecked.push(c) }).guard(
    { action: { kind: "scale", resource: "web", replicas: 1 } },
    () => "ran",
  );
  assert.equal(result, "ran");
  assert.equal(unchecked.length, 1);
  // A refusal from the plane is not "unreachable", even when open.
  const s = stub(async () => [401, { error: "bad key" }]);
  await assert.rejects(
    client(s.fetch, { whenUnreachable: "open" }).guard({ action: { kind: "scale", resource: "web", replicas: 1 } }, () => assert.fail()),
    (e) => e instanceof FloodwallError && e.status === 401,
  );
});

test("ids increase even within one millisecond", () => {
  const c = client(async () => {});
  const a = c.nextId(), b = c.nextId();
  assert.ok(b > a);
});

test("the signed bytes match the crate's encoding", () => {
  // The crate's digest input for a scale (src/intent.rs, Intent::digest).
  const bytes = intentBytes({ id: "7", agent: "a", action: { kind: "scale", resource: "w", replicas: 2 }, priority: "urgent", blast_radius: "region", signature: null });
  const hex = Buffer.from(bytes).toString("hex");
  const field = (s) => Buffer.from(new BigUint64Array([BigInt(s.length)]).buffer).toString("hex") + Buffer.from(s).toString("hex");
  const expected =
    field("floodwall/intent/v1") + field("a") + "0700000000000000" + "01" + field("w") + "02000000" + "02" + "02";
  assert.equal(hex, expected);
});

const SCALE = { action: { kind: "scale", resource: "web", replicas: 1 } };
const isIntents = (call) => call.method === "POST" && call.url.pathname.endsWith("/intents");

test("fail-open covers only transport failures and 5xx, never the caller's own errors", async () => {
  const seen = [];
  const calls = [];
  const down = async () => {
    calls.push(1);
    throw new TypeError("fetch failed");
  };
  const open = (fetch) => client(fetch, { whenUnreachable: "open", onFailOpen: (i) => seen.push(i) });
  // Validation errors throw, without a request and without applying.
  await assert.rejects(open(down).guard({ ...SCALE, priority: "nope" }, () => assert.fail("applied")), /priority must be/);
  await assert.rejects(open(down).guard({ action: { kind: "scale", resource: "web", replicas: -1 } }, () => assert.fail("applied")), /replicas/);
  // A signing error throws too.
  const badKey = client(down, { whenUnreachable: "open", signingKey: new Uint8Array(5) });
  await assert.rejects(badKey.guard(SCALE, () => assert.fail("applied")), /32 bytes/);
  assert.equal(calls.length, 0);
  assert.equal(seen.length, 0);
  // An unknown error from fetch is not "unreachable".
  const weird = async () => {
    throw new Error("boom");
  };
  await assert.rejects(open(weird).guard(SCALE, () => assert.fail("applied")), /boom/);
  // Timeouts and aborts and 5xx are.
  for (const name of ["AbortError", "TimeoutError"]) {
    const aborted = async () => {
      throw Object.assign(new Error("slow"), { name });
    };
    assert.equal(await open(aborted).guard(SCALE, () => "ran"), "ran");
  }
  const s = stub(async () => [503, { error: "down" }]);
  assert.equal(await open(s.fetch).guard(SCALE, () => "ran"), "ran");
  assert.equal(seen.length, 3);
});

test("the default fail-open log leaves the manifest out", async () => {
  const lines = [];
  const warn = console.warn;
  console.warn = (...a) => lines.push(a.join(" "));
  try {
    const down = async () => {
      throw new TypeError("fetch failed");
    };
    await client(down, { whenUnreachable: "open" }).guard({ action: { kind: "apply", resource: "web", manifest: "SECRET: hunter2" } }, () => 1);
  } finally {
    console.warn = warn;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /deployer/);
  assert.match(lines[0], /apply/);
  assert.match(lines[0], /web/);
  assert.doesNotMatch(lines[0], /hunter2/);
});

test("wait never polls faster than once a second", async () => {
  let polls = 0;
  const sleeps = [];
  const s = stub(async () => [200, { status: ++polls < 4 ? "held" : "in_flight" }]);
  const c = client(s.fetch, { sleep: async (ms) => sleeps.push(ms) });
  const status = await c.wait({ agent: "deployer", id: "1" });
  assert.equal(status.status, "in_flight");
  assert.equal(sleeps.length, 3);
  for (const ms of sleeps) assert.ok(ms > 900 && ms <= 1000, `slept ${ms}`);
});

test("a redirect is an error, and a 429's Retry-After is waited out for a minute at most", async () => {
  let tries = 0;
  const sleeps = [];
  const s = stub(async () => (++tries < 3 ? [429, { error: "slow" }, { "Retry-After": tries === 1 ? "3600" : "2" }] : [200, { verdict: "admit" }]));
  await client(s.fetch, { sleep: async (ms) => sleeps.push(ms) }).submit({ action: { kind: "scale", resource: "web", replicas: 3 } });
  assert.deepEqual(sleeps, [60_000, 2000]);
  assert.ok(s.calls.every((c) => c.redirect === "error"));
});

test("a failed report never masks the change's own error", async () => {
  const s = stub(async (call) => (isIntents(call) ? [200, { verdict: "admit" }] : [500, { error: "report down" }]));
  const err = new Error("kubectl exploded");
  await assert.rejects(client(s.fetch).guard(SCALE, () => { throw err; }), (e) => e === err && e.reportError?.status === 500);
});

test("a failed report after success returns the result and tells onReportError", async () => {
  const s = stub(async (call) => (isIntents(call) ? [200, { verdict: "admit" }] : [500, { error: "report down" }]));
  const told = [];
  const result = await client(s.fetch, { onReportError: (e, key) => told.push([e, key]) }).guard(SCALE, () => "applied");
  assert.equal(result, "applied");
  assert.equal(told.length, 1);
  assert.equal(told[0][0].status, 500);
  assert.equal(told[0][1].agent, "deployer");
  // The default warns, without the manifest.
  const lines = [];
  const warn = console.warn;
  console.warn = (...a) => lines.push(a.join(" "));
  try {
    assert.equal(await client(s.fetch).guard({ action: { kind: "apply", resource: "web", manifest: "SECRET" } }, () => "ok"), "ok");
  } finally {
    console.warn = warn;
  }
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /SECRET/);
});

test("failure reasons are collapsed to single spaces and capped at 1024", async () => {
  const s = stub(async (call) => (isIntents(call) ? [200, { verdict: "admit" }] : [200, {}]));
  await assert.rejects(client(s.fetch).guard(SCALE, () => { throw new Error("a\n\n  b\tc " + "x".repeat(3000)); }));
  const reason = s.calls.at(-1).body.reason;
  assert.ok(reason.startsWith("a b c xxx"));
  assert.equal(reason.length, 1024);
});

test("baseUrl must be https unless local; the key stays out of logs", () => {
  const f = async () => {};
  for (const baseUrl of ["http://api.example.com", "ftp://x", "not a url"]) {
    assert.throws(() => client(f, { baseUrl }), TypeError);
  }
  for (const baseUrl of ["https://api.example.com/", "http://localhost:8787", "http://127.0.0.1:1", "http://[::1]:3"]) client(f, { baseUrl });
  const c = client(f);
  assert.ok(!JSON.stringify(c).includes("fw_test_x"));
  assert.ok(!Object.keys(c).includes("apiKey"));
  assert.equal(c.apiKey, "fw_test_x");
});

test("context goes in the POST body, never in the signed bytes or the intent", async () => {
  const s = stub(async () => [200, { verdict: "admit" }]);
  const c = client(s.fetch);
  const change = { action: { kind: "scale", resource: "web", replicas: 2 }, context: "- replicas: 1\n+ replicas: 2" };
  assert.ok(!("context" in c.intent(change)));
  await c.submit(change);
  assert.equal(s.calls[0].body.context, "- replicas: 1\n+ replicas: 2");
  const { context, ...intent } = s.calls[0].body;
  assert.deepEqual(intentBytes(intent), intentBytes({ ...intent, context: "other" }));
  await c.guard({ ...change, context: "plan" }, () => "ok");
  assert.equal(s.calls[1].body.context, "plan");
  assert.ok(!("context" in s.calls[2].body));
  await c.submit({ action: change.action });
  assert.ok(!("context" in s.calls.at(-1).body));
});

test("context over 64 KiB or not a string is refused before anything is sent", async () => {
  const s = stub(async () => [200, { verdict: "admit" }]);
  const c = client(s.fetch);
  const action = { kind: "scale", resource: "web", replicas: 2 };
  await assert.rejects(c.submit({ action, context: "x".repeat(65537) }), TypeError);
  await assert.rejects(c.guard({ action, context: "é".repeat(40000) }, () => assert.fail("applied")), TypeError);
  await assert.rejects(c.submit({ action, context: 5 }), TypeError);
  await c.submit({ action, context: "x".repeat(65536) });
  assert.equal(s.calls.length, 1);
});
