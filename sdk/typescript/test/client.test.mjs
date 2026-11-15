import assert from "node:assert/strict";
import test from "node:test";
import { Floodwall, FloodwallError, NotAdmitted, intentBytes } from "../src/index.js";

/** A stand-in plane: answers each request from `handler`, and keeps the calls. */
function stub(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url: new URL(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
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
