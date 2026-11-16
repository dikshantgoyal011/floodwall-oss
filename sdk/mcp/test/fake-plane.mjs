// A small in-process stand-in for a Floodwall plane's /v1 intent API.
//
// The resource decides the answer: "ok-*" admitted, "held-*" held (until
// `release()`), "bad-*" rejected, "queued-*" queued then admitted, "boom-*" a 500.

import { createServer } from "node:http";

export async function startPlane({ apiKey = "fw_test_k" } = {}) {
  const plane = { submitted: [], outcomes: [], waits: 0, released: new Set(), intents: new Map() };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${apiKey}`) return send(401, { error: "bad key" });
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : undefined;
    const parts = url.pathname.split("/").filter(Boolean); // v1 planes p1 intents <agent> <id> outcome

    if (req.method === "POST" && parts[3] === "intents" && parts.length === 4) {
      plane.submitted.push(json);
      const resource = String(json.action.resource).split(/[/:]/).pop();
      const key = { agent: json.agent, id: json.id };
      plane.intents.set(`${key.agent}/${key.id}`, resource);
      if (resource.startsWith("boom")) return send(500, { error: "boom" });
      if (resource.startsWith("queued")) return send(202, { key, status: "queued" });
      const verdict = resource.startsWith("bad") ? "reject" : resource.startsWith("held") ? "defer" : "admit";
      return send(200, { key, verdict, reason: verdict === "admit" ? null : `policy says ${verdict}`, policies: verdict === "admit" ? [] : [{ policy: "allowlist", verdict, reason: `policy says ${verdict}` }] });
    }
    if (req.method === "GET" && parts[3] === "intents") {
      plane.waits++;
      const k = `${decodeURIComponent(parts[4])}/${decodeURIComponent(parts[5])}`;
      const resource = plane.intents.get(k) ?? "";
      const key = { agent: decodeURIComponent(parts[4]), id: parts[5] };
      if (resource.startsWith("held")) {
        return send(200, { key, status: plane.released.has(k) ? "in_flight" : "held", reason: "policy says defer", policies: [] });
      }
      return send(200, { key, status: resource.startsWith("queued") ? "in_flight" : "admit", policies: [] });
    }
    if (req.method === "POST" && parts[6] === "outcome") {
      plane.outcomes.push({ key: `${decodeURIComponent(parts[4])}/${parts[5]}`, ...json });
      return send(200, { status: "done" });
    }
    if (req.method === "GET" && parts[3] === "held") {
      if (plane.operatorOnly) return send(403, { error: "operator key required" });
      return send(200, { held: [{ key: { agent: "a", id: "1" }, intent: { action: { kind: "destroy", resource: "db" } }, since: 3, reason: "off allowlist", explanation: { text: "Deletes the db.", model: "m" } }] });
    }
    send(404, { error: "no such route" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  plane.url = `http://127.0.0.1:${server.address().port}`;
  plane.apiKey = apiKey;
  plane.release = (key) => plane.released.add(key);
  plane.close = () => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve)));
  return plane;
}
