// An example agent: rolls out a new image to a few services, asking the
// plane before each change and reporting how it went.
//
//   FLOODWALL_KEY=fw_test_... FLOODWALL_PLANE=<plane id> node sdk/examples/deploy-agent.mjs v42
//
// It only prints what it would run; swap `apply` for your real deploy.

import { Floodwall, NotAdmitted } from "../typescript/src/index.js";

const image = process.argv[2] ?? "v1";
const fw = new Floodwall({
  apiKey: process.env.FLOODWALL_KEY,
  plane: process.env.FLOODWALL_PLANE,
  agent: "deploy-agent",
  baseUrl: process.env.FLOODWALL_URL,
});

for (const service of ["web", "api", "billing"]) {
  const change = { action: { kind: "apply", resource: service, manifest: image }, priority: "normal", blastRadius: "service" };
  try {
    await fw.guard(change, async () => {
      console.log(`applying ${image} to ${service}`);
      // e.g. await exec(`kubectl set image deploy/${service} app=registry/app:${image}`)
    }, { timeoutSeconds: 120 });
    console.log(`${service}: done`);
  } catch (error) {
    if (error instanceof NotAdmitted) {
      console.log(`${service}: not admitted (${error.decision.status}${error.decision.reason ? `: ${error.decision.reason}` : ""})`);
    } else {
      throw error;
    }
  }
}
