// A CI step that asks the plane before deploying, and fails the job if the
// deploy isn't admitted. A later step reports how the deploy went.
//
//   node sdk/examples/ci-gate.mjs ask --resource api --manifest "$GITHUB_SHA" [--blast service] [--priority normal]
//   ...deploy...
//   node sdk/examples/ci-gate.mjs report --id <id> --outcome succeeded|failed [--reason "..."]
//
// `ask` waits while the deploy is queued or held for a person (--timeout,
// 600 s by default), then exits 0 if it is admitted and 1 if not. On GitHub
// Actions it writes the intent's id to $GITHUB_OUTPUT as `intent_id`, for the
// report step. Until that report, nothing else deploys to the resource.
//
// Env: FLOODWALL_KEY, FLOODWALL_PLANE, FLOODWALL_URL (optional) and
// FLOODWALL_AGENT (default "github-actions"). With --dry-run, or without
// FLOODWALL_KEY, `ask` prints the change and asks nothing: --dry-run exits 0,
// a missing key exits 1, so a CI job without its secret never deploys.
// In your own repository: npm install @floodwall/client, and import from it.

import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Floodwall, FloodwallError, NotAdmitted } from "../typescript/src/index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    resource: { type: "string" },
    manifest: { type: "string", default: process.env.GITHUB_SHA ?? "" },
    blast: { type: "string", default: "service" },
    priority: { type: "string", default: "normal" },
    timeout: { type: "string", default: "600" },
    id: { type: "string" },
    outcome: { type: "string" },
    reason: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const [command] = positionals;
const agent = process.env.FLOODWALL_AGENT ?? "github-actions";

function client() {
  return new Floodwall({
    apiKey: process.env.FLOODWALL_KEY,
    plane: process.env.FLOODWALL_PLANE,
    agent,
    baseUrl: process.env.FLOODWALL_URL,
  });
}

async function ask() {
  if (!values.resource) throw new Error("ask needs --resource");
  const change = {
    action: { kind: "apply", resource: values.resource, manifest: values.manifest },
    priority: values.priority,
    blastRadius: values.blast,
  };
  if (values["dry-run"] || !process.env.FLOODWALL_KEY) {
    console.log(`${values["dry-run"] ? "--dry-run" : "FLOODWALL_KEY is not set"}: not asking a plane. The change would be:`);
    console.log(JSON.stringify(change, null, 2));
    return values["dry-run"] ? 0 : 1;
  }

  const fw = client();
  // submit + wait rather than guard: the deploy runs in a later step, so this
  // step only asks, and the report step tells the plane how it went.
  const first = await fw.submit(change);
  console.log(`asked the plane about ${agent}/${first.key.id}: ${first.status}`);
  const decision =
    first.status === "queued" || first.status === "held"
      ? await fw.wait(first.key, { timeoutSeconds: Number(values.timeout) })
      : first;

  if (decision.status === "admit" || decision.status === "in_flight") {
    console.log(`admitted: deploy ${values.resource}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `intent_id=${first.key.id}\n`);
    return 0;
  }
  const why = decision.reason ? `: ${decision.reason}` : "";
  console.error(`not admitted (${decision.status}${why})`);
  if (decision.status === "held") console.error("still held for a person: re-run the job once someone releases it");
  for (const p of decision.policies) if (p.verdict !== "admit") console.error(`  ${p.policy}: ${p.verdict}: ${p.reason ?? ""}`);
  return 1;
}

async function report() {
  if (!values.id || !["succeeded", "failed"].includes(values.outcome)) {
    throw new Error("report needs --id and --outcome succeeded|failed");
  }
  await client().report({ agent, id: values.id }, values.outcome, values.reason);
  console.log(`reported ${agent}/${values.id}: ${values.outcome}`);
  return 0;
}

try {
  if (command === "ask") process.exitCode = await ask();
  else if (command === "report") process.exitCode = await report();
  else {
    console.error("usage: ci-gate.mjs ask --resource <name> [--manifest <sha>] | report --id <id> --outcome succeeded|failed");
    process.exitCode = 2;
  }
} catch (error) {
  if (error instanceof NotAdmitted || error instanceof FloodwallError) console.error(error.message);
  else console.error(error);
  process.exitCode = 1;
}
