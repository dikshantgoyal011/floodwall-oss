// Settings from the environment, shared by the MCP server and the hooks.

import { readFileSync } from "node:fs";
import { Floodwall } from "@floodwall/client";

export const DEFAULT_URL = "https://api.floodwall.ai";

/**
 * Read the plane connection from `env`.
 *
 *   FLOODWALL_API_KEY   an agent-scoped key (required; FLOODWALL_KEY is accepted too)
 *   FLOODWALL_API_KEY_FILE  a file holding the key, instead of the variable (preferred for hooks:
 *                       the agent's own shell inherits the environment, not a 0600 file)
 *   FLOODWALL_PLANE     the plane's id (required)
 *   FLOODWALL_URL       default https://api.floodwall.ai
 *   FLOODWALL_AGENT     the agent name the plane's rules and ledger see (default `defaultAgent`)
 *   FLOODWALL_SIGNING_KEY       Ed25519 seed, 32 bytes as 64 hex characters or base64
 *   FLOODWALL_SIGNING_KEY_FILE  a file holding the same
 */
export function configFromEnv(env = process.env, { defaultAgent = "mcp-agent" } = {}) {
  let apiKey = env.FLOODWALL_API_KEY || env.FLOODWALL_KEY;
  if (!apiKey && env.FLOODWALL_API_KEY_FILE) apiKey = readFileSync(env.FLOODWALL_API_KEY_FILE, "utf8").trim();
  const plane = env.FLOODWALL_PLANE;
  const missing = [];
  if (!apiKey) missing.push("FLOODWALL_API_KEY (or FLOODWALL_API_KEY_FILE)");
  if (!plane) missing.push("FLOODWALL_PLANE");
  if (missing.length) throw new Error(`${missing.join(" and ")} must be set`);
  let seed = env.FLOODWALL_SIGNING_KEY;
  if (!seed && env.FLOODWALL_SIGNING_KEY_FILE) seed = readFileSync(env.FLOODWALL_SIGNING_KEY_FILE, "utf8");
  return {
    apiKey,
    plane,
    baseUrl: env.FLOODWALL_URL || DEFAULT_URL,
    agent: env.FLOODWALL_AGENT || defaultAgent,
    signingKey: seed ? parseSeed(seed.trim()) : undefined,
  };
}

/** A client for the configured plane. Failing closed is the client's default and is kept. */
export function createClient(config, extra = {}) {
  return new Floodwall({ ...config, ...extra });
}

function parseSeed(text) {
  const bytes = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  if (bytes.length !== 32) throw new Error("the signing key must be a 32-byte Ed25519 seed (64 hex characters or base64)");
  return new Uint8Array(bytes);
}
