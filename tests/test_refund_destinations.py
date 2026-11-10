"""Refund destinations (PAYMENT-SPEC.md, "Refunds"): the cases T1 to T4.

A refund address is never one of the store's payment addresses, and a
quote never takes a payment address that an order holds as its refund
address. The model has no refund addresses, so these are the service's API
tests over a simulated chain: neither model results nor regtest evidence.
"""

import tempfile
import unittest
from pathlib import Path

from model.chain import Chain, Tx
from service.app import Service
from service.journal import Journal
from service.ledger import Ledger, Policy
from tests.service_twin import ModelChainView, recipient
from tests.test_service_api import OPERATOR, SUBS, Client

PRICE = 10_000
PAYMENT_ADDRESSES = "a refund never goes to one of the store's payment addresses"


class RefundDestinations(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.chain = Chain()
        self.view = ModelChainView(self.chain)
        self.n = 0
        # The wallet's next scripts, when a test fixes them; otherwise fresh.
        self.next_scripts = []
        self.view.new_destination = self._destination
        # An address given through the order link names its script directly.
        self.view.refund_script = lambda address: address.removeprefix("script:")
        self.now = [0.0]
        ledger = Ledger(Path(tmp.name) / "store.db", self.view, Journal(Path(tmp.name) / "offhost"),
                        Policy(), clock=lambda: self.now[0])
        self.service = Service(ledger, self.view, OPERATOR, SUBS, 1_000_000, poll_seconds=3600)
        self.service.start()
        self.service.serve("127.0.0.1", 0)
        self.addCleanup(lambda: (self.service.shutdown(), ledger.close()))
        self.c = Client(self.service.server.server_address[1])
        self.led = ledger

    def _destination(self, oid):
        self.n += 1
        script = self.next_scripts.pop(0) if self.next_scripts else recipient(f"dest-{self.n}")
        return f"dest-{self.n}", script

    def op(self, method, path, body=None):
        return self.c.call(method, path, body, OPERATOR)

    def list(self, *handles):
        for h in handles:
            self.assertEqual(self.op("POST", "/operator/names", {"handle": h, "price": PRICE})[0],
                             200)

    def order(self, handle, quote=True):
        """Returns (oid, order link)."""
        code, r = self.c.call("POST", "/requests",
                              {"handle": handle, "script_pubkey": recipient("buyer/" + handle)})
        self.assertEqual(code, 201)
        if quote:
            self.assertEqual(self.c.call("POST", r["order_link"] + "/quote")[0], 200)
        return self.led.order_by_token(r["token"]), r["order_link"]

    def refund_to(self, link, script):
        return self.c.call("POST", link + "/refund-address", {"address": "script:" + script})

    def payment_script(self, oid):
        return self.led.operator_view(oid)["dest_script"]

    def refund_script(self, oid):
        return self.led.operator_view(oid)["refund_spk"]

    def test_T1_a_payment_address_is_never_a_refund_address(self):
        self.list("one@space", "two@space")
        one, link1 = self.order("one@space")
        two, link2 = self.order("two@space", quote=False)
        d = self.payment_script(one)
        self.assertEqual(self.refund_to(link2, d), (409, {"error": PAYMENT_ADDRESSES}))
        self.assertEqual(self.refund_to(link1, d), (409, {"error": PAYMENT_ADDRESSES}))
        self.assertIsNone(self.refund_script(one))
        self.assertIsNone(self.refund_script(two))

    def test_T2_whatever_its_order_s_status(self):
        self.list("one@space", "two@space", "three@space")
        one, _ = self.order("one@space")
        self.now[0] += Policy().hold_seconds
        self.op("POST", "/operator/observe")
        self.assertEqual(self.led.operator_view(one)["status"], "unpaid")
        two, _ = self.order("two@space")
        self.assertEqual(self.op("POST", f"/operator/orders/{two}/cancel")[0], 200)
        self.assertEqual(self.led.operator_view(two)["status"], "cancelled")
        three, link3 = self.order("three@space", quote=False)
        for d in (self.payment_script(one), self.payment_script(two)):
            self.assertEqual(self.refund_to(link3, d), (409, {"error": PAYMENT_ADDRESSES}))
        self.assertIsNone(self.refund_script(three))

    def test_T3_a_quote_never_takes_a_refund_address(self):
        self.list("one@space", "two@space")
        one, link1 = self.order("one@space", quote=False)
        r = recipient("buyer-refund")
        self.assertEqual(self.refund_to(link1, r)[0], 200)
        self.assertEqual(self.refund_script(one), r)
        two, link2 = self.order("two@space", quote=False)
        for oid, link in ((one, link1), (two, link2)):
            self.next_scripts = [r]
            self.assertEqual(self.c.call("POST", link + "/quote")[0], 200)
            self.assertNotEqual(self.payment_script(oid), r)
            held = [a for a in self.led.alerts()
                    if a["kind"] == "destination_held" and a["oid"] == oid]
            self.assertEqual([a["detail"] for a in held], ['{"skipped": 1}'])
        self.assertEqual(self.refund_script(one), r)

    def test_T4_the_refund_address_is_fixed_once_a_refund_is_built(self):
        self.list("one@space")
        one, link = self.order("one@space")
        self.chain.add(Tx("pay1", (("coin1", 0),), ((self.payment_script(one), 13_000),)))
        for _ in range(6):
            self.chain.mine()
        self.op("POST", "/operator/observe")
        first = recipient("buyer-refund-1")
        self.assertEqual(self.refund_to(link, first)[0], 200)
        # Built through the ledger: the simulated chain has no wallet to sign.
        tx = {"txid": "refund-t4", "inputs": [("pay1", 0)], "outputs": [(first, 2_700)],
              "raw": "02aa"}
        self.led.open_group("g1", one, "excess", tx, 2_700, 300)
        self.assertEqual(self.refund_to(link, recipient("buyer-refund-2")),
                         (409, {"error": "a refund has been built; its destination is fixed"}))
        self.assertEqual(self.refund_script(one), first)


if __name__ == "__main__":
    unittest.main()
