"""Certificate verification and delivery to the order page, on the batch's
own root or on a later root of the same space (PAYMENT-SPEC.md, case A19;
CONTROLLER-DESIGN.md, "Certificate verification").

The `test_A19_*` tests run the runner's `certify` and the controller's
verification against stand-ins for subs, spaced, bitcoind and the store,
with a stand-in verifier that prints the libveritas verdict each test
chooses. They show which certificates the controller accepts, delivers,
waits on or refuses, not what libveritas or subs does. They are neither
model results nor regtest evidence; the regtest demonstration is scenario
11 (`regtest/run-recovery.sh`).
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

from controller.core import Clients, Controller
from controller.journal import Journal
from runner.cli import Runner

SPACE = "@a"
HANDLE, SPK = "one@a", "5120" + "ab" * 32
OTHER_SPK = "5120" + "cd" * 32
R1, R2, R3, R0 = "11" * 32, "22" * 32, "33" * 32, "00" * 32  # made-up roots
H1, H2 = 1000, 1200


class Rpc:
    def __init__(self, answers):
        self.answers = answers

    def call(self, method, *params):
        a = self.answers[method]
        return a(*params) if callable(a) else a


class World:
    def __init__(self):
        self.tip = 1400
        self.anchor = 1368  # 1368 - 1200 = 168 >= 144
        # The space's commitments on the chain: an earlier one, the
        # batch's, and a later one.
        self.history = {R0: H1 - 100, R1: H1, R2: H2}
        self.verdicts = {}  # handle -> what the verifier prints
        self.delivered = []
        self.ready = []
        self.status = "fulfilled"
        self.btc = Rpc({"getblockcount": lambda: self.tip})
        self.spaced = Rpc({"getrootanchors": lambda: [{"block": {"height": self.anchor}}],
                           "getcommitment": self.commitment})

    def commitment(self, space, root=None):
        h = self.history.get(root)
        return {"state_root": root, "block_height": h} if h is not None else None

    def subs(self):
        world = self

        class Subs:
            def get(self, path, raw=False, **kw):
                handle = path.split("/")[2]
                return json.dumps(world.verdicts[handle]).encode()

            def post(self, path, body=None, **kw):
                return {}
        return Subs()

    # The store, as the controller and the runner use it

    def order(self, oid):
        return {"name": HANDLE, "recipient_spk": SPK, "status": self.status}

    def mark_ready(self, oid):
        self.ready.append(oid)

    def deliver_certificate(self, oid, message):
        self.delivered.append((oid, message))


def verdict(root=R1, height=H1, handle=HANDLE, spk=SPK, verified=True,
            sovereignty="sovereign"):
    """What libveritas reports for a certificate: the handle's zone and the
    space's zone, with the root the certificate was built on."""
    return {"verified": verified,
            "zones": [{"handle": handle, "script_pubkey": spk, "sovereignty": sovereignty},
                      {"handle": SPACE, "commitment_root": root, "commitment_height": height}]}


class Certify(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        verifier = self.tmp / "verifier"
        verifier.write_text(f"#!{sys.executable}\nimport sys\n"
                            "print(open(sys.argv[1]).read())\n")
        verifier.chmod(0o755)
        self.w = World()
        self.c = Controller(self.tmp / "controller.db", Journal(self.tmp / "offhost", "runner"),
                            self.w, Clients(self.w.subs, self.w.subs, lambda: self.w.spaced,
                                            lambda: self.w.btc),
                            None, verifier, self.tmp / "certs", "made-up-wallet")
        self.addCleanup(self.c.close)
        self.c.db.execute("insert into batches(bid, space, members, digest, state, root, "
                          "mined_height, txid) values ('b1', ?, '[\"o1\"]', 'made-up-digest', "
                          "'final', ?, ?, 'made-up-txid')", (SPACE, R1, H1))

    def certify(self, **kw):
        self.w.verdicts[HANDLE] = verdict(**kw)
        self.w.delivered.clear()
        before = len(self.c.alerts())
        out = Runner(self.w, self.c).certify("b1")["members"]["o1"]
        return out, len(self.c.alerts()) - before

    def test_A19_a_certificate_on_the_batch_s_own_root_is_delivered(self):
        out, alerts = self.certify()
        self.assertEqual((out["verified"], out["delivered"], alerts), (True, True, 0))
        self.assertEqual([oid for oid, _ in self.w.delivered], ["o1"])
        # A fulfilled order keeps its status; an issuing one becomes ready.
        self.assertEqual(self.w.ready, [])
        self.w.status = "issuing"
        self.certify()
        self.assertEqual(self.w.ready, ["o1"])

    def test_A19_a_certificate_on_a_later_final_covered_root_is_delivered(self):
        out, alerts = self.certify(root=R2, height=H2)
        self.assertEqual((out["verified"], out["delivered"], alerts), (True, True, 0))
        self.assertTrue(all(out["checks"].values()))
        self.assertEqual(self.w.delivered[0][1], json.dumps(verdict(root=R2, height=H2)).encode())

    def test_A19_a_later_root_not_yet_final_or_covered_waits(self):
        for tip, anchor in ((1349, 1368), (1400, 1332)):  # d = 149; anchor 132 past it
            with self.subTest(tip=tip, anchor=anchor):
                self.w.tip, self.w.anchor = tip, anchor
                out, alerts = self.certify(root=R2, height=H2, sovereignty="pending")
                self.assertEqual((out["verified"], out["delivered"], alerts), (False, False, 0))
                self.assertEqual(self.w.delivered, [])
        # Once it is, the same certificate is delivered.
        self.w.tip, self.w.anchor = 1400, 1368
        out, alerts = self.certify(root=R2, height=H2)
        self.assertTrue(out["delivered"])

    def test_A19_a_dependent_certificate_on_a_waiting_later_root_is_alerted(self):
        # Dependent is a failure, not pending finality: under either waiting
        # condition it is refused and alerted, never left to wait.
        for tip, anchor in ((1349, 1368), (1400, 1332)):  # d = 149; anchor 132 past it
            with self.subTest(tip=tip, anchor=anchor):
                self.w.tip, self.w.anchor = tip, anchor
                out, alerts = self.certify(root=R2, height=H2, sovereignty="dependent")
                self.assertEqual((out["verified"], out["delivered"], alerts), (False, False, 1))
                self.assertEqual(self.w.delivered, [])

    def test_A19_a_certificate_that_fails_a_check_is_refused_and_alerted(self):
        cases = {
            "doesn't verify": dict(verified=False),
            "another handle": dict(handle="two@a"),
            "another recipient": dict(spk=OTHER_SPK),
            "another recipient on a later root": dict(root=R2, height=H2, spk=OTHER_SPK),
            "not sovereign": dict(sovereignty="pending"),
            "dependent": dict(sovereignty="dependent"),
            "dependent on a later final covered root": dict(root=R2, height=H2,
                                                            sovereignty="dependent"),
            "a later root not on the chain": dict(root=R3, height=H2),
            "a later root at another height": dict(root=R2, height=H2 + 1),
            "an earlier root, on the chain": dict(root=R0, height=H1 - 100),
            "the batch's root at another height": dict(root=R1, height=H1 + 1),
        }
        for what, kw in cases.items():
            with self.subTest(what):
                out, alerts = self.certify(**kw)
                self.assertEqual((out["verified"], out["delivered"], alerts), (False, False, 1))
                self.assertEqual(self.w.delivered, [])
        # A later root, final and covered, while the batch's own root has left
        # the chain: refused too.
        del self.w.history[R1]
        out, alerts = self.certify(root=R2, height=H2)
        self.assertEqual((out["delivered"], alerts), (False, 1))


if __name__ == "__main__":
    unittest.main()
