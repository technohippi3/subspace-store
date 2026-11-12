"""Attended TypeScript protocol tests; no real node or wallet is used here."""
import copy
import unittest

from runner.cli import NotConfirmed, Runner
from runner.refunds import receipt
from runner.store import Refused, TypeScriptStore

GID = "g-00000000-0000-0000-0000-000000000001"
TXID = "a" * 64


def example():
    return dict(gid=GID, oid="o1", kind="cancellation", cause="buyer", phase="built",
                acknowledged=True, txid=TXID, refund_address="mock-buyer-refund",
                charged_sats=10_000, maximum_charge_sats=11_000, to_buyer_sats=9800, fee_sats=250,
                buyer_fee_sats=200, merchant_fee_sats=50, status="built", confirmations=0,
                intent_acknowledged=None, broadcast_intents=0, broadcast_result=None)


class RecordingStore(TypeScriptStore):
    def __init__(self):
        self.calls = []
        self.value = example()
        self.response = None

    def op(self, method, path, body=None):
        self.calls.append((method, path, body))
        return copy.deepcopy(self.response if method == "POST" and self.response is not None else self.value)


class AttendedRefunds(unittest.TestCase):
    def test_A44_typescript_runner_requires_cause_exact_transaction_and_confirmation(self):
        store = RecordingStore()
        runner = Runner(store, None)
        for cause in (None, "other"):
            with self.assertRaises(NotConfirmed):
                runner.refund("o1", cause=cause)
        self.assertEqual(store.calls, [])
        made = runner.refund("o1", cause="buyer")
        self.assertEqual(made["txid"], TXID)
        self.assertEqual(store.calls, [("POST", "/operator/orders/o1/refunds", {"kind": "cancellation", "cause": "buyer"})])
        store.calls.clear()
        for confirm, txid in ((None, TXID), ("g-other", TXID), (GID, None)):
            with self.assertRaises(NotConfirmed):
                runner.broadcast_refund(GID, confirm=confirm, txid=txid)
        self.assertEqual(store.calls, [])
        runner.broadcast_refund(GID, confirm=GID, txid=TXID)
        self.assertEqual(store.calls, [("GET", f"/operator/refunds/{GID}", None),
                                       ("POST", f"/operator/refunds/{GID}/broadcast", {"txid": TXID, "confirm": GID})])
        self.assertEqual(runner.refund_status(GID), example())

    def test_A45_receipts_reject_unknown_fields_bad_bindings_boolean_money_and_wrong_accounting(self):
        self.assertEqual(receipt(example(), Refused, gid=GID, oid="o1", kind="cancellation", cause="buyer"), example())
        bad = [{"raw": "00"}, {"charged_sats": True}, {"acknowledged": 1}, {"gid": "g1"}, {"oid": "o0"},
               {"maximum_charge_sats": 9999}, {"fee_sats": 251}, {"to_buyer_sats": 0}, {"charged_sats": 9999},
               {"txid": "B" * 64}, {"txid": None}, {"refund_address": None}, {"phase": "reserved"},
               {"status": "settled"}, {"broadcast_result": "accepted"}, {"intent_acknowledged": True},
               {"cause": "merchant"}, {"to_buyer_sats": "9800"}, {"extra": False}]
        for delta in bad:
            with self.subTest(delta=delta), self.assertRaises(Refused):
                receipt(dict(example(), **delta), Refused)
        for binding in ({"gid": GID[:-1] + "2"}, {"oid": "o2"}, {"kind": "excess"}, {"cause": "merchant"}):
            with self.assertRaises(Refused):
                receipt(example(), Refused, **binding)
        pending = dict(example(), phase="reserved", txid=None, to_buyer_sats=None, fee_sats=None,
                       buyer_fee_sats=None, merchant_fee_sats=None, status="reserved", acknowledged=False)
        self.assertEqual(receipt(pending, Refused)["phase"], "reserved")

    def test_A46_client_never_sends_with_stale_unacknowledged_or_malformed_receipts_and_never_falls_back(self):
        for delta in ({"txid": "b" * 64}, {"acknowledged": False}, {"extra": True}):
            store = RecordingStore()
            store.value.update(delta)
            with self.assertRaises(Refused):
                store.broadcast(GID, TXID)
            self.assertEqual(len(store.calls), 1)
            self.assertEqual(store.calls[0][0], "GET")
        store = RecordingStore()
        for gid, txid in (("g1", TXID), (GID, None), (GID, ""), (GID, True)):
            with self.assertRaises(Refused):
                store.broadcast(gid, txid)
        self.assertEqual(store.calls, [])
        store.response = dict(example(), txid="b" * 64)
        with self.assertRaises(Refused):
            store.broadcast(GID, TXID)
        self.assertEqual(len(store.calls), 2)
        self.assertTrue(all("transition" not in call[1] for call in store.calls))


if __name__ == "__main__":
    unittest.main()
