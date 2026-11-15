// Scale a Kubernetes deployment, but only once the plane admits it.
//
//   FLOODWALL_KEY=fw_live_... FLOODWALL_PLANE=<plane id> \
//     node sdk/examples/kubernetes-scaler.mjs web 5 [--namespace prod] [--apply]
//
// Without --apply it prints the kubectl command instead of running it. Without
// FLOODWALL_KEY it prints the change it would ask the plane about, and stops.
// In your own project: npm install @floodwall/client, and import from it.

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { Floodwall, FloodwallError, NotAdmitted } from "../typescript/src/index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    namespace: { type: "string", default: "default" },
    apply: { type: "boolean", default: false },
  },
});
const [deployment, count] = positionals;
const replicas = Number(count);
if (!deployment || !Number.isInteger(replicas) || replicas < 0) {
  console.error("usage: kubernetes-scaler.mjs <deployment> <replicas> [--namespace ns] [--apply]");
  process.exit(2);
}

const command = ["kubectl", "--namespace", values.namespace, "scale", `deployment/${deployment}`, `--replicas=${replicas}`];

// The plane's rules see the resource, the replica count and how far a mistake
// would reach. A scale to zero is destructive: rules can hold or refuse it.
const change = {
  action: { kind: "scale", resource: deployment, replicas },
  priority: "normal",
  blastRadius: "service",
};

if (!process.env.FLOODWALL_KEY) {
  console.log("FLOODWALL_KEY is not set, so no plane is asked. The change would be:");
  console.log(JSON.stringify(change, null, 2));
  console.log(`and, once admitted: ${command.join(" ")}`);
  process.exit(0);
}

const fw = new Floodwall({
  apiKey: process.env.FLOODWALL_KEY,
  plane: process.env.FLOODWALL_PLANE,
  agent: process.env.FLOODWALL_AGENT ?? "k8s-scaler",
  baseUrl: process.env.FLOODWALL_URL,
});

try {
  // guard waits while the change is queued or held for a person, runs the
  // callback only if it is admitted, and reports how it went either way.
  await fw.guard(change, () => {
    if (!values.apply) {
      console.log(`admitted; would run: ${command.join(" ")}`);
      return;
    }
    console.log(`admitted; running: ${command.join(" ")}`);
    execFileSync(command[0], command.slice(1), { stdio: "inherit" });
  }, { timeoutSeconds: 120 });
  console.log(`${deployment}: scaled to ${replicas}`);
} catch (error) {
  if (error instanceof NotAdmitted) {
    // rejected, expired or lapsed; or still held when time ran out. A held
    // intent may be released later: don't scale without asking again.
    const { status, reason } = error.decision;
    console.error(`${deployment}: not admitted (${status}${reason ? `: ${reason}` : ""})`);
    process.exit(1);
  }
  if (error instanceof FloodwallError) {
    console.error(`the plane refused the request (${error.status}): ${error.message}`);
    process.exit(1);
  }
  throw error;
}
