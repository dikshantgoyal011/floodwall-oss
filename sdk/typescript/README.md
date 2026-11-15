# @floodwall/client

Ask a Floodwall Cloud plane before your agent changes production, and tell it
how the change went. No dependencies; Node 20+, Deno, Bun, Workers or a
current browser.

```js
import { Floodwall } from "@floodwall/client";

const fw = new Floodwall({
  apiKey: process.env.FLOODWALL_KEY, // an agent key from the console
  plane: "pl_…",
  agent: "deployer",
});

// Runs the callback only if the plane admits the change, then reports
// "succeeded", or "failed" with the error if the callback throws.
await fw.guard(
  { action: { kind: "scale", resource: "web", replicas: 5 }, priority: "normal", blastRadius: "service" },
  () => kubectl("scale deploy/web --replicas=5"),
);
```

`guard` waits while the change is queued or held for a person (up to
`timeoutSeconds`, 300 by default), and throws `NotAdmitted` if it is
rejected, expires or lapses. Rate limits (HTTP 429) are waited out.

- `submit(change)`, `wait(key)` and `report(key, outcome, reason)` are the
  steps `guard` takes, for agents that apply changes elsewhere.
- `whenUnreachable: "open"` applies a change unchecked when the plane cannot
  be reached (network errors and 5xx only) and calls `onFailOpen`. The
  default, `"closed"`, refuses it.
- `signingKey` (an Ed25519 `CryptoKey` or 32-byte seed) signs each intent,
  for planes whose keyring requires it.
- Intent ids default to the time in microseconds, kept increasing, so an
  agent that restarts needs no saved state.

Tests: `npm test`.
