// Streamable HTTP transport, stateless: a new server and transport per request.

import { createServer as createHttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Serve `makeServer()` at `POST /mcp`. Listens on 127.0.0.1 unless `host` says otherwise.
 * With `token`, requests must carry `Authorization: Bearer <token>`: the server acts with
 * ONE Floodwall key for everyone who reaches it. Without one, it refuses to listen beyond
 * loopback, refuses requests with an Origin header or a non-loopback Host (DNS rebinding),
 * and turns on the SDK transport's own rebinding protection.
 * Resolves to the `http.Server` once it is listening.
 */
export async function serveHttp(makeServer, { port, host = "127.0.0.1", token } = {}) {
  if (!token && !LOOPBACK.has(host)) {
    throw new Error(`refusing to listen on ${host} without FLOODWALL_MCP_TOKEN: this server acts with one Floodwall key for everyone who reaches it`);
  }
  let allowedHosts; // set once the port is known; only for the loopback, token-less case
  const http = createHttpServer(async (req, res) => {
    const send = (status, message) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
    };
    try {
      if (new URL(req.url, "http://x").pathname !== "/mcp") return send(404, "not found: the MCP endpoint is /mcp");
      if (token) {
        if (!sameToken(req.headers.authorization, token)) return send(401, "unauthorized");
      } else {
        // No token: only a local, non-browser client may call. A web page that rebinds a name to
        // 127.0.0.1 carries its own Host and an Origin; both are refused.
        if (req.headers.origin !== undefined) return send(403, "forbidden: requests with an Origin header are refused");
        if (!LOOPBACK.has(hostnameOf(req.headers.host))) return send(403, "forbidden: Host must be a loopback name");
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return send(405, "method not allowed: this server is stateless, use POST");
      }
      const server = makeServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        ...(allowedHosts ? { enableDnsRebindingProtection: true, allowedHosts } : {}),
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) send(500, `internal error: ${error?.message ?? error}`);
    }
  });
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, resolve);
  });
  if (!token) {
    const p = http.address().port;
    allowedHosts = [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`];
  }
  return http;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** The host name in a Host header, without its port. */
function hostnameOf(header) {
  const h = String(header ?? "");
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
}

function sameToken(header, token) {
  const given = Buffer.from(String(header ?? ""));
  const want = Buffer.from(`Bearer ${token}`);
  return given.length === want.length && timingSafeEqual(given, want);
}
