"""The attended runner's own rules (PAYMENT-SPEC.md, "Checkout and the
attended runner").

The `test_A*` tests are the runner cases A1 to A5. They run the runner
against recording stand-ins for the store and the controller, so they show
what the runner calls and refuses, not what the store or the chain does.
They are neither model results nor regtest evidence; the regtest
demonstration is scenario 10 (`regtest/run-checkout.sh`).
"""

import tempfile
import unittest
from pathlib import Path

from runner.cli import NotConfirmed, Runner


class FakeController:
    def __init__(self, state="checkpointed", results=None):
        self.calls = []
        self.state = state
        self.results = results or {}
        self.subs = self

    def batch(self, bid):
        return {"bid": bid, "space": "@space", "members": ["o1", "o2"], "state": self.state,
                "txid": "made-up-txid" if self.state == "broadcast" else None,
                "root": "made-up-root", "mined_height": 100}

    def issue(self, bid, fee_rate):
        self.calls.append(("issue", bid, fee_rate))
        self.state = "broadcast"
        return bid

    def restore_pending(self):
        return None

    def recovery_state(self):
        return None

    def post(self, path, body=None):
        self.calls.append(("subs", path))
        return {}

    def verify_certificates(self, bid):
        self.calls.append(("verify", bid))
        return self.results


class FakeStore:
    def __init__(self):
        self.calls = []

    def broadcast(self, gid, txid=None):
        self.calls.append(("broadcast", gid))
        return {"gid": gid, "acknowledged": True}

    def deliver_certificate(self, oid, message):
        self.calls.append(("deliver", oid, message))
        return {"delivered": True}


class AttendedRunner(unittest.TestCase):
    def test_A1_issue_needs_the_batch_id_confirmed(self):
        for given, ask in ((None, None), ("b2", None), (None, lambda prompt: "b2"),
                           ("", None), (" b1", None)):
            with self.subTest(given=given, asked=ask is not None):
                c, s = FakeController(), FakeStore()
                with self.assertRaises(NotConfirmed) as e:
                    Runner(s, c, ask=ask).issue("b1", 1, given)
                self.assertIn("nothing was sent", str(e.exception))
                self.assertEqual((c.calls, s.calls, c.state), ([], [], "checkpointed"))
        # A batch that isn't checkpointed is refused before anything is asked.
        c = FakeController(state="proved")
        asked = []
        with self.assertRaises(NotConfirmed):
            Runner(FakeStore(), c, ask=asked.append).issue("b1", 1, "b1")
        self.assertEqual((c.calls, asked), ([], []))

    def test_A2_broadcast_refund_needs_the_group_id_confirmed(self):
        for given, ask in ((None, None), ("g2", None), (None, lambda prompt: "g2"),
                           ("G1", None)):
            with self.subTest(given=given, asked=ask is not None):
                s = FakeStore()
                with self.assertRaises(NotConfirmed):
                    Runner(s, FakeController(), ask=ask).broadcast_refund("g1", given)
                self.assertEqual(s.calls, [])

    def test_A3_certify_delivers_only_verified_certificates(self):
        with tempfile.TemporaryDirectory() as d:
            art = Path(d)
            (art / "one@space.message.bin").write_bytes(b"made-up certificate one")
            (art / "two@space.message.bin").write_bytes(b"made-up certificate two")
            checks_ok = {"verified": True, "handle": True, "script_pubkey": True, "root": True,
                         "root_height": True, "sovereign": True}
            results = {
                "o1": {"handle": "one@space", "ok": True, "checks": checks_ok,
                       "artifacts": str(art)},
                "o2": {"handle": "two@space", "ok": False,
                       "checks": dict(checks_ok, script_pubkey=False), "artifacts": str(art)},
            }
            c, s = FakeController(state="final", results=results), FakeStore()
            out = Runner(s, c).certify("b1")
        self.assertEqual(s.calls, [("deliver", "o1", b"made-up certificate one")])
        self.assertEqual((out["members"]["o1"]["delivered"], out["members"]["o2"]["delivered"]),
                         (True, False))
        self.assertFalse(out["members"]["o2"]["verified"])
        self.assertIn(("verify", "b1"), c.calls)

    def test_A4_issue_with_the_batch_id_confirmed_runs_once(self):
        for given, ask in (("b1", None), (None, lambda prompt: "b1")):
            with self.subTest(asked=ask is not None):
                c = FakeController()
                out = Runner(FakeStore(), c, ask=ask).issue("b1", 3, given)
                self.assertEqual(c.calls, [("issue", "b1", 3)])
                self.assertEqual((out["bid"], out["state"]), ("b1", "broadcast"))

    def test_A5_broadcast_refund_with_the_group_id_confirmed_runs_once(self):
        for given, ask in (("g1", None), (None, lambda prompt: "g1\n")):
            with self.subTest(asked=ask is not None):
                s = FakeStore()
                Runner(s, FakeController(), ask=ask).broadcast_refund("g1", given)
                self.assertEqual(s.calls, [("broadcast", "g1")])


if __name__ == "__main__":
    unittest.main()
