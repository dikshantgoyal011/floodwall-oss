# floodwall (Python)

Ask a Floodwall Cloud plane before your agent changes production, and tell it
how the change went. Standard library only; Python 3.9+.

```sh
pip install floodwall
```

```python
from floodwall import Floodwall

fw = Floodwall(api_key=os.environ["FLOODWALL_KEY"], plane="pl_...", agent="deployer")

# Runs the callable only if the plane admits the change, then reports
# "succeeded", or "failed" with the exception if it raises.
fw.guard(
    {"action": {"kind": "scale", "resource": "web", "replicas": 5}, "priority": "normal"},
    lambda: subprocess.run(["kubectl", "scale", "deploy/web", "--replicas=5"], check=True),
)
```

`guard` waits while the change is queued or held for a person (up to
`timeout_seconds`, 300 by default), and raises `NotAdmitted` if it is
rejected, expires or lapses. Rate limits (HTTP 429) are waited out.

- `submit`, `wait` and `report` are the steps `guard` takes.
- `when_unreachable="open"` applies a change unchecked when the plane cannot
  be reached (`URLError`, timeouts, connection errors and 5xx only) and calls
  `on_fail_open(intent, error)`. Invalid changes, signing errors and a missing
  `cryptography` package always raise. The default, `"closed"`, refuses it.
  The default `on_fail_open` warns with the agent, kind, resource and error,
  never the manifest.
- A timeout leaves the intent **held** on the plane: `NotAdmitted` with
  status `"held"` means it may still be released later. Do not apply the change
  afterwards without submitting it again.
- `wait` never polls more than once a second, whatever the server does.
- If `apply` raises and reporting the failure fails too, your exception is
  still the one raised (the report error is on its `report_error`). If `apply`
  succeeds but the report fails, `guard` returns the result and calls
  `on_report_error(error, key)` (default: `warnings.warn`). Failure reasons are
  sent with whitespace collapsed, at most 1024 characters.
- `base_url` must be `https://`, except for `localhost`, `127.0.0.1` and
  `[::1]`. Redirects are never followed, and the key is not in `repr()`.
- `Retry-After` may be seconds or an HTTP date.
- Since 0.2.0, `context` (a string up to 64 KiB, such as a diff or plan) on a change goes
  to the plane as a top-level field, for its AI review of the change. It is
  never part of the signed intent bytes and the plane does not store it.
  Longer or non-string context raises `ValueError` before anything is sent.
- `floodwall.langgraph` wraps a tool in `guard()` for LangGraph agents; see
  below.
- `signing_key` signs each intent, for planes whose keyring requires it:
  `pip install floodwall[signing]`.

## LangGraph

`pip install floodwall[langgraph]`. Import is lazy: `floodwall` itself needs
nothing, and only `guard_node` needs `langgraph`.

```python
from floodwall import Floodwall
from floodwall.langgraph import guarded_tool, guard_node

fw = Floodwall(api_key=os.environ["FLOODWALL_KEY"], plane="pl_...", agent="graph-agent")

# A plain function that asks the plane first. A refusal comes back as a string
# the model can read, never an exception that ends the run.
scale = guarded_tool(
    fw,
    lambda deployment, replicas: run_kubectl_scale(deployment, replicas),
    change=lambda deployment, replicas: {"action": {"kind": "scale", "resource": deployment, "replicas": replicas}},
    name="scale_deployment",
)

# Or a graph node: reads state["proposed_change"], writes state["floodwall"].
graph.add_node("guard", guard_node(fw, apply=lambda state: apply_change(state["proposed_change"])))
```

Tests: `python3 -m unittest discover -s tests -t .`

Releases: bump `version` in `pyproject.toml`, then push a tag `sdk-python-v<version>`;
the `publish-python` workflow publishes it to PyPI (Trusted Publishing, no token).
