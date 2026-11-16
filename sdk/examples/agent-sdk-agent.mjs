// A Claude Agent SDK agent whose risky shell commands go through Floodwall.
//
//   npm install @anthropic-ai/claude-agent-sdk @floodwall/mcp@0.1.0
//   ANTHROPIC_API_KEY=... FLOODWALL_API_KEY=fw_live_... FLOODWALL_PLANE=pl_... node agent-sdk-agent.mjs
//
// Before each `kubectl apply|delete|scale`, `terraform apply|destroy` or
// `helm install|upgrade|uninstall` the hook asks the plane. Anything but
// "admit" denies the tool call, and the model is told why, so it stops and
// reports instead of working around the wall. PostToolUse reports the outcome.
// If the plane cannot be reached the command is blocked (FLOODWALL_FAIL_OPEN=1
// would let it run instead).

import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeAgentSdkHooks } from "@floodwall/mcp/agent-sdk";

if (!process.env.FLOODWALL_API_KEY || !process.env.FLOODWALL_PLANE) {
  console.error("set FLOODWALL_API_KEY and FLOODWALL_PLANE first");
  process.exit(1);
}

const prompt = process.argv[2] ?? "The web deployment is slow. Scale it to 6 replicas with kubectl.";

for await (const message of query({
  prompt,
  options: {
    hooks: claudeAgentSdkHooks({ waitSeconds: 60 }),
  },
})) {
  if (message.type === "result") console.log(message.result ?? message);
}
