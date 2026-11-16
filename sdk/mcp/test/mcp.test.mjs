import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Floodwall } from "@floodwall/client";
import { createServer, serveHttp } from "../src/index.js";
import { startPlane } from "./fake-plane.mjs";

const clientFor = (plane, extra = {}) =>
  new Floodwall({ apiKey: plane.apiKey, plane: "p1", agent: "mcp-test", baseUrl: plane.url, sleep: async () => {}, ...extra });

/** An MCP client connected in-process to a server for `fw`. */
async function connect(fw) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(fw).connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return client;
}

const call = async (client, name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return { isError: !!result.isError, text: result.content[0].text, json: () => JSON.parse(result.content[0].text) };
};

test("lists the four tools, telling the model to submit first and stop unless admitted", async () => {
  const plane = await startPlane();
  try {
    const client = await connect(clientFor(plane));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["list_held", "report_outcome", "submit_intent", "wait_verdict"]);
    const submit = tools.find((t) => t.name === "submit_intent");
    assert.match(submit.description, /BEFORE/);
    assert.match(submit.description, /STOP/);
    assert.match(submit.description, /admit/);
  } finally {
    await plane.close();
  }
});

test("an admitted intent says proceed, and the outcome is reported", async () => {
  const plane = await startPlane();
  try {
    const client = await connect(clientFor(plane));
    const out = await call(client, "submit_intent", { kind: "scale", resource: "ok-web", replicas: 4, context: "- 1\n+ 4" });
    assert.equal(out.isError, false);
    assert.equal(out.json().proceed, true);
    assert.equal(out.json().status, "admit");
    assert.equal(plane.submitted[0].action.replicas, 4);
    assert.equal(plane.submitted[0].context, "- 1\n+ 4");
    assert.equal(plane.submitted[0].blast_radius, "service");
    const report = await call(client, "report_outcome", { key: out.json().key, outcome: "succeeded" });
    assert.equal(report.isError, false);
    assert.equal(plane.outcomes[0].key, out.json().key);
    assert.equal(plane.outcomes[0].outcome, "succeeded");
  } finally {
    await plane.close();
  }
});

test("held and rejected intents say stop; held can be waited for and released", async () => {
  const plane = await startPlane();
  try {
    const client = await connect(clientFor(plane));
    const held = (await call(client, "submit_intent", { kind: "destroy", resource: "held-db" })).json();
    assert.equal(held.status, "held");
    assert.equal(held.proceed, false);
    assert.match(held.next, /Do NOT/);
    const still = (await call(client, "wait_verdict", { key: held.key, wait: 0 })).json();
    assert.equal(still.proceed, false);
    plane.release(held.key);
    const released = (await call(client, "wait_verdict", { key: held.key, wait: 5 })).json();
    assert.equal(released.proceed, true);

    const bad = (await call(client, "submit_intent", { kind: "destroy", resource: "bad-db" })).json();
    assert.equal(bad.status, "rejected");
    assert.equal(bad.proceed, false);
    assert.match(bad.reason, /policy says reject/);

    const queued = (await call(client, "submit_intent", { kind: "apply", resource: "queued-api", manifest: "img:v2" })).json();
    assert.equal(queued.status, "queued");
    assert.equal(queued.proceed, false);
    assert.match(queued.next, /wait_verdict/);
  } finally {
    await plane.close();
  }
});

test("an unreachable plane or a server error comes back as an error telling the model not to act", async () => {
  const plane = await startPlane();
  const fw = clientFor(plane);
  const boom = await call(await connect(fw), "submit_intent", { kind: "apply", resource: "boom-x" });
  assert.equal(boom.isError, true);
  assert.match(boom.text, /Do NOT make the change/);
  await plane.close();
  const down = await call(await connect(fw), "submit_intent", { kind: "apply", resource: "ok-x" });
  assert.equal(down.isError, true);
  assert.match(down.text, /NOT admitted/);
});

test("invalid arguments (scale without replicas, oversized context) are errors, not submissions", async () => {
  const plane = await startPlane();
  try {
    const client = await connect(clientFor(plane));
    const noReplicas = await call(client, "submit_intent", { kind: "scale", resource: "ok-web" });
    assert.equal(noReplicas.isError, true);
    const big = await call(client, "submit_intent", { kind: "apply", resource: "ok-web", context: "x".repeat(70000) });
    assert.equal(big.isError, true);
    assert.equal(plane.submitted.length, 0);
  } finally {
    await plane.close();
  }
});

test("list_held lists held changes, and explains when the key is not an operator's", async () => {
  const plane = await startPlane();
  try {
    const client = await connect(clientFor(plane));
    const ok = (await call(client, "list_held")).json();
    assert.equal(ok.count, 1);
    assert.equal(ok.held[0].explanation, "Deletes the db.");
    plane.operatorOnly = true;
    const refused = await call(client, "list_held");
    assert.equal(refused.isError, true);
    assert.match(refused.text, /operator key/);
  } finally {
    await plane.close();
  }
});

test("a wrong API key is refused", async () => {
  const plane = await startPlane();
  try {
    const client = await connect(clientFor(plane, { apiKey: "wrong" }));
    const out = await call(client, "submit_intent", { kind: "apply", resource: "ok-x" });
    assert.equal(out.isError, true);
    assert.match(out.text, /401/);
  } finally {
    await plane.close();
  }
});

test("streamable HTTP serves the same tools, and a bearer token gates it", async () => {
  const plane = await startPlane();
  const fw = clientFor(plane);
  const http = await serveHttp(() => createServer(fw), { port: 0, token: "secret" });
  const url = new URL(`http://127.0.0.1:${http.address().port}/mcp`);
  try {
    const denied = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(denied.status, 401);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer secret" } } }));
    const out = await call(client, "submit_intent", { kind: "apply", resource: "ok-http", manifest: "img" });
    assert.equal(out.json().proceed, true);
    assert.equal(plane.submitted.length, 1);
    await client.close();
  } finally {
    http.closeAllConnections?.();
    await new Promise((resolve) => http.close(resolve));
    await plane.close();
  }
});

/** A POST to the HTTP server with exact headers (fetch will not let a test set Host). */
function post(port, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("without a token, the HTTP server refuses rebinding Hosts and any Origin, and non-loopback binds", async () => {
  const plane = await startPlane();
  const fw = clientFor(plane);
  const http = await serveHttp(() => createServer(fw), { port: 0 });
  const port = http.address().port;
  try {
    assert.equal(await post(port, {}), 200);
    assert.equal(await post(port, { Host: `localhost:${port}` }), 200);
    assert.equal(await post(port, { Host: `rebind.attacker.example:${port}` }), 403);
    assert.equal(await post(port, { Origin: "https://evil.example" }), 403);
    assert.equal(await post(port, { Origin: `http://127.0.0.1:${port}` }), 403);
  } finally {
    http.closeAllConnections?.();
    await new Promise((resolve) => http.close(resolve));
    await plane.close();
  }
  await assert.rejects(serveHttp(() => createServer(fw), { port: 0, host: "0.0.0.0" }), /FLOODWALL_MCP_TOKEN/);
  const withToken = await serveHttp(() => createServer(fw), { port: 0, host: "127.0.0.1", token: "t" });
  withToken.closeAllConnections?.();
  await new Promise((resolve) => withToken.close(resolve));
});
