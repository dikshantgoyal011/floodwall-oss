import importlib.util
import unittest
import urllib.error

from floodwall.langgraph import guard_node, guarded_tool

from .test_client import client, stub

CHANGE = lambda deployment, replicas: {  # noqa: E731
    "action": {"kind": "scale", "resource": deployment, "replicas": replicas},
    "context": "- replicas: 1\n+ replicas: %d" % replicas,
}


def refuse_connection(call):
    raise urllib.error.URLError("connection refused")


class GuardedToolTest(unittest.TestCase):
    def test_admitted_runs_and_reports(self):
        calls, opener = stub(lambda c: (200, {"verdict": "admit"}))
        ran = []
        tool = guarded_tool(client(opener), lambda d, r: ran.append((d, r)) or "scaled", CHANGE, name="scale")
        self.assertEqual(tool("web", 3), "done: scaled")
        self.assertEqual(ran, [("web", 3)])
        self.assertEqual(calls[0]["body"]["context"], "- replicas: 1\n+ replicas: 3")
        self.assertEqual(calls[1]["body"]["outcome"], "succeeded")
        self.assertEqual(tool.__name__, "scale")

    def test_held_and_rejected_come_back_as_text_and_do_not_run(self):
        for verdict, word in (("defer", "held"), ("reject", "refused")):
            calls, opener = stub(lambda c, v=verdict: (200, {"verdict": v, "reason": "policy says no"}))
            fw = client(opener)
            tool = guarded_tool(fw, lambda d, r: self.fail("ran"), CHANGE, timeout_seconds=0)
            message = tool("web", 3)
            self.assertIn(word, message)
            self.assertIn("policy says no", message)

    def test_unreachable_plane_fails_closed(self):
        calls, opener = stub(refuse_connection)
        tool = guarded_tool(client(opener), lambda d, r: self.fail("ran"), CHANGE)
        self.assertIn("not run", tool("web", 3))

    def test_the_tools_own_error_is_reported_and_raised(self):
        calls, opener = stub(lambda c: (200, {"verdict": "admit"}))

        def boom(d, r):
            raise RuntimeError("kubectl exploded")

        with self.assertRaises(RuntimeError):
            guarded_tool(client(opener), boom, CHANGE)("web", 3)
        self.assertEqual(calls[-1]["body"]["outcome"], "failed")


class RanThenFailedTest(unittest.TestCase):
    def test_an_error_after_the_tool_ran_is_raised_not_reported_as_not_run(self):
        from floodwall import FloodwallError

        calls, opener = stub(lambda c: (200, {"verdict": "admit"}))

        def late(d, r):
            raise FloodwallError(503, "the tool's own call failed")

        with self.assertRaises(FloodwallError):
            guarded_tool(client(opener), late, CHANGE)("web", 3)
        self.assertEqual(calls[-1]["body"]["outcome"], "failed")
        node = guard_node(client(opener), apply=lambda s: late(1, 2))
        with self.assertRaises(FloodwallError):
            node({"proposed_change": CHANGE("web", 2)})


class GuardNodeTest(unittest.TestCase):
    def test_admitted_node_writes_a_done_update(self):
        calls, opener = stub(lambda c: (200, {"verdict": "admit"}))
        node = guard_node(client(opener), apply=lambda state: "applied " + state["proposed_change"]["action"]["resource"])
        update = node({"proposed_change": CHANGE("web", 2)})
        self.assertEqual(update["floodwall"]["status"], "done")
        self.assertEqual(update["floodwall"]["result"], "applied web")

    def test_rejected_and_unreachable_do_not_apply(self):
        calls, opener = stub(lambda c: (200, {"verdict": "reject", "reason": "no destroys"}))
        node = guard_node(client(opener), apply=lambda s: self.fail("ran"))
        self.assertEqual(node({"proposed_change": CHANGE("web", 2)})["floodwall"]["status"], "rejected")
        calls, opener = stub(refuse_connection)
        node = guard_node(client(opener), apply=lambda s: self.fail("ran"))
        self.assertEqual(node({"proposed_change": CHANGE("web", 2)})["floodwall"]["status"], "unavailable")

    def test_missing_change_does_not_apply(self):
        calls, opener = stub(lambda c: (200, {"verdict": "admit"}))
        node = guard_node(client(opener), apply=lambda s: self.fail("ran"))
        self.assertEqual(node({})["floodwall"]["status"], "unavailable")
        self.assertEqual(calls, [])

    @unittest.skipIf(importlib.util.find_spec("langgraph") is None, "langgraph is not installed")
    def test_on_refused_routes_with_a_command(self):
        from langgraph.types import Command

        calls, opener = stub(lambda c: (200, {"verdict": "reject", "reason": "no"}))
        node = guard_node(client(opener), apply=lambda s: None, on_refused="explain")
        out = node({"proposed_change": CHANGE("web", 2)})
        self.assertIsInstance(out, Command)
        self.assertEqual(out.goto, "explain")


if __name__ == "__main__":
    unittest.main()
