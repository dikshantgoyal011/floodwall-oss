import http.server
import io
import json
import socket
import sys
import threading
import unittest
import urllib.error
import warnings
from unittest import mock

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

    def test_fail_open_only_for_transport_failures(self):
        seen = []
        asked = []

        def down(request, timeout):
            asked.append(1)
            raise urllib.error.URLError("no route")

        def open_(opener, **extra):
            return client(opener, when_unreachable="open", on_fail_open=lambda i, e: seen.append(i), **extra)

        # Validation errors raise, with no request and nothing applied.
        with self.assertRaises(ValueError):
            open_(down).guard({**SCALE, "priority": "nope"}, lambda: self.fail("applied"))
        with self.assertRaises(ValueError):
            open_(down).guard({"action": {"kind": "scale", "resource": "w", "replicas": -1}}, lambda: self.fail("applied"))
        # A missing `cryptography` package raises, never fails open.
        with mock.patch.dict(sys.modules, {"cryptography": None, "cryptography.hazmat.primitives.asymmetric.ed25519": None}):
            with self.assertRaises(RuntimeError):
                open_(down, signing_key=b"k" * 32).guard(SCALE, lambda: self.fail("applied"))
        self.assertEqual((asked, seen), ([], []))

        def raising(exc):
            def opener(request, timeout):
                raise exc

            return opener

        with self.assertRaises(KeyError):
            open_(raising(KeyError("odd"))).guard(SCALE, lambda: self.fail("applied"))
        for exc in (urllib.error.URLError("x"), socket.timeout("t"), ConnectionResetError("r"), TimeoutError("t")):
            self.assertEqual(open_(raising(exc)).guard(SCALE, lambda: "ran"), "ran")
        _, opener = stub(lambda c: (503, {"error": "down"}))
        self.assertEqual(open_(opener).guard(SCALE, lambda: "ran"), "ran")
        _, opener = stub(lambda c: (400, {"error": "bad"}))
        with self.assertRaises(FloodwallError):
            open_(opener).guard(SCALE, lambda: self.fail("applied"))
        self.assertEqual(len(seen), 5)

    def test_default_fail_open_warning_leaves_the_manifest_out(self):
        def down(request, timeout):
            raise urllib.error.URLError("no route")

        change = {"action": {"kind": "apply", "resource": "web", "manifest": "SECRET: hunter2"}}
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always", UserWarning)
            warnings.simplefilter("ignore", ResourceWarning)
            client(down, when_unreachable="open").guard(change, lambda: 1)
        self.assertEqual(len(caught), 1)
        text = str(caught[0].message)
        self.assertIn("deployer", text)
        self.assertIn("web", text)
        self.assertNotIn("hunter2", text)

    def test_wait_never_polls_faster_than_once_a_second(self):
        polls = []
        calls, opener = stub(lambda c: (200, {"status": "held" if len(polls.append(1) or polls) < 4 else "in_flight"}))
        fw = client(opener)
        sleeps = []
        fw._sleep = sleeps.append
        self.assertEqual(fw.wait({"agent": "deployer", "id": "1"})["status"], "in_flight")
        self.assertEqual(len(sleeps), 3)
        for pause in sleeps:
            self.assertTrue(0.9 < pause <= 1.0, pause)

    def test_a_failed_report_never_masks_the_changes_error(self):
        calls, opener = stub(lambda c: (200, {"verdict": "admit"}) if c["url"].endswith("/intents") else (500, {"error": "down"}))
        error = RuntimeError("kubectl exploded")

        def boom():
            raise error

        with self.assertRaises(RuntimeError) as raised:
            client(opener).guard(SCALE, boom)
        self.assertIs(raised.exception, error)
        self.assertEqual(error.report_error.status, 500)

    def test_a_failed_report_after_success_returns_the_result(self):
        calls, opener = stub(lambda c: (200, {"verdict": "admit"}) if c["url"].endswith("/intents") else (500, {"error": "down"}))
        told = []
        out = client(opener, on_report_error=lambda e, k: told.append((e, k))).guard(SCALE, lambda: "applied")
        self.assertEqual(out, "applied")
        self.assertEqual(told[0][0].status, 500)
        self.assertEqual(told[0][1]["agent"], "deployer")
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always", UserWarning)
            warnings.simplefilter("ignore", ResourceWarning)
            self.assertEqual(client(opener).guard(SCALE, lambda: "ok"), "ok")
        self.assertEqual(len(caught), 1)

    def test_failure_reasons_are_collapsed_and_capped(self):
        calls, opener = stub(lambda c: (200, {"verdict": "admit"}))
        with self.assertRaises(RuntimeError):
            client(opener).guard(SCALE, lambda: (_ for _ in ()).throw(RuntimeError("a\n\n  b\tc " + "x" * 3000)))
        reason = calls[-1]["body"]["reason"]
        self.assertTrue(reason.startswith("a b c xxx"))
        self.assertEqual(len(reason), 1024)

    def test_ids_are_not_burned_when_given(self):
        fw = client(lambda r, t: None)
        self.assertEqual(fw.intent({**SCALE, "id": 5})["id"], "5")
        self.assertEqual(fw._last_id, 0)

    def test_retry_after_is_waited_out_for_a_minute_at_most(self):
        for header, expected in (("3600", 60.0), ("Wed, 21 Oct 2099 07:28:00 GMT", 60.0), ("2", 2.0)):
            tries = []
            slept = []

            def opener(request, timeout, header=header):
                tries.append(1)
                if len(tries) < 2:
                    raise urllib.error.HTTPError(request.full_url, 429, "slow", {"Retry-After": header}, io.BytesIO(b"{}"))
                return Answer(b'{"verdict":"admit"}')

            fw = client(opener)
            fw._sleep = slept.append
            fw.submit(SCALE)
            self.assertEqual(slept, [expected], header)

    def test_retry_after_may_be_a_date_or_garbage(self):
        for header in ("Wed, 21 Oct 2099 07:28:00 GMT", "soon", "", "nan", "-5"):
            tries = []

            def opener(request, timeout, header=header):
                tries.append(1)
                if len(tries) < 2:
                    raise urllib.error.HTTPError(request.full_url, 429, "slow", {"Retry-After": header}, io.BytesIO(b"{}"))
                return Answer(b'{"verdict":"admit"}')

            fw = client(opener)
            fw._sleep = lambda s: None
            self.assertEqual(fw.submit(SCALE)["status"], "admit", header)

    def test_base_url_must_be_https_unless_local_and_the_key_stays_out_of_repr(self):
        for url in ("http://api.example.com", "ftp://x", "api.example.com"):
            with self.assertRaises(ValueError):
                client(None, base_url=url)
        for url in ("https://api.example.com/", "http://localhost:8787", "http://127.0.0.1:1", "http://[::1]:3"):
            client(None, base_url=url)
        self.assertNotIn("fw_test_x", repr(client(None)))

    def test_redirects_are_refused_and_the_key_is_not_forwarded(self):
        hits = []

        class Target(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                hits.append(dict(self.headers))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

            log_message = lambda *a: None  # noqa: E731

        target = http.server.HTTPServer(("127.0.0.1", 0), Target)

        class Redirect(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(307)
                self.send_header("Location", f"http://127.0.0.1:{target.server_port}/x")
                self.end_headers()

            log_message = lambda *a: None  # noqa: E731

        front = http.server.HTTPServer(("127.0.0.1", 0), Redirect)
        for server in (target, front):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            fw = Floodwall(api_key="fw_test_x", plane="p1", agent="deployer", base_url=f"http://127.0.0.1:{front.server_port}")
            with self.assertRaises(FloodwallError) as raised:
                fw.submit(SCALE)
            self.assertEqual(raised.exception.status, 307)
            self.assertEqual(hits, [])
        finally:
            for server in (target, front):
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
