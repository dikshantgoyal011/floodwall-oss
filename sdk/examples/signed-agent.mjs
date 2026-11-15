// An agent that signs its intents, for a plane whose keyring requires it.
//
//   node sdk/examples/signed-agent.mjs                  # make a key; print the public key for the keyring
//   AGENT_SEED_HEX=<seed> FLOODWALL_KEY=fw_live_... FLOODWALL_PLANE=<plane id> \
//     node sdk/examples/signed-agent.mjs --submit       # sign and submit an intent with that key
//
// With a keyring, the plane refuses unsigned, unknown and forged intents
// before they reach the queue, and the ledger proves which agent asked for
// each change. The plane holds only public keys; the private key (here, its
// 32-byte seed) stays with the agent, in your secret store.
// In your own project: npm install @floodwall/client, and import from it.

import { Floodwall, NotAdmitted, intentDigest, sign } from "../typescript/src/index.js";

const AGENT = process.env.FLOODWALL_AGENT ?? "signed-agent";
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const subtle = globalThis.crypto.subtle;

// 1. The agent's key: from AGENT_SEED_HEX, or a new one.
let seed;
if (process.env.AGENT_SEED_HEX) {
  seed = Uint8Array.from(Buffer.from(process.env.AGENT_SEED_HEX, "hex"));
  if (seed.length !== 32) throw new Error("AGENT_SEED_HEX must be 32 bytes of hex");
} else {
  const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  // PKCS#8 for Ed25519 is a fixed 16-byte prefix and the 32-byte seed.
  seed = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey)).slice(16);
  console.log("a new key. Keep the seed secret (a secret store, never the repository):");
  console.log(`  AGENT_SEED_HEX=${hex(seed)}`);
}

// The public key, from the seed: import it, then read the public half back.
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const privateKey = await subtle.importKey("pkcs8", new Uint8Array([...PKCS8_PREFIX, ...seed]), { name: "Ed25519" }, true, ["sign"]);
const jwk = await subtle.exportKey("jwk", privateKey);
const publicKey = Buffer.from(jwk.x, "base64url");

// 2. What goes in the plane's keyring (console: the plane's keyring; API: PUT /v1/planes/{plane}/keyring).
console.log("\nthe plane's keyring:");
console.log(JSON.stringify({ keyring: { agents: { [AGENT]: hex(publicKey) } } }, null, 2));

// 3. A signed intent, and the check the plane makes on it.
const intent = {
  id: String(Date.now() * 1000),
  agent: AGENT,
  action: { kind: "scale", resource: "web", replicas: 3 },
  priority: "normal",
  blast_radius: "service",
  signature: null,
};
intent.signature = await sign(intent, seed);
const verifier = await subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
const valid = await subtle.verify({ name: "Ed25519" }, verifier, Buffer.from(intent.signature, "hex"), await intentDigest(intent));
console.log(`\na signed intent (signature ${valid ? "verifies" : "DOES NOT verify"} against the public key):`);
console.log(JSON.stringify(intent));

// 4. Submit through the client, which signs every intent with the key.
if (!process.argv.includes("--submit")) {
  console.log("\nadd the public key to the plane's keyring, then run again with AGENT_SEED_HEX and --submit.");
  process.exit(0);
}
if (!process.env.FLOODWALL_KEY || !process.env.AGENT_SEED_HEX) {
  console.error("--submit needs FLOODWALL_KEY, FLOODWALL_PLANE and the AGENT_SEED_HEX whose public key is in the keyring");
  process.exit(2);
}
const fw = new Floodwall({
  apiKey: process.env.FLOODWALL_KEY,
  plane: process.env.FLOODWALL_PLANE,
  agent: AGENT,
  baseUrl: process.env.FLOODWALL_URL,
  signingKey: seed,
});
try {
  await fw.guard({ action: { kind: "scale", resource: "web", replicas: 3 } }, () => {
    console.log("admitted; would run: kubectl scale deployment/web --replicas=3");
  });
} catch (error) {
  if (!(error instanceof NotAdmitted)) throw error; // a 401 here means the keyring doesn't hold this key
  console.error(`not admitted (${error.decision.status}: ${error.decision.reason ?? ""})`);
  process.exit(1);
}
