# Quickstart: your first governed change

From sign-up to an agent asking a hosted plane before it changes anything,
in about ten minutes. (To run the crate yourself instead, see the README.)

## 1. Make a plane

Sign up at floodwall.ai and open the console. Create a plane: a name, and
optionally its first rules. A plane is one wall: its own queue, rules, rate
limits, hold queue and ledger. Free accounts get one.

## 2. Give it rules

On **Policies**, write rules in the [rules language](policies/README.md),
for example:

```text
format 1

policy "guardrails" {
  reject "destructive global change requires human sign-off"
    when blast_radius == global and destructive
  defer "'{resource}' needs a person to sign off"
    when resource not in ["web", "api"]
}
```

**Dry run** replays your recent intents through the new rules and shows
every verdict that would change. Save once it looks right.

## 3. Make a key

On **Keys**, create an `agent` key. Copy the secret now: it is shown once,
and Floodwall keeps only its hash. `operator` keys can also release and
expire held changes and change settings; give those to people's tools, not
to agents.

## 4. Ask before changing

TypeScript (`npm install @floodwall/client`, source in `sdk/typescript`):

```js
import { Floodwall } from "@floodwall/client";

const fw = new Floodwall({ apiKey: process.env.FLOODWALL_KEY, plane: "<plane id>", agent: "deployer" });

await fw.guard(
  { action: { kind: "scale", resource: "web", replicas: 5 } },
  () => scaleWeb(5),
);
```

Python (`pip install floodwall`, source in `sdk/python`):

```python
from floodwall import Floodwall

fw = Floodwall(api_key=os.environ["FLOODWALL_KEY"], plane="<plane id>", agent="deployer")
fw.guard({"action": {"kind": "scale", "resource": "web", "replicas": 5}}, lambda: scale_web(5))
```

`guard` runs your callback only if the plane admits the change, waits while
it is queued or held for a person, and reports the outcome afterwards, so
the resource is free for the next change. A rejected change raises
`NotAdmitted` and your callback never runs.

Or with curl:

```sh
curl -s https://api.floodwall.ai/v1/planes/$PLANE/intents \
  -H "Authorization: Bearer $FLOODWALL_KEY" -H "Content-Type: application/json" \
  -d '{"id":"1","agent":"deployer","action":{"kind":"scale","resource":"web","replicas":5}}'
# {"key":{"agent":"deployer","id":"1"},"verdict":"admit",...}

curl -s https://api.floodwall.ai/v1/planes/$PLANE/intents/deployer/1/outcome \
  -H "Authorization: Bearer $FLOODWALL_KEY" -H "Content-Type: application/json" \
  -d '{"outcome":"succeeded"}'
```

## 5. Watch it, and step in

The console shows the queue, what is in flight and what is held. A held
change waits for someone to **Release** or **Expire** it, in the console or
from the Slack message the plane posts (set a channel under the plane's
alerts). Every decision, release and outcome is in the **Ledger**, and
**Export** downloads it for `node tools/verify-ledger.mjs`.

A full example agent: [`sdk/examples/deploy-agent.mjs`](sdk/examples/deploy-agent.mjs).

## Agents built on LLMs

Models make their own tool calls, so the wall has to sit where they act. Make
an **agent** key (step 3), give the agent its own name, and pick the way in
that fits how it is built. Each way asks before the change, stops unless the
answer is `admit`, and reports the outcome. A plane that cannot be asked
refuses the change. Examples for all four are in
[`sdk/examples`](sdk/examples).

**An MCP server** (Claude Code, Cursor, any MCP client). Tools:
`submit_intent`, `wait_verdict`, `report_outcome`, `list_held`; the
descriptions tell the model to submit before acting and to stop unless the
verdict is `admit`.

```sh
claude mcp add floodwall -e FLOODWALL_API_KEY=fw_live_... -e FLOODWALL_PLANE=pl_... -- npx -y @floodwall/mcp@0.1.0
```

For Cursor, put [`mcp-config.json`](sdk/examples/mcp-config.json) in
`.cursor/mcp.json`. `npx @floodwall/mcp@0.1.0 --http 3333` serves streamable HTTP
instead of stdio.

**A Claude Code hook** that does not rely on the model choosing to ask: a
`PreToolUse` hook on `Bash` submits `kubectl apply|delete|scale|rollout`,
`terraform apply|destroy` and `helm install|upgrade|uninstall`, blocks the
command unless the plane admits it, and `PostToolUse` reports how it went. Add
the hooks from [`claude-code-settings.json`](sdk/examples/claude-code-settings.json)
to `.claude/settings.json`; keep the key in a file (`FLOODWALL_API_KEY_FILE`) rather than in the settings, because the agent's own shell inherits that environment, and use a key bound to the agent. The hook is defence in depth, not a boundary: it cannot see through every shell trick. `FLOODWALL_HOOK_PATTERNS` changes what counts as
risky and `FLOODWALL_HOOK_BLAST` the blast radius.

**The Claude Agent SDK**: `npm install @floodwall/mcp@0.1.0`, then
`query({ prompt, options: { hooks: claudeAgentSdkHooks() } })` with
`import { claudeAgentSdkHooks } from "@floodwall/mcp/agent-sdk"`. See
[`agent-sdk-agent.mjs`](sdk/examples/agent-sdk-agent.mjs).

**LangGraph**: `pip install floodwall[langgraph]`, then wrap a tool with
`guarded_tool(fw, fn, change=...)` or add a `guard_node(fw, apply=...)` to the
graph. See [`langgraph-agent.py`](sdk/examples/langgraph-agent.py).

All of them can send the diff or plan as `context`; a plane with AI review on
reads it before deciding (it can only hold a change, never admit one the rules
refuse).
