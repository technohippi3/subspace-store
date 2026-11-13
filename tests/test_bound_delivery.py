"""Shipped publisher ordering with recording registry/chain stand-ins."""
import tempfile
import unittest
from pathlib import Path

from controller.errors import Refused
from controller.journal import Journal
from controller.publication import Publisher
from runner.store import Refused as StoreRefused, TypeScriptStore
from tests.test_regtest_publication import FakeController, FakeRegistry, H1, R1


class BoundDelivery(unittest.TestCase):
    def world(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        c, reg = FakeController(root), FakeRegistry()
        batch = c.batch
        c.batch = lambda bid: dict(batch(bid), bid=bid, members=["o1"], entry_key="1" * 32, delegate_in="d" * 64 + ":0")
        self.facts = dict(txid="a" * 64, tipHeight=c.tip_h, tipHash="b" * 64, minedHeight=H1, rootHeight=H1, anchorHeight=c.anchor)
        c._commitment_observation = lambda b: dict(self.facts)
        c.watch = lambda bid: "final"
        c.handle = lambda *args: {"publish_status": "final"}
        reg.bound_entries = True
        reg.commitment_status = lambda b: dict(acknowledged=True, revision=1, observation=dict(self.facts, covered=True))
        reg.delivery_status = lambda b, oid: dict(acknowledged=True, revision=1, certificateHash="c" * 64)
        self.calls, self.posts, self.ack = [], [], True
        class Subs:
            def post(inner, path, body):
                self.posts.append(path)
                return {"handles_published": 1}
        journal = Journal(root / "journal", "runner")
        c.journal = journal
        p = Publisher(c, reg, journal, root / "publication.db", Subs(), "http://127.0.0.1:9")
        self.addCleanup(p.db.close)
        p.lookup = lambda bid, oid: dict(ok=True, sovereignty="sovereign", root_gate={"ok": True},
                                        space_zone=dict(commitment_root=R1, commitment_height=H1), proof_hash="d" * 64)
        def fulfill(*args):
            self.assertEqual(p.row("b1", "o1")["state"], "published")
            self.calls.append(args)
            return dict(acknowledged=self.ack)
        reg.fulfill_order = fulfill
        p.enroll("b1")
        return p, reg, journal

    def test_A40_publication_and_verified_lookup_precede_store_fulfillment(self):
        p, reg, journal = self.world()
        self.assertFalse(p.confirm_delivery("b1", "o1")["confirmed"])
        self.assertEqual(self.calls, [])
        p.publish("b1", ["o1"])
        self.assertTrue(p.confirm_delivery("b1", "o1")["confirmed"])
        self.assertEqual(p.row("b1", "o1")["state"], "delivered")
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(any(e["kind"] == "verified_delivery" for e in journal.entries()))

    def test_A41_journal_outage_and_negative_acknowledgment_never_mark_local_delivery_complete(self):
        p, reg, journal = self.world()
        p.publish("b1", ["o1"])
        journal.set_down(True)
        with self.assertRaisesRegex(Refused, "preparation journal unavailable"):
            p.confirm_delivery("b1", "o1")
        self.assertEqual(self.calls, [])
        journal.set_down(False); self.ack = False
        with self.assertRaisesRegex(Refused, "not acknowledged"):
            p.confirm_delivery("b1", "o1")
        self.assertEqual(p.row("b1", "o1")["state"], "published")
        self.ack = True; self.assertTrue(p.confirm_delivery("b1", "o1")["confirmed"])

    def test_A42_delivery_client_rejects_malformed_status_and_completion_without_fallback(self):
        store = TypeScriptStore("http://127.0.0.1:9", "mock-token", "mock-db", "mock-journal")
        b = dict(entry_key="1" * 32, root=R1, members=["o1"], delegate_in="d" * 64 + ":0")
        good = dict(oid="o1", entry=b["entry_key"], revision=1, certificateHash="c" * 64, fulfilled=False, acknowledged=True)
        for change in (dict(acknowledged=1), dict(revision=True), dict(certificateHash=None), dict(entry="2" * 32)):
            store.op = lambda *args: dict(good, **change)
            with self.assertRaises(StoreRefused):
                store.delivery_status(b, "o1")
        for reply in ({}, dict(oid="o1", entry=b["entry_key"], fulfilled=1, acknowledged=True),
                      dict(oid="o2", entry=b["entry_key"], fulfilled=True, acknowledged=True)):
            paths = []
            store.op = lambda method, path, body: paths.append(path) or reply
            with self.assertRaises(StoreRefused):
                store.fulfill_order(b, 1, "o1", "c" * 64, R1, H1, "d" * 64)
            self.assertEqual(paths, ["/operator/fulfillments"])

    def test_A43_invalid_chunks_and_changed_chain_withhold_publication(self):
        p, reg, journal = self.world()
        self.assertFalse(p.publish("b1", [])["called"])
        for chunk in (["o2"], ["o1", "o1"]):
            with self.assertRaises(Refused):
                p.publish("b1", chunk)
        original = dict(self.facts)
        p.c._commitment_observation = lambda b: dict(original, tipHash="f" * 64)
        with self.assertRaisesRegex(Refused, "chain changed"):
            p.publish("b1", ["o1"])
        self.assertEqual(self.posts, [])
