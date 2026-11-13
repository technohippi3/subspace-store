"""Unrelated staging faults preserve sent-batch guards and observation."""
import unittest
from controller.errors import Refused
from controller.preparation_history import PreparationBarrier
from controller.rpc import HttpError
from tests import test_commitment_tracking as tracking_fixture
from tests import test_bound_certificates as certificate_fixture


class PreparationAvailability(unittest.TestCase):
    tracking_world = tracking_fixture.CommitmentTracking.world
    certificate_world = certificate_fixture.Certificates.world
    verifier = certificate_fixture.Certificates.verifier

    def hold(self, w, members=None):
        barrier = PreparationBarrier(w.journal)
        b = dict(bid="b2", space="@other", members=members or ["o3"], digest="d" * 64)
        barrier.acquire(b)
        def failed(): raise HttpError("POST", "/registry/sync", 503, "recording partial sync failure")
        with self.assertRaises(HttpError): barrier.effect(b, "sync", [], failed)

    def test_watch_advances_and_observes_reorg_while_an_unrelated_sync_is_unknown(self):
        w = self.tracking_world(); self.hold(w)
        self.assertEqual(w.c.watch("b1"), "final")
        self.facts["rootHeight"] = None
        self.assertEqual(w.c.watch("b1"), "mined")
        self.assertEqual(len(self.calls), 2)
        with self.assertRaisesRegex(Refused, "reconciliation"): w.c.freeze("@third")

    def test_certificate_delivery_keeps_verifier_chain_and_store_acknowledgment_guards(self):
        w = self.certificate_world()
        w.c._save("b1", txid="a" * 64, delegate_in="d" * 64 + ":0")
        self.hold(w)
        with self.verifier(): self.assertTrue(w.c.verify_certificates("b1")["o1"]["stored"])
        self.answer["verified"] = False
        with self.verifier(): self.assertFalse(w.c.verify_certificates("b1")["o1"]["ok"])
        self.assertEqual(len(self.calls), 1)
        self.answer["verified"] = True
        self.facts["tipHash"] = "f" * 64
        # A changed observation is checked against freshly fetched status.
        w.commitment_status = lambda b: dict(revision=1, acknowledged=True, observation=dict(self.facts, tipHash="e" * 64, covered=True))
        with self.verifier():
            with self.assertRaisesRegex(Refused, "chain changed"): w.c.verify_certificates("b1")
        self.assertEqual(len(self.calls), 1)

    def test_identical_bytes_can_be_captured_and_rebroadcast_but_changed_bytes_still_refuse(self):
        w = self.tracking_world(); self.hold(w)
        del w.c.capture_bytes
        calls = []
        class Core:
            def call(self, method, *args):
                if method == "getrawtransaction": return {"vin": []} if len(args) > 1 else "010203"
                if method == "getrawmempool": return []
                if method == "sendrawtransaction": calls.append(args[0]); return "c" * 64
                raise AssertionError(method)
        w.c.clients.btc = Core
        w.c.tx_position = lambda txid: None
        w.entry_status = lambda b: dict(found=True, acknowledged=True, phase="armed", delegate=b["delegate_in"])
        self.assertTrue(w.c.capture_bytes("b1"))
        self.assertEqual(w.c.rebroadcast_commitment("b1"), "c" * 64)
        self.assertEqual(calls, ["010203"])
        w.c._save("b1", journal=False, raw="040506")
        with self.assertRaisesRegex(Refused, "journaled commitment bytes"): w.c.rebroadcast_commitment("b1")
        self.assertEqual(calls, ["010203"])

    def test_overlap_unacknowledged_binding_restore_and_journal_outage_still_block_sent_work(self):
        for fault in ("overlap", "unacknowledged", "restore", "journal"):
            w = self.tracking_world(); self.hold(w, ["o1"] if fault == "overlap" else None)
            if fault == "unacknowledged": w.c._save("b1", journal=False, txid="f" * 64)
            elif fault == "restore": w.c.recovery_state = lambda: "incomplete"
            elif fault == "journal": w.journal.set_down(True)
            with self.assertRaises(Refused): w.c.watch("b1")
            self.assertEqual(self.calls, [])
