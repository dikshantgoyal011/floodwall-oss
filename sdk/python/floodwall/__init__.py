"""Ask a Floodwall Cloud plane before an agent changes production.

Standard library only. Signing intents (for planes with a keyring) needs the
optional ``cryptography`` package: ``pip install floodwall[signing]``.

    fw = Floodwall(api_key="fw_live_...", plane="pl_...", agent="deployer")
    fw.guard({"action": {"kind": "scale", "resource": "web", "replicas": 5}},
             lambda: scale_web(5))
"""

from __future__ import annotations

import hashlib
import json
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Optional, TypeVar

__all__ = ["Floodwall", "FloodwallError", "NotAdmitted", "intent_bytes", "intent_digest"]

DEFAULT_BASE_URL = "https://api.floodwall.ai"
PRIORITIES = ("bulk", "normal", "urgent", "pager")
BLAST_RADII = ("cell", "service", "region", "global")
WAITING = {"queued", "held"}

T = TypeVar("T")


class FloodwallError(Exception):
    """The plane answered with an error the caller should not retry blindly."""

    def __init__(self, status: int, message: str, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


class NotAdmitted(Exception):
    """The change was rejected, expired or lapsed, or still waited when time ran out."""

    def __init__(self, decision: Dict[str, Any]):
        key = decision["key"]
        why = f": {decision['reason']}" if decision.get("reason") else ""
        super().__init__(f"floodwall did not admit {key['agent']}/{key['id']}: {decision['status']}{why}")
        self.decision = decision


class Floodwall:
    """A connection to one plane, as one agent.

    ``when_unreachable`` is ``"closed"`` (the default: a change the plane
    cannot be asked about is refused) or ``"open"`` (it is applied unchecked
    and ``on_fail_open`` is called). ``signing_key`` is the agent's Ed25519
    private key: 32 seed bytes, or a ``cryptography`` Ed25519PrivateKey.
    """

    def __init__(
        self,
        api_key: str,
        plane: str,
        agent: str,
        base_url: str = DEFAULT_BASE_URL,
        when_unreachable: str = "closed",
        on_fail_open: Optional[Callable[[Any, BaseException], None]] = None,
        signing_key: Any = None,
        opener: Optional[Callable[[urllib.request.Request, float], Any]] = None,
        timeout: float = 30.0,
    ):
        for name, value in (("api_key", api_key), ("plane", plane), ("agent", agent)):
            if not isinstance(value, str) or not value:
                raise TypeError(f"{name} is required")
        if when_unreachable not in ("closed", "open"):
            raise ValueError('when_unreachable must be "closed" or "open"')
        self.api_key = api_key
        self.plane = plane
        self.agent = agent
        self.base_url = base_url.rstrip("/")
        self.when_unreachable = when_unreachable
        self.on_fail_open = on_fail_open or (lambda change, error: None)
        self.signing_key = signing_key
        self.timeout = timeout
        self._open = opener or (lambda request, timeout: urllib.request.urlopen(request, timeout=timeout))
        self._last_id = 0
        self._lock = threading.Lock()

    def next_id(self) -> int:
        """An id above every id this client has used: the time in microseconds, or one more."""
        with self._lock:
            self._last_id = max(self._last_id + 1, int(time.time() * 1_000_000))
            return self._last_id

    def intent(self, change: Dict[str, Any]) -> Dict[str, Any]:
        """The change in the plane's form (keys in the order the plane reads them)."""
        action = change.get("action") or {}
        priority = change.get("priority", "normal")
        blast = change.get("blast_radius", change.get("blastRadius", "service"))
        if priority not in PRIORITIES:
            raise ValueError(f"priority must be one of {', '.join(PRIORITIES)}")
        if blast not in BLAST_RADII:
            raise ValueError(f"blast_radius must be one of {', '.join(BLAST_RADII)}")
        kind = action.get("kind")
        if kind == "apply":
            normalized = {"kind": "apply", "resource": str(action["resource"]), "manifest": str(action.get("manifest", ""))}
        elif kind == "scale":
            replicas = action.get("replicas")
            if not isinstance(replicas, int) or isinstance(replicas, bool) or not 0 <= replicas <= 0xFFFFFFFF:
                raise ValueError("scale replicas must be a whole number from 0 to 4294967295")
            normalized = {"kind": "scale", "resource": str(action["resource"]), "replicas": replicas}
        elif kind == "destroy":
            normalized = {"kind": "destroy", "resource": str(action["resource"])}
        else:
            raise ValueError('action.kind must be "apply", "scale" or "destroy"')
        return {
            "id": str(change.get("id", self.next_id())),
            "agent": self.agent,
            "action": normalized,
            "priority": priority,
            "blast_radius": blast,
            "signature": None,
        }

    def submit(self, change: Dict[str, Any]) -> Dict[str, Any]:
        """Offer a change; returns the plane's first answer (admit, held, rejected or queued)."""
        intent = change if "agent" in change and "blast_radius" in change else self.intent(change)
        if self.signing_key is not None:
            intent["signature"] = sign(intent, self.signing_key)
        answer = self._request("POST", f"/v1/planes/{_q(self.plane)}/intents", intent)
        return _decision(answer, intent["agent"], intent["id"])

    def wait(self, key: Dict[str, str], timeout_seconds: float = 300) -> Dict[str, Any]:
        """Wait until the intent leaves the queue and the hold queue, or time runs out."""
        until = time.monotonic() + timeout_seconds
        while True:
            left = until - time.monotonic()
            wait = max(0, min(20, int(left + 0.999)))
            answer = self._request(
                "GET", f"/v1/planes/{_q(self.plane)}/intents/{_q(key['agent'])}/{_q(key['id'])}?wait={wait}"
            )
            status = _decision(answer, key["agent"], key["id"])
            if status["status"] not in WAITING or left <= 0:
                return status

    def report(self, key: Dict[str, str], outcome: str, reason: Optional[str] = None) -> None:
        """Report how an admitted change went, which frees its resource."""
        if outcome not in ("succeeded", "failed"):
            raise ValueError('outcome must be "succeeded" or "failed"')
        self._request(
            "POST",
            f"/v1/planes/{_q(self.plane)}/intents/{_q(key['agent'])}/{_q(key['id'])}/outcome",
            {"outcome": outcome, "reason": reason},
        )

    def guard(self, change: Dict[str, Any], apply: Callable[[], T], timeout_seconds: float = 300) -> T:
        """Run ``apply`` only if the plane admits the change, and report how it went."""
        try:
            first = self.submit(change)
        except Exception as error:  # noqa: BLE001 - classified below
            if self.when_unreachable == "open" and _unreachable(error):
                self.on_fail_open(change, error)
                return apply()
            raise
        settled = self.wait(first["key"], timeout_seconds) if first["status"] in WAITING else first
        if settled["status"] not in ("admit", "in_flight"):
            raise NotAdmitted(settled)
        try:
            result = apply()
        except BaseException as error:
            self.report(first["key"], "failed", str(error)[:500])
            raise
        self.report(first["key"], "succeeded")
        return result

    def _request(self, method: str, path: str, body: Any = None) -> Dict[str, Any]:
        data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        headers = {"Authorization": f"Bearer {self.api_key}", "User-Agent": "floodwall-python/0.1"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        for attempt in range(6):
            request = urllib.request.Request(self.base_url + path, data=data, method=method, headers=headers)
            try:
                with self._open(request, self.timeout) as response:
                    text = response.read().decode()
                    return json.loads(text) if text else {}
            except urllib.error.HTTPError as error:
                text = error.read().decode(errors="replace")
                try:
                    parsed = json.loads(text) if text else {}
                except ValueError:
                    parsed = {"error": text}
                if error.code == 429 and attempt < 5:
                    time.sleep(float(error.headers.get("Retry-After") or 1))
                    continue
                raise FloodwallError(error.code, parsed.get("error") or f"floodwall answered {error.code}", parsed) from None
        raise AssertionError("unreachable")


def _q(value: Any) -> str:
    return urllib.parse.quote(str(value), safe="")


def _unreachable(error: BaseException) -> bool:
    return not isinstance(error, FloodwallError) or error.status >= 500


def _decision(answer: Dict[str, Any], agent: str, intent_id: str) -> Dict[str, Any]:
    key = answer.get("key") or {"agent": agent, "id": intent_id}
    status = answer.get("status") or answer.get("verdict") or "queued"
    status = {"defer": "held", "reject": "rejected"}.get(status, status)
    return {
        "key": {"agent": key["agent"], "id": str(key["id"])},
        "status": status,
        "verdict": answer.get("verdict"),
        "reason": answer.get("reason"),
        "policies": answer.get("policies", []),
    }


def _field(parts: list, data: bytes) -> None:
    parts.append(struct.pack("<Q", len(data)))
    parts.append(data)


def intent_bytes(intent: Dict[str, Any]) -> bytes:
    """The bytes whose SHA-256 an agent signs (the crate's Intent::digest)."""
    parts: list = []
    _field(parts, b"floodwall/intent/v1")
    _field(parts, intent["agent"].encode())
    parts.append(struct.pack("<Q", int(intent["id"])))
    action = intent["action"]
    if action["kind"] == "apply":
        parts.append(b"\x00")
        _field(parts, action["resource"].encode())
        _field(parts, action["manifest"].encode())
    elif action["kind"] == "scale":
        parts.append(b"\x01")
        _field(parts, action["resource"].encode())
        parts.append(struct.pack("<I", action["replicas"]))
    else:
        parts.append(b"\x02")
        _field(parts, action["resource"].encode())
    parts.append(bytes([PRIORITIES.index(intent["priority"]), BLAST_RADII.index(intent["blast_radius"])]))
    return b"".join(parts)


def intent_digest(intent: Dict[str, Any]) -> bytes:
    return hashlib.sha256(intent_bytes(intent)).digest()


def sign(intent: Dict[str, Any], key: Any) -> str:
    """The intent's Ed25519 signature as hex. Needs the ``cryptography`` package."""
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    except ImportError as error:  # pragma: no cover - depends on the environment
        raise RuntimeError("signing intents needs `pip install floodwall[signing]`") from error
    if isinstance(key, (bytes, bytearray)):
        key = Ed25519PrivateKey.from_private_bytes(bytes(key))
    return key.sign(intent_digest(intent)).hex()
