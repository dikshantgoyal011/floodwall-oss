"""LangGraph and plain tool-calling helpers: run a tool only if the plane admits it.

``guarded_tool`` wraps a function so each call is a ``guard()``; ``guard_node``
makes a graph node that does the same for a change an earlier node proposed.
Either way a refusal is an answer the model can read, never an exception that
ends the run, and a plane that cannot be reached refuses the change (fail
closed). Nothing here imports ``langgraph`` until you ask for routing with
``on_refused``; install it with ``pip install floodwall[langgraph]``.
"""

from __future__ import annotations

import functools
import socket
import urllib.error
from typing import Any, Callable, Dict, Optional

from . import Floodwall, FloodwallError, NotAdmitted

__all__ = ["guarded_tool", "guard_node", "describe_refusal"]


def describe_refusal(error: BaseException) -> Dict[str, Any]:
    """What a refused or failed ``guard()`` means, as ``{"status", "message"}`` for a model to read."""
    if isinstance(error, NotAdmitted):
        decision = error.decision
        status = decision.get("status", "rejected")
        why = "; ".join(
            f"{p.get('policy')}: {p.get('reason')}"
            for p in decision.get("policies", [])
            if p.get("verdict") != "admit"
        ) or decision.get("reason") or status
        if status in ("held", "queued"):
            return {
                "status": "held",
                "message": f"not run yet: held for a person to approve ({why}). Do not retry it; tell the user it is waiting for approval.",
            }
        return {"status": status, "message": f"refused ({status}): {why}. Do not retry the same change."}
    if isinstance(error, FloodwallError):
        return {"status": "unavailable", "message": f"not run: the change control service refused the request ({error.status})"}
    return {"status": "unavailable", "message": f"not run: the change control service could not be asked ({error})"}


def guarded_tool(
    fw: Floodwall,
    fn: Callable[..., Any],
    change: Callable[..., Dict[str, Any]],
    name: Optional[str] = None,
    timeout_seconds: float = 30,
) -> Callable[..., str]:
    """Wrap ``fn`` so each call asks the plane first.

    ``change(*args, **kwargs)`` turns the call's arguments into the change the
    plane rules on (``{"action": {...}, "priority": ..., "context": ...}``).
    The wrapper returns ``"done: <result>"`` when the change was admitted and
    ran, and a plain-language refusal otherwise. An error raised by ``fn``
    itself is reported to the plane as a failed outcome and re-raised.
    """

    @functools.wraps(fn)
    def run(*args: Any, **kwargs: Any) -> str:
        ran = []

        def apply() -> Any:
            ran.append(True)
            return fn(*args, **kwargs)

        try:
            result = fw.guard(change(*args, **kwargs), apply, timeout_seconds=timeout_seconds)
        except Exception as error:  # noqa: BLE001
            if ran:
                raise  # the tool ran and failed (reported as failed): never "not run"
            if isinstance(error, (NotAdmitted, FloodwallError)) or _asks_failed(error):
                return describe_refusal(error)["message"]
            raise
        return f"done: {result}"

    if name:
        run.__name__ = name
    return run


def _asks_failed(error: BaseException) -> bool:
    """The plane could not be reached (transport failure), as opposed to a bug."""
    return isinstance(error, (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError))


def guard_node(
    fw: Floodwall,
    apply: Callable[[Dict[str, Any]], Any],
    change_key: str = "proposed_change",
    result_key: str = "floodwall",
    timeout_seconds: float = 30,
    on_refused: Optional[str] = None,
) -> Callable[[Dict[str, Any]], Any]:
    """A LangGraph node: ask the plane about ``state[change_key]``, then run ``apply(state)`` only if admitted.

    The node returns a state update ``{result_key: {"status", "message", "result"?}}``
    where ``status`` is ``"done"``, ``"held"``, ``"rejected"`` (or ``"expired"`` and
    so on) or ``"unavailable"`` (the plane could not be asked: nothing ran). With
    ``on_refused="node_name"`` a refusal also routes the graph there, through
    ``langgraph.types.Command`` (imported only then).
    """

    def node(state: Dict[str, Any]) -> Any:
        change = state.get(change_key) if isinstance(state, dict) else getattr(state, change_key, None)
        if not change:
            return {result_key: {"status": "unavailable", "message": f"not run: state has no {change_key}"}}
        ran = []

        def run() -> Any:
            ran.append(True)
            return apply(state)

        try:
            result = fw.guard(change, run, timeout_seconds=timeout_seconds)
        except Exception as error:  # noqa: BLE001
            if ran:
                raise  # apply ran and failed (reported as failed): never "not run"
            if not (isinstance(error, (NotAdmitted, FloodwallError)) or _asks_failed(error)):
                raise
            update = {result_key: describe_refusal(error)}
        else:
            return {result_key: {"status": "done", "message": f"done: {result}", "result": result}}
        if on_refused:
            from langgraph.types import Command  # lazy: only routing needs langgraph

            return Command(update=update, goto=on_refused)
        return update

    return node
