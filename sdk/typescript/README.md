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
  be reached (fetch's network `TypeError`, aborts and timeouts, and 5xx only)
  and calls `onFailOpen(intent, error)`. Invalid changes and signing errors
  always throw. The default, `"closed"`, refuses it. The default `onFailOpen`
  logs the agent, kind, resource and error, never the manifest.
- A timeout leaves the intent **held** on the plane: `NotAdmitted` with
  status `"held"` means it may still be released later. Do not apply the change
  afterwards without submitting it again.
- `wait` never polls more than once a second, whatever the server does.
- If `apply` throws and reporting the failure fails too, your error is still
  the one thrown (the report error is on its `reportError`). If `apply`
  succeeds but the report fails, `guard` returns the result and calls
  `onReportError(error, key)` (default: `console.warn`). Failure reasons are
  sent with whitespace collapsed, at most 1024 characters.
- `baseUrl` must be `https://`, except for `localhost`, `127.0.0.1` and
  `[::1]`. `apiKey` is not enumerable, so logging the client does not print it.
- `signingKey` (an Ed25519 `CryptoKey` or 32-byte seed) signs each intent,
  for planes whose keyring requires it.
- Intent ids default to the time in microseconds, kept increasing, so an
  agent that restarts needs no saved state.

Tests: `npm test`.
