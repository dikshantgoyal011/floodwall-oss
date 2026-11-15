"""Run `terraform apply` per workspace, each one only once the plane admits it.

    FLOODWALL_KEY=fw_live_... FLOODWALL_PLANE=<plane id> \\
      python3 sdk/examples/terraform-apply.py dev staging prod-eu [--chdir infra] [--apply]

Each workspace is one intent: an `apply` of the plan to that workspace, with a
blast radius read from the workspace's name, so the plane's rules can hold a
region-wide or global apply for a person while dev goes straight through.

Without --apply it prints the terraform commands instead of running them.
Without FLOODWALL_KEY it prints the changes it would ask about, and stops.
In your own project: pip install floodwall, and drop the sys.path line.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
from floodwall import Floodwall, FloodwallError, NotAdmitted  # noqa: E402


def blast_radius(workspace: str) -> str:
    """How much an apply to this workspace can break, from its name."""
    if "global" in workspace:
        return "global"
    if workspace.startswith("prod"):
        return "region"  # prod-eu, prod-us: one region each
    if workspace.startswith("staging"):
        return "service"
    return "cell"  # dev, sandboxes, previews


def change_for(workspace: str, revision: str) -> dict:
    radius = blast_radius(workspace)
    return {
        # The manifest is what the rules and the ledger see as "what": here the
        # revision being applied. A rule can require, say, a tagged release.
        "action": {"kind": "apply", "resource": f"terraform/{workspace}", "manifest": revision},
        # Wider applies ask for more urgency; the rules decide what that buys.
        "priority": "urgent" if radius in ("region", "global") else "normal",
        "blast_radius": radius,
    }


def commands(workspace: str, chdir: str) -> list[list[str]]:
    return [
        ["terraform", f"-chdir={chdir}", "workspace", "select", workspace],
        ["terraform", f"-chdir={chdir}", "apply", "-auto-approve", "-input=false"],
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("workspaces", nargs="+")
    parser.add_argument("--chdir", default=".", help="the Terraform root module")
    parser.add_argument("--revision", default=os.environ.get("GIT_COMMIT", "HEAD"), help="what is being applied")
    parser.add_argument("--apply", action="store_true", help="run terraform instead of printing it")
    args = parser.parse_args()

    if not os.environ.get("FLOODWALL_KEY"):
        print("FLOODWALL_KEY is not set, so no plane is asked. The changes would be:")
        for workspace in args.workspaces:
            print(json.dumps(change_for(workspace, args.revision)))
            for command in commands(workspace, args.chdir):
                print("  then:", " ".join(command))
        return 0

    fw = Floodwall(
        api_key=os.environ["FLOODWALL_KEY"],
        plane=os.environ["FLOODWALL_PLANE"],
        agent=os.environ.get("FLOODWALL_AGENT", "terraform"),
        base_url=os.environ.get("FLOODWALL_URL", "https://api.floodwall.ai"),
    )

    failed = 0
    for workspace in args.workspaces:

        def apply(workspace: str = workspace) -> None:
            for command in commands(workspace, args.chdir):
                if args.apply:
                    print("running:", " ".join(command))
                    # check=True: a failed apply raises, and guard reports it "failed".
                    subprocess.run(command, check=True)
                else:
                    print("would run:", " ".join(command))

        try:
            # A held apply waits up to 15 minutes for a person to release it.
            fw.guard(change_for(workspace, args.revision), apply, timeout_seconds=900)
            print(f"{workspace}: applied")
        except NotAdmitted as error:
            decision = error.decision
            print(f"{workspace}: not admitted ({decision['status']}: {decision.get('reason') or 'no reason'})")
            failed += 1
        except FloodwallError as error:
            print(f"{workspace}: the plane refused the request ({error.status}): {error}")
            failed += 1
        except subprocess.CalledProcessError as error:
            print(f"{workspace}: terraform failed ({error.returncode}); reported as failed")
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
