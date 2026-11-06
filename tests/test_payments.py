"""Named cases P1 to P13 and Q1 (fixed-price payments and holds). Model only."""

import unittest

from model.chain import Tx
from model.store import Refused
from tests.helpers import PRICE, converted_order, mine, mine_empty, new_sim, pay


class Payments(unittest.TestCase):
    def test_P1_single_output_converts_at_three_confirmations(self):
        sim = new_sim()
        sim.do("store", "quote", "o1", "n1", "s1")
        pay(sim, "t1", "s1", PRICE)
        mine(sim)
        mine_empty(sim)
        o = sim.store.orders["o1"]
        self.assertEqual(o.status, "quoted")
        mine_empty(sim)
        self.assertEqual(o.status, "converted")
        self.assertEqual(sim.store.names["n1"].fulfillment, "o1")
        self.assertEqual(o.price_reserve, PRICE)

    def test_P2_two_outputs_in_one_transaction(self):
        sim = new_sim()
        sim.do("store", "quote", "o1", "n1", "s1")
        pay(sim, "t1", "s1", 6_000, ("s1", 4_000))
        mine(sim)
        mine_empty(sim, 2)
        self.assertEqual(len(sim.chain.outputs_to("s1")), 2)
        self.assertEqual(sim.store.orders["o1"].status, "converted")

    def test_P3_two_transactions(self):
        sim = new_sim()
        sim.do("store", "quote", "o1", "n1", "s1")
        pay(sim, "t1", "s1", 5_000)
        pay(sim, "t2", "s1", 5_000)
        mine(sim)
        mine_empty(sim, 2)
        self.assertEqual(sim.store.orders["o1"].status, "converted")

    def test_P4_reorg_and_remine_counts_once_and_pauses_issuance(self):
        sim = new_sim()
        o = converted_order(sim)
        sim.do("chain", "reorg", 3, [[], [], []])
        self.assertEqual(sim.store.sum_at(o, 1), 0)
        self.assertIn("issuance", o.reasons)
        self.assertEqual(sim.store.deficits(o)["refunds"], 0)
        self.assertEqual(sim.store.names["n1"].fulfillment, "o1")
        mine(sim)
        mine_empty(sim, 2)
        self.assertEqual(sim.store.sum_at(o, 1), PRICE)
        self.assertEqual(len(sim.chain.outputs_to(o.script)), 1)
        self.assertNotIn("issuance", o.reasons)

    def test_P5_underpaid_when_hold_ends(self):
        sim = new_sim()
        sim.do("store", "quote", "o1", "n1", "s1")
        seen = sim.chain.tip
        pay(sim, "t1", "s1", 4_000)
        mine(sim)
        mine_empty(sim, seen + 7 - sim.chain.tip)
        o = sim.store.orders["o1"]
        self.assertEqual(o.status, "refund_due")
        self.assertEqual(sim.store.available(o), 4_000)

    def test_P6_top_up_within_the_hold(self):
        sim = new_sim()
        sim.do("store", "quote", "o1", "n1", "s1")
        pay(sim, "t1", "s1", 4_000)
        mine(sim)
        pay(sim, "t2", "s1", 6_000)
        mine(sim)
        mine_empty(sim, 2)
        self.assertEqual(sim.store.orders["o1"].status, "converted")

    def test_P7_replaced_payment_leaves_order_unpaid(self):
        sim = new_sim()
        sim.do("store", "quote", "o1", "n1", "s1")
        pay(sim, "t1", "s1", PRICE)
        sim.do("chain", "drop", "t1")
        sim.do("chain", "add", Tx("t1b", (("coin-t1", 0),), (("elsewhere", PRICE),)))
        mine(sim)
        sim.do("store", "advance", 20)
        mine_empty(sim, 7)
        o = sim.store.orders["o1"]
        self.assertEqual(o.status, "unpaid")
        self.assertEqual(sim.store.available(o), 0)

    def test_P8_extension_lapses_then_late_payment(self):
        sim = new_sim()
        sim.do("store", "quote", "o1", "n1", "s1")
        seen = sim.chain.tip
        pay(sim, "t1", "s1", PRICE)
        mine_empty(sim, 6)
        o = sim.store.orders["o1"]
        self.assertEqual(sim.chain.tip, seen + 6)
        self.assertEqual(o.status, "quoted")
        mine_empty(sim)
        self.assertEqual(o.status, "unpaid")
        sim.do("chain", "mine", ["t1"])
        self.assertEqual(o.status, "quoted")
        mine_empty(sim, 2)
        self.assertEqual(o.status, "converted")

    def test_P9_late_payment_with_name_free(self):
        sim = new_sim()
        sim.do("store", "quote", "o1", "n1", "s1")
        sim.do("store", "advance", 16)
        o = sim.store.orders["o1"]
        self.assertEqual(o.status, "unpaid")
        pay(sim, "t1", "s1", PRICE)
        mine(sim)
        mine_empty(sim, 2)
        self.assertEqual(o.status, "converted")

    def test_P10_late_payment_while_another_buyer_holds(self):
        sim = new_sim()
        sim.do("store", "quote", "o1", "n1", "s1")
        sim.do("store", "advance", 16)
        sim.do("store", "quote", "o2", "n1", "s2")
        pay(sim, "t1", "s1", PRICE)
        mine(sim)
        self.assertEqual(sim.store.orders["o1"].status, "refund_due")
        self.assertEqual(sim.store.names["n1"].hold.oid, "o2")

    def test_P11_late_payment_after_price_rise(self):
        sim = new_sim()
        sim.do("store", "quote", "o1", "n1", "s1")
        sim.do("store", "advance", 16)
        sim.do("store", "set_price", "n1", 12_000)
        pay(sim, "t1", "s1", PRICE)
        mine(sim)
        self.assertEqual(sim.store.orders["o1"].status, "refund_due")

    def test_P12_late_payment_after_price_drop_leaves_excess(self):
        sim = new_sim()
        sim.do("store", "quote", "o1", "n1", "s1")
        sim.do("store", "advance", 16)
        sim.do("store", "set_price", "n1", 8_000)
        pay(sim, "t1", "s1", PRICE)
        mine(sim)
        mine_empty(sim, 5)
        o = sim.store.orders["o1"]
        self.assertEqual(o.status, "converted")
        self.assertEqual(o.price_reserve, 8_000)
        self.assertEqual(sim.store.available(o), 2_000)

    def test_P13_fulfillment_reservation_outlives_the_hold(self):
        sim = new_sim()
        converted_order(sim)
        sim.do("store", "advance", 120)
        mine_empty(sim, 10)
        self.assertEqual(sim.store.orders["o1"].status, "converted")
        self.assertEqual(sim.store.names["n1"].fulfillment, "o1")

    def test_Q1_one_hold_per_name(self):
        sim = new_sim()
        sim.do("store", "quote", "o1", "n1", "s1")
        with self.assertRaises(Refused):
            sim.do("store", "quote", "o2", "n1", "s2")


if __name__ == "__main__":
    unittest.main()
