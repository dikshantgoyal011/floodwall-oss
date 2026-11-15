"""Ask a Floodwall Cloud plane before an agent changes production.

Standard library only. Signing intents (for planes with a keyring) needs the
optional ``cryptography`` package: ``pip install floodwall[signing]``.

    fw = Floodwall(api_key="fw_live_...", plane="pl_...", agent="deployer")
    fw.guard({"action": {"kind": "scale", "resource": "web", "replicas": 5}},
             lambda: scale_web(5))
"""

from __future__ import annotations

import hashlib
import datetime
import email.utils
import json
import math
import socket
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
from typing import Any, Callable, Dict, Optional, TypeVar

__all__ = ["Floodwall", "FloodwallError", "NotAdmitted", "intent_bytes", "intent_digest"]

DEFAULT_BASE_URL = "https://api.floodwall.ai"
PRIORITIES = ("bulk", "normal", "urgent", "pager")
BLAST_RADII = ("cell", "service", "region", "global")
WAITING = {"queued", "held"}
#: Polls of a waiting intent are never closer together than this, whatever the server does.
MIN_POLL_SECONDS = 1.0
MAX_REASON = 1024
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")

T = TypeVar("T")


class FloodwallError(Exception):
    """The plane answered with an error the caller should not retry blindly."""

    def __init__(self, status: int, message: str, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


class NotAdmitted(Exception):
    """The change was rejected, expired or lapsed, or still waited when time ran out.

    When ``decision["status"]`` is ``"held"`` (or ``"queued"``) after a timeout,
    the intent is still held on the plane and may be released later. The agent
    must not apply the change afterwards without submitting it again.
    """

    def __init__(self, decision: Dict[str, Any]):
        key = decision["key"]
        why = f": {decision['reason']}" if decision.get("reason") else ""
        super().__init__(f"floodwall did not admit {key['agent']}/{key['id']}: {decision['status']}{why}")
        self.decision = decision


# A 429's Retry-After is waited out up to this, however long it asks for.
_MAX_RETRY_AFTER_SECONDS = 60.0


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is an error: the API key must not follow a response to another place."""

    def redirect_request(self, *args, **kwargs):
        return None


class Floodwall:
    """A connection to one plane, as one agent.

    ``when_unreachable`` is ``"closed"`` (the default: a change the plane
    cannot be asked about is refused) or ``"open"`` (it is applied unchecked
    and ``on_fail_open`` is called). ``signing_key`` is the agent's Ed25519
    private key: 32 seed bytes, or a ``cryptography`` Ed25519PrivateKey.

    ``base_url`` must be ``https://`` unless the host is localhost, 127.0.0.1
    or ``[::1]``. ``on_report_error(error, key)`` is told when reporting a
    successful change failed (the result is still returned); the default warns
    without the manifest. Redirects are never followed.
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
        on_report_error: Optional[Callable[[BaseException, Dict[str, str]], None]] = None,
        opener: Optional[Callable[[urllib.request.Request, float], Any]] = None,
        timeout: float = 30.0,
    ):
        for name, value in (("api_key", api_key), ("plane", plane), ("agent", agent)):
            if not isinstance(value, str) or not value:
                raise TypeError(f"{name} is required")
        if when_unreachable not in ("closed", "open"):
            raise ValueError('when_unreachable must be "closed" or "open"')
        _check_base_url(base_url)
        self.api_key = api_key
        self.plane = plane
        self.agent = agent
        self.base_url = base_url.rstrip("/")
        self.when_unreachable = when_unreachable
        self.on_fail_open = on_fail_open or _warn_fail_open
        self.on_report_error = on_report_error or _warn_report_error
        self.signing_key = signing_key
        self.timeout = timeout
        if opener is None:
            built = urllib.request.build_opener(_NoRedirect)
            opener = lambda request, timeout: built.open(request, timeout=timeout)  # noqa: E731
        self._open = opener
        self._sleep = time.sleep
        self._last_id = 0
        self._lock = threading.Lock()

    def __repr__(self) -> str:
        return f"Floodwall(plane={self.plane!r}, agent={self.agent!r}, base_url={self.base_url!r})"

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
            "id": str(change["id"] if "id" in change else self.next_id()),
            "agent": self.agent,
            "action": normalized,
            "priority": priority,
            "blast_radius": blast,
            "signature": None,
        }

    def prepare(self, change: Dict[str, Any]) -> Dict[str, Any]:
        """Validate (and sign, when there is a key) a change: errors here are the caller's, never "unreachable"."""
        intent = change if "agent" in change and "blast_radius" in change else self.intent(change)
        if self.signing_key is not None:
            intent["signature"] = sign(intent, self.signing_key)
        return intent

    def submit(self, change: Dict[str, Any]) -> Dict[str, Any]:
        """Offer a change; returns the plane's first answer (admit, held, rejected or queued)."""
        return self._post(self.prepare(change))

    def _post(self, intent: Dict[str, Any]) -> Dict[str, Any]:
        answer = self._request("POST", f"/v1/planes/{_q(self.plane)}/intents", intent)
        return _decision(answer, intent["agent"], intent["id"])

    def wait(self, key: Dict[str, str], timeout_seconds: float = 300) -> Dict[str, Any]:
        """Wait until the intent leaves the queue and the hold queue, or time runs out.

        A timeout leaves the intent held. Polls are at least a second apart even
        if the server answers at once.
        """
        until = time.monotonic() + timeout_seconds
        while True:
            started = time.monotonic()
            left = until - started
            wait = max(0, min(20, int(left + 0.999)))
            answer = self._request(
                "GET", f"/v1/planes/{_q(self.plane)}/intents/{_q(key['agent'])}/{_q(key['id'])}?wait={wait}"
            )
            status = _decision(answer, key["agent"], key["id"])
            if status["status"] not in WAITING or left <= 0:
                return status
            pause = min(MIN_POLL_SECONDS - (time.monotonic() - started), until - time.monotonic())
            if pause > 0:
                self._sleep(pause)

    def report(self, key: Dict[str, str], outcome: str, reason: Optional[str] = None) -> None:
        """Report how an admitted change went, which frees its resource."""
        if outcome not in ("succeeded", "failed"):
            raise ValueError('outcome must be "succeeded" or "failed"')
        self._request(
            "POST",
            f"/v1/planes/{_q(self.plane)}/intents/{_q(key['agent'])}/{_q(key['id'])}/outcome",
            {"outcome": outcome, "reason": None if reason is None else " ".join(str(reason).split())[:MAX_REASON]},
        )

    def guard(self, change: Dict[str, Any], apply: Callable[[], T], timeout_seconds: float = 300) -> T:
        """Run ``apply`` only if the plane admits the change, and report how it went.

        Raises ``NotAdmitted`` when it is not admitted (a ``"held"`` intent after a
        timeout may still be released later: do not apply the change then without
        submitting it again). If ``apply`` raises and the failure report fails too,
        the apply error is still the one raised, with the report error on its
        ``report_error`` attribute. If ``apply`` succeeds but the report fails, the
        result is returned and ``on_report_error`` is told. Only transport failures
        and 5xx count as unreachable; invalid changes and signing errors always raise.
        """
        intent = self.prepare(change)
        try:
            first = self._post(intent)
        except Exception as error:  # noqa: BLE001 - classified below
            if self.when_unreachable == "open" and _unreachable(error):
                self.on_fail_open(intent, error)
                return apply()
            raise
        settled = self.wait(first["key"], timeout_seconds) if first["status"] in WAITING else first
        if settled["status"] not in ("admit", "in_flight"):
            raise NotAdmitted(settled)
        try:
            result = apply()
        except BaseException as error:
            try:
                self.report(first["key"], "failed", str(error))
            except Exception as report_error:  # noqa: BLE001 - the change's error wins
                try:
                    error.report_error = report_error
                except Exception:  # noqa: BLE001
                    pass
            raise
        try:
            self.report(first["key"], "succeeded")
        except Exception as report_error:  # noqa: BLE001
            self.on_report_error(report_error, first["key"])
        return result

    def _request(self, method: str, path: str, body: Any = None) -> Dict[str, Any]:
        data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        headers = {"User-Agent": "floodwall-python/0.1"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        for attempt in range(6):
            request = urllib.request.Request(self.base_url + path, data=data, method=method, headers=headers)
            request.add_unredirected_header("Authorization", f"Bearer {self.api_key}")
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
                    self._sleep(_retry_after(error.headers.get("Retry-After")))
                    continue
                raise FloodwallError(error.code, parsed.get("error") or f"floodwall answered {error.code}", parsed) from None
        raise AssertionError("unreachable")


def _q(value: Any) -> str:
    return urllib.parse.quote(str(value), safe="")


def _unreachable(error: BaseException) -> bool:
    """Only a transport failure (no connection, a timeout) or a 5xx means the plane is unreachable."""
    if isinstance(error, FloodwallError):
        return error.status >= 500
    if isinstance(error, urllib.error.HTTPError):
        return False
    return isinstance(error, (urllib.error.URLError, socket.timeout, ConnectionError, TimeoutError))


def _retry_after(value: Any) -> float:
    """Seconds to wait from a Retry-After header, given as seconds or an HTTP date; 1 s if unusable, 60 s at most."""
    try:
        text = str(value).strip()
        try:
            seconds = float(text)
        except ValueError:
            when = email.utils.parsedate_to_datetime(text)
            if when.tzinfo is None:
                when = when.replace(tzinfo=datetime.timezone.utc)
            seconds = (when - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
        return min(max(0.0, seconds), _MAX_RETRY_AFTER_SECONDS) if math.isfinite(seconds) else 1.0
    except Exception:  # noqa: BLE001 - a bad header must not crash the client
        return 1.0


def _check_base_url(base_url: str) -> None:
    parts = urllib.parse.urlsplit(base_url)
    if parts.scheme == "https" and parts.hostname:
        return
    if parts.scheme == "http" and parts.hostname in LOCAL_HOSTS:
        return
    raise ValueError("base_url must be https:// unless the host is localhost, 127.0.0.1 or [::1]")


def _warn_fail_open(intent: Any, error: BaseException) -> None:
    action = intent.get("action") or {}
    warnings.warn(
        f"floodwall unreachable; applied unchecked: agent={intent.get('agent')} kind={action.get('kind')} "
        f"resource={action.get('resource')}: {error}",
        stacklevel=2,
    )


def _warn_report_error(error: BaseException, key: Dict[str, str]) -> None:
    warnings.warn(f"floodwall could not report the outcome of {key['agent']}/{key['id']}: {error}", stacklevel=2)


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
