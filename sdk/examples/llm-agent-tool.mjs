// An AI agent's tools, governed: every change the model proposes through a
// tool call goes through guard() before it runs.
//
//   FLOODWALL_KEY=fw_live_... FLOODWALL_PLANE=<plane id> node sdk/examples/llm-agent-tool.mjs [--apply]
//
// No model provider here: wire `handleToolCall` into whatever loop runs your
// model (its tool-use or function-calling API). Each tool says how its call
// becomes a Floodwall change; the wrapper asks the plane, runs the tool only if
// it is admitted, and hands the model a plain answer either way, so a refusal
// is something the model can read and work around, never an exception that
// ends the conversation.
//
// This file plays the model's part with a few scripted tool calls. Without
// --apply the tools only print what they would run. Without FLOODWALL_KEY,
// nothing asks a plane: it prints the change each call would be.
// In your own project: npm install @floodwall/client, and import from it.

import { Floodwall, FloodwallError, NotAdmitted } from "../typescript/src/index.js";

const apply = process.argv.includes("--apply");

/**
 * The tools the model may call. `parameters` is the JSON Schema you hand the
 * model; `change` turns the model's arguments into the change the plane rules
 * on; `run` makes it happen.
 */
const TOOLS = {
  scale_deployment: {
    description: "Scale a Kubernetes deployment to a number of replicas.",
    parameters: {
      type: "object",
      properties: { deployment: { type: "string" }, replicas: { type: "integer", minimum: 0 } },
      required: ["deployment", "replicas"],
    },
    change: ({ deployment, replicas }) => ({ action: { kind: "scale", resource: deployment, replicas } }),
    run: ({ deployment, replicas }) => shell(`kubectl scale deployment/${deployment} --replicas=${replicas}`),
  },
  deploy_image: {
    description: "Roll a deployment out to a new container image.",
    parameters: {
      type: "object",
      properties: { deployment: { type: "string" }, image: { type: "string" } },
      required: ["deployment", "image"],
    },
    change: ({ deployment, image }) => ({ action: { kind: "apply", resource: deployment, manifest: image } }),
    run: ({ deployment, image }) => shell(`kubectl set image deployment/${deployment} app=${image}`),
  },
  delete_deployment: {
    description: "Delete a deployment.",
    parameters: { type: "object", properties: { deployment: { type: "string" } }, required: ["deployment"] },
    // Deleting is destructive: rules can hold or refuse it whatever the model says.
    change: ({ deployment }) => ({ action: { kind: "destroy", resource: deployment } }),
    run: ({ deployment }) => shell(`kubectl delete deployment/${deployment}`),
  },
};

async function shell(command) {
  if (!apply) return `would run: ${command}`;
  const { execSync } = await import("node:child_process");
  return execSync(command, { encoding: "utf8" });
}

const fw = process.env.FLOODWALL_KEY
  ? new Floodwall({
      apiKey: process.env.FLOODWALL_KEY,
      plane: process.env.FLOODWALL_PLANE,
      // One agent name for the model, so rules, rate limits and the ledger
      // know its changes apart from people's and other agents'.
      agent: process.env.FLOODWALL_AGENT ?? "llm-agent",
      baseUrl: process.env.FLOODWALL_URL,
    })
  : null;

/**
 * Run one tool call the model proposed, and return what the model should be
 * told: always a string, never a throw.
 */
async function handleToolCall({ name, arguments: args }) {
  const tool = TOOLS[name];
  if (!tool) return `error: there is no tool named ${name}`;
  const change = tool.change(args);
  if (!fw) return `not run: no plane configured; the change would be ${JSON.stringify(change)}`;
  try {
    // A short wait: a model shouldn't sit for minutes on a held change. The
    // intent stays held, and a person can still release it.
    const output = await fw.guard(change, () => tool.run(args), { timeoutSeconds: 30 });
    return `done: ${output}`;
  } catch (error) {
    if (error instanceof NotAdmitted) {
      const { status, reason, policies } = error.decision;
      const why = policies.filter((p) => p.verdict !== "admit").map((p) => `${p.policy}: ${p.reason}`);
      if (status === "held") {
        return `not run yet: the change is held for a person to approve (${reason}). Don't retry it; tell the user it is waiting for approval.`;
      }
      return `refused (${status}): ${why.join("; ") || reason}. Don't retry the same change.`;
    }
    if (error instanceof FloodwallError) return `not run: the change control service refused the request (${error.status})`;
    return `failed: ${error?.message ?? error}`;
  }
}

// The model's part, scripted: what a model might propose while "fixing" a slow site.
const proposed = [
  { name: "scale_deployment", arguments: { deployment: "web", replicas: 6 } },
  { name: "deploy_image", arguments: { deployment: "api", image: "registry.internal/api:v43" } },
  { name: "delete_deployment", arguments: { deployment: "orders-db" } },
];

console.log("tools offered to the model:", Object.keys(TOOLS).join(", "));
for (const call of proposed) {
  console.log(`\nmodel calls ${call.name}(${JSON.stringify(call.arguments)})`);
  console.log(`  -> ${await handleToolCall(call)}`);
}
