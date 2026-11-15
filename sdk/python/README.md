# floodwall (Python)

Ask a Floodwall Cloud plane before your agent changes production, and tell it
how the change went. Standard library only; Python 3.9+.

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
  be reached (network errors and 5xx only) and calls `on_fail_open`. The
  default, `"closed"`, refuses it.
- `signing_key` signs each intent, for planes whose keyring requires it:
  `pip install floodwall[signing]`.

Tests: `python3 -m unittest discover -s tests -t .`
