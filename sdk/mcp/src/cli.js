#!/usr/bin/env node
// floodwall-mcp [--http <port>] [--host <host>]
//
// Runs the Floodwall MCP server on stdio (the default) or streamable HTTP.
// Config comes from the environment; see the README.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, createClient } from "./config.js";
import { createServer } from "./server.js";
import { serveHttp } from "./http.js";

const USAGE = `usage: floodwall-mcp [--http <port>] [--host <host>]

  FLOODWALL_API_KEY  agent-scoped key (required)
  FLOODWALL_PLANE    plane id (required)
  FLOODWALL_URL      default https://api.floodwall.ai
  FLOODWALL_AGENT    agent name (default mcp-agent)
  FLOODWALL_MCP_TOKEN  with --http, require this bearer token
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--http") out.port = Number(argv[++i]);
    else if (arg === "--host") out.host = argv[++i];
    else if (arg === "-h" || arg === "--help") out.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if ("port" in out && !(Number.isInteger(out.port) && out.port >= 0 && out.port < 65536)) throw new Error("--http needs a port number");
  return out;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const fw = createClient(configFromEnv(process.env));
  if (args.port === undefined) {
    // stdio: stdout carries the protocol, so everything else goes to stderr.
    await createServer(fw).connect(new StdioServerTransport());
    console.error(`floodwall-mcp: serving plane ${fw.plane} as ${fw.agent} on stdio`);
  } else {
    const http = await serveHttp(() => createServer(fw), { port: args.port, host: args.host, token: process.env.FLOODWALL_MCP_TOKEN });
    const { address, port } = http.address();
    console.error(`floodwall-mcp: serving plane ${fw.plane} as ${fw.agent} at http://${address}:${port}/mcp`);
  }
} catch (error) {
  console.error(`floodwall-mcp: ${error?.message ?? error}\n\n${USAGE}`);
  process.exit(1);
}
