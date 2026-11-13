"""The regtest harness's publication comparisons, without the regtest stack.

A publication step must disagree with the model when `/publish` was called
and the model allowed no call (an empty chunk, or a batch whose certificates
don't verify), when it wasn't called and the model allowed one, and when the
answer or the handles read back as "final" differ. A delivery step must
disagree when the confirmation or the order's status differs. Delivery must
also wait while the root the relay's answer carries is below d >= 150 or no
anchor covers it, even when the batch's own root is final (L9, R24). This
tests harness code only, with stubbed spaced, relay and verifier answers: it
is neither model nor regtest evidence about the store.
"""

import pathlib
import sqlite3
import tempfile
import unittest

from controller.core import Controller
from controller.journal import Journal
from controller.preparation_history import require_idle
from regtest.harness import compare
from regtest.harness.publication import SCHEMA, Publisher

CALLED = {"called": True, "chunk": 1, "response": {"handles_published": 1, "remaining": 0},
          "final": ["o1"]}
ALLOWED = {"ok": True, "count": 1, "published": ["o1"]}


class Publish(unittest.TestCase):
    def test_a_call_agrees_with_an_allowed_chunk(self):
        self.assertTrue(compare.same_publish(CALLED, ALLOWED))

    def test_each_field_of_a_call_matters(self):
        for key, value in (("chunk", 2), ("response", {"handles_published": 0, "remaining": 1}),
                           ("final", [])):
            with self.subTest(key=key):
                self.assertFalse(compare.same_publish(dict(CALLED, **{key: value}), ALLOWED))
        self.assertFalse(compare.same_publish(CALLED, dict(ALLOWED, published=[])))
        self.assertFalse(compare.same_publish(CALLED, dict(ALLOWED, count=2)))

    def test_an_empty_chunk_is_never_a_call(self):
        empty = {"ok": True, "count": 0, "published": []}
        self.assertTrue(compare.same_publish({"called": False}, empty))
        self.assertFalse(compare.same_publish(dict(CALLED, chunk=0, final=[]), empty))

    def test_a_refused_publish_must_not_be_a_call(self):
        refused = {"ok": False, "count": 0, "published": []}
        self.assertTrue(compare.same_publish({"called": False, "why": "live check"}, refused))
        self.assertFalse(compare.same_publish(CALLED, refused))
        self.assertFalse(compare.same_publish({"called": False}, ALLOWED))


class Delivery(unittest.TestCase):
    def test_confirmation_and_status_both_matter(self):
        got = {"confirmed": True, "status": "fulfilled"}
        exp = {"ok": True, "status": "fulfilled"}
        self.assertTrue(compare.same_delivery(got, exp))
        self.assertFalse(compare.same_delivery(dict(got, confirmed=False), exp))
        self.assertFalse(compare.same_delivery(got, dict(exp, status="ready")))
        self.assertTrue(compare.same_delivery({"confirmed": False, "status": "ready"},
                                              {"ok": False, "status": "ready"}))


SPACE, HANDLE, SPK = "@test10000", "one@test10000", "5120" + "ab" * 32
R1, R2 = "11" * 32, "22" * 32  # made-up roots
H1 = 1000


class FakeController:
    """spaced and Bitcoin Core as the delivery check reads them."""

    def __init__(self, workdir):
        self.workdir = workdir
        self.verifier_bin = "unused"
        self.tip_h = H1 + 748
        self.anchor = H1 + 740
        self.commitments = {R1: H1}
        self.live = R1
        self.alerts = []
        self.journal = Journal(workdir / "controller-journal", "controller")

    def require_restored(self):
        # This chain-only fixture has no recovery transaction. Its preparation
        # history is real and controllable; it provides no process-lock evidence.
        require_idle(self.journal)

    def batch(self, bid):
        return {"space": SPACE, "root": R1, "txid": "made-up-txid", "mined_height": H1}

    def wait_synced(self):
        pass

    def onchain_commitment(self, space, root=None):
        r = root or self.live
        h = self.commitments.get(r)
        return {"state_root": r, "block_height": h} if h is not None else None

    def tx_position(self, txid):
        return H1, self.tip_h - H1

    def root_anchors(self):
        return [{"block": {"height": self.anchor}}]

    def tip(self):
        return self.tip_h

    def alert(self, *a):
        self.alerts.append(a)

    # The controller's own root gate, over this fake chain.
    root_gate = Controller.root_gate
    _on_chain_at = Controller._on_chain_at


class FakeRegistry:
    def __init__(self):
        self.status = "ready"

    def order(self, oid):
        return {"name": HANDLE, "recipient_spk": SPK, "status": self.status}

    def mark_fulfilled(self, oid):
        self.status = "fulfilled"


class FakeJournal:
    def append(self, *a, **k):
        pass


class FakeRelay:
    def get(self, path, raw=False):
        return b"made-up relay message"


class DeliveryRootGate(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.c = FakeController(pathlib.Path(tmp.name))
        self.reg = FakeRegistry()
        p = Publisher.__new__(Publisher)
        p.c, p.reg, p.journal, p.relay, p.calls = self.c, self.reg, FakeJournal(), FakeRelay(), []
        p.db = sqlite3.connect(":memory:", isolation_level=None)
        p.db.row_factory = sqlite3.Row
        p.db.executescript(SCHEMA)
        p.db.execute("insert into publication(bid, oid, handle, state, publish_status) "
                     "values ('b1', 'o1', ?, 'published', 'final')", (HANDLE,))
        self.served = (R1, H1)
        p.verify_message = lambda msg, anchors: {"verified": True, "zones": [
            {"handle": HANDLE, "script_pubkey": SPK,
             # As libveritas answers: pending until an anchor covers the root.
             "sovereignty": "sovereign" if self.c.anchor - self.served[1] >= 144 else "pending"},
            {"handle": SPACE, "commitment_root": self.served[0],
             "commitment_height": self.served[1]}]}
        self.p = p

    def later_commitment(self, depth):
        h2 = self.c.tip_h - depth
        self.c.commitments[R2] = h2
        self.c.live = R2
        self.served = (R2, h2)
        return h2

    def test_a_later_root_below_finality_or_coverage_waits(self):
        # The batch's own root is at depth 748 and covered; the certificate
        # was built on a later root at depth 149, and libveritas answers
        # "pending" for it (as on regtest, run combined-20261107T145828Z-92636d).
        h2 = self.later_commitment(149)
        res = self.p.confirm_delivery("b1", "o1")
        self.assertTrue(self.p.live_check("b1")["ok"])
        self.assertFalse(res["confirmed"])
        self.assertTrue(res["waiting"])
        self.assertIn("d = 149", res["why"])
        self.assertEqual(self.reg.status, "ready")
        # At d = 150, but the newest anchor is only 141 past the later root.
        self.c.tip_h += 1
        res = self.p.confirm_delivery("b1", "o1")
        self.assertFalse(res["confirmed"])
        self.assertIn("anchor", res["why"])
        self.assertEqual(self.c.anchor - h2, 141)
        self.assertEqual(self.reg.status, "ready")
        # Waiting is not a failure: nothing was alerted.
        self.assertEqual(self.c.alerts, [])
        # Both gates pass.
        self.c.anchor = h2 + 144
        res = self.p.confirm_delivery("b1", "o1")
        self.assertTrue(res["confirmed"])
        self.assertEqual(self.reg.status, "fulfilled")
        self.assertFalse(res["lookup"]["root_is_the_batchs"])

    def test_the_batchs_own_root_is_delivered_while_a_later_one_is_young(self):
        # Built before the later commitment, the certificate carries the
        # batch's root, which is final and covered.
        self.later_commitment(149)
        self.served = (R1, H1)
        res = self.p.confirm_delivery("b1", "o1")
        self.assertTrue(res["confirmed"])
        self.assertFalse(res["lookup"]["root_is_live"])

    def test_a_root_that_is_not_on_chain_is_refused_and_alerted(self):
        self.served = (R2, H1 + 600)
        res = self.p.confirm_delivery("b1", "o1")
        self.assertFalse(res["confirmed"])
        self.assertNotIn("waiting", res)
        self.assertEqual(self.c.alerts, [("delivery_unconfirmed", "b1", "o1")])
        self.assertEqual(self.reg.status, "ready")


if __name__ == "__main__":
    unittest.main()
