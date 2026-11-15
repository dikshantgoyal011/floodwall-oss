import io
import json
import unittest
import urllib.error

from floodwall import Floodwall, FloodwallError, NotAdmitted, intent_bytes


class Answer(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def stub(handler):
    calls = []

    def opener(request, timeout):
        body = json.loads(request.data) if request.data else None
        call = {"method": request.get_method(), "url": request.full_url, "headers": dict(request.header_items()), "body": body}
        calls.append(call)
        status, answer = handler(call)
        data = json.dumps(answer).encode()
        if status >= 400:
            raise urllib.error.HTTPError(request.full_url, status, "error", {"Retry-After": "0"}, io.BytesIO(data))
        return Answer(data)

    return calls, opener


def client(opener, **extra):
    return Floodwall(api_key="fw_test_x", plane="p1", agent="deployer", opener=opener, **extra)


SCALE = {"action": {"kind": "scale", "resource": "web", "replicas": 3}}


class ClientTest(unittest.TestCase):
    def test_guard_applies_an_admitted_change_and_reports_it(self):
        calls, opener = stub(lambda c: (200, {"verdict": "admit"}))
        self.assertEqual(client(opener).guard(SCALE, lambda: "applied"), "applied")
        self.assertEqual(calls[0]["headers"]["Authorization"], "Bearer fw_test_x")
        self.assertEqual(list(calls[0]["body"]), ["id", "agent", "action", "priority", "blast_radius", "signature"])
        self.assertTrue(calls[1]["url"].endswith("/outcome"))
        self.assertEqual(calls[1]["body"], {"outcome": "succeeded", "reason": None})

    def test_a_held_change_is_applied_once_released(self):
        polls = []

        def handler(c):
            if c["method"] == "POST" and c["url"].endswith("/intents"):
                return 200, {"verdict": "defer", "reason": "off the allowlist"}
            if c["method"] == "GET":
                polls.append(1)
                return 200, {"status": "held" if len(polls) < 2 else "in_flight"}
            return 200, {}

        calls, opener = stub(handler)
        client(opener).guard(SCALE, lambda: None)
        self.assertEqual(len(polls), 2)

    def test_a_rejected_change_is_never_applied(self):
        calls, opener = stub(lambda c: (200, {"verdict": "reject", "reason": "no"}))
        with self.assertRaises(NotAdmitted):
            client(opener).guard(SCALE, lambda: self.fail("applied"))
        self.assertEqual(len(calls), 1)

    def test_a_failing_change_is_reported_failed(self):
        calls, opener = stub(lambda c: (200, {"verdict": "admit"}))

        def boom():
            raise RuntimeError("kubectl exploded")

        with self.assertRaises(RuntimeError):
            client(opener).guard(SCALE, boom)
        self.assertEqual(calls[-1]["body"], {"outcome": "failed", "reason": "kubectl exploded"})

    def test_rate_limits_are_waited_out(self):
        tries = []

        def handler(c):
            tries.append(1)
            return (429, {"error": "slow"}) if len(tries) < 2 else (200, {"verdict": "admit"})

        calls, opener = stub(handler)
        self.assertEqual(client(opener).submit(SCALE)["status"], "admit")

    def test_unreachable_closed_refuses_and_open_applies(self):
        def down(request, timeout):
            raise urllib.error.URLError("no route")

        with self.assertRaises(urllib.error.URLError):
            client(down).guard(SCALE, lambda: self.fail())
        unchecked = []
        out = client(down, when_unreachable="open", on_fail_open=lambda c, e: unchecked.append(c)).guard(SCALE, lambda: "ran")
        self.assertEqual(out, "ran")
        self.assertEqual(len(unchecked), 1)
        calls, opener = stub(lambda c: (401, {"error": "bad key"}))
        with self.assertRaises(FloodwallError):
            client(opener, when_unreachable="open").guard(SCALE, lambda: self.fail())

    def test_signed_bytes_match_the_crate(self):
        import struct

        def field(s):
            return struct.pack("<Q", len(s)) + s

        got = intent_bytes({"id": "7", "agent": "a", "action": {"kind": "scale", "resource": "w", "replicas": 2},
                            "priority": "urgent", "blast_radius": "region", "signature": None})
        want = field(b"floodwall/intent/v1") + field(b"a") + struct.pack("<Q", 7) + b"\x01" + field(b"w") + struct.pack("<I", 2) + b"\x02\x02"
        self.assertEqual(got, want)


if __name__ == "__main__":
    unittest.main()
