"""A remediation bot: restarts unhealthy services, asking the plane first.

    FLOODWALL_KEY=fw_live_... FLOODWALL_PLANE=<plane id> \\
      python3 sdk/examples/remediation-bot.py [--apply]

Each unhealthy service is one intent: an `apply` of "restart" to it. A service
that is down asks with priority urgent, a degraded one with normal, so the
plane's rules can let urgent restarts through and hold the rest for a person.

Without --apply the health checks are simulated and the restarts printed.
Without FLOODWALL_KEY it prints the changes it would ask about, and stops.
In your own project: pip install floodwall, and drop the sys.path line.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
from floodwall import Floodwall, FloodwallError, NotAdmitted  # noqa: E402

# The services the bot watches, and where each answers its health check.
SERVICES = {
    "web": "http://web.internal/healthz",
    "api": "http://api.internal/healthz",
    "billing": "http://billing.internal/healthz",
}

# What the dry run pretends the health checks said.
SIMULATED = {"web": "ok", "api": "down", "billing": "degraded"}


def check(service: str, url: str, simulate: bool) -> str:
    """'ok', 'degraded' (slow or 5xx) or 'down' (no answer)."""
    if simulate:
        return SIMULATED[service]
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            return "ok" if response.status == 200 else "degraded"
    except urllib.error.HTTPError:
        return "degraded"
    except OSError:
        return "down"


def restart_change(service: str, health: str) -> dict:
    return {
        "action": {"kind": "apply", "resource": service, "manifest": "restart"},
        "priority": "urgent" if health == "down" else "normal",
        "blast_radius": "service",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true", help="check for real and restart with kubectl")
    args = parser.parse_args()

    unhealthy = {}
    for service, url in SERVICES.items():
        health = check(service, url, simulate=not args.apply)
        print(f"{service}: {health}")
        if health != "ok":
            unhealthy[service] = health

    if not os.environ.get("FLOODWALL_KEY"):
        print("FLOODWALL_KEY is not set, so no plane is asked. The changes would be:")
        for service, health in unhealthy.items():
            print(json.dumps(restart_change(service, health)))
        return 0

    fw = Floodwall(
        api_key=os.environ["FLOODWALL_KEY"],
        plane=os.environ["FLOODWALL_PLANE"],
        agent=os.environ.get("FLOODWALL_AGENT", "remediation-bot"),
        base_url=os.environ.get("FLOODWALL_URL", "https://api.floodwall.ai"),
    )

    for service, health in unhealthy.items():
        command = ["kubectl", "rollout", "restart", f"deployment/{service}"]

        def restart(command: list = command) -> None:
            if args.apply:
                subprocess.run(command, check=True)
            else:
                print("  would run:", " ".join(command))

        try:
            # One intent per service. A bot shouldn't sit on a held restart for
            # long: after a minute it moves on, and the intent stays held.
            fw.guard(restart_change(service, health), restart, timeout_seconds=60)
            print(f"{service}: restarted")
        except NotAdmitted as error:
            status, reason = error.decision["status"], error.decision.get("reason")
            if status == "held":
                # Deferred: a person decides, and this run has moved on, so
                # don't restart now. If they release it later the plane admits
                # it with nobody here to apply it: give the plane a "fail"
                # lease, so an admitted restart nobody reports on lapses.
                print(f"{service}: held for a person ({reason}); not restarting now")
            else:
                # rejected, expired or lapsed: the rules said no.
                print(f"{service}: {status} ({reason}); leaving it alone")
        except FloodwallError as error:
            print(f"{service}: the plane refused the request ({error.status}): {error}")
        except subprocess.CalledProcessError as error:
            print(f"{service}: the restart failed ({error.returncode}); reported as failed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
