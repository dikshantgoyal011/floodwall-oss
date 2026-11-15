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

TypeScript (`sdk/typescript`, `@floodwall/client`):

```js
import { Floodwall } from "@floodwall/client";

const fw = new Floodwall({ apiKey: process.env.FLOODWALL_KEY, plane: "<plane id>", agent: "deployer" });

await fw.guard(
  { action: { kind: "scale", resource: "web", replicas: 5 } },
  () => scaleWeb(5),
);
```

Python (`sdk/python`, `floodwall`):

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
