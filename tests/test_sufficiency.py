"""Named cases N1 to N13, except N6 (auctions) and N12 (controller). Model only.

N8 is covered on the store side only: the model has no batches or
commitments yet, so "the commitment is not rebuilt, replaced or rolled back"
is checked in the controller slice.
"""

import unittest

from model.store import Refused
from tests.helpers import (FEE, PRICE, converted_order, mine, mine_empty,
                           new_sim, pay, refund_tx)


class Sufficiency(unittest.TestCase):
    def test_N1_three_confirmations_issue_without_reconciling(self):
        sim = new_sim()
        o = converted_order(sim, depth=3)
        self.assertEqual(sim.store.sum_at(o, 6), 0)
        self.assertEqual(o.reasons, set())
        sim.do("store", "mark_issuing", "o1")
        self.assertEqual(o.status, "issuing")
        self.assertEqual(o.reasons, set())

    def test_N2_cancellation_refund_waits_for_settled_funds(self):
        sim = new_sim()
        converted_order(sim, depth=3)
        sim.do("store", "cancel", "o1")
        with self.assertRaises(Refused):
            sim.do("store", "open_group", "g1", "o1", "cancellation",
                   refund_tx("a1", [("sc1", 0)], 9_700), 9_700, FEE)
        mine_empty(sim, 3)
        sim.do("store", "open_group", "g1", "o1", "cancellation",
               refund_tx("a1", [("sc1", 0)], 9_700), 9_700, FEE)

    def test_N3_excess_waits_while_issuance_proceeds(self):
        sim = new_sim()
        converted_order(sim, paid=13_000, depth=3)
        with self.assertRaises(Refused):
            sim.do("store", "open_group", "g1", "o1", "excess",
                   refund_tx("r1", [("sc1", 0)], 2_700), 2_700, FEE)
        sim.do("store", "mark_issuing", "o1")

    def test_N4_reorg_below_three_pauses_issuance(self):
        sim = new_sim()
        o = converted_order(sim, depth=3)
        sim.do("chain", "reorg", 3, [[], ["t-o1"], []])
        self.assertEqual(sim.chain.conf("t-o1"), 2)
        self.assertIn("issuance", o.reasons)
        self.assertEqual(sim.store.names["n1"].fulfillment, "o1")
        with self.assertRaises(Refused):
            sim.do("store", "mark_issuing", "o1")

    def test_N5_price_stays_reserved_after_fulfillment(self):
        sim = new_sim()
        o = converted_order(sim, depth=3)
        sim.do("store", "mark_issuing", "o1")
        sim.do("store", "mark_ready", "o1")
        sim.do("store", "mark_fulfilled", "o1")
        mine_empty(sim, 10)
        self.assertEqual(o.price_reserve, PRICE)
        with self.assertRaises(Refused):
            sim.do("store", "open_group", "g1", "o1", "excess",
                   refund_tx("r1", [("sc1", 0)], 100), 100, FEE)

    def _issued(self, fulfilled=False):
        sim = new_sim()
        o = converted_order(sim, depth=3)
        sim.do("store", "mark_issuing", "o1")
        if fulfilled:
            sim.do("store", "mark_ready", "o1")
            sim.do("store", "mark_fulfilled", "o1")
        mine_empty(sim, 10)
        return sim, o

    def test_N7_deficit_while_issuing_alerts_only(self):
        sim, o = self._issued()
        sim.do("chain", "reorg", 13, [[]] * 14)
        self.assertIn("post_issuance_deficit", o.reasons)
        self.assertEqual(o.status, "issuing")
        self.assertIn(("o1", "post_issuance_deficit", PRICE), sim.store.alerts)

    def test_N8_store_side_deficit_after_mining_alerts_only(self):
        sim, o = self._issued()
        sim.do("chain", "reorg", 13, [[]] * 11 + [["t-o1"], []])
        self.assertEqual(sim.chain.conf("t-o1"), 2)
        self.assertIn("post_issuance_deficit", o.reasons)
        self.assertEqual(o.status, "issuing")

    def test_N9_deficit_after_fulfillment_keeps_the_name_with_the_buyer(self):
        sim, o = self._issued(fulfilled=True)
        sim.do("chain", "reorg", 13, [[]] * 14)
        self.assertIn("post_issuance_deficit", o.reasons)
        self.assertEqual(o.status, "fulfilled")
        self.assertEqual(sim.store.names["n1"].fulfillment, "o1")

    def test_N10_deficit_clears_when_the_payment_returns(self):
        sim, o = self._issued(fulfilled=True)
        sim.do("chain", "reorg", 13, [[]] * 14)
        mine(sim)
        mine_empty(sim, 2)
        self.assertNotIn("post_issuance_deficit", o.reasons)

    def test_N11_recorded_loss_clears_the_reason(self):
        sim, o = self._issued(fulfilled=True)
        sim.do("chain", "reorg", 13, [[]] * 14)
        sim.do("chain", "drop", "t-o1")
        sim.do("store", "record_loss", "o1", "post_issuance_deficit")
        self.assertNotIn("post_issuance_deficit", o.reasons)
        self.assertEqual(o.losses["post_issuance_deficit"], PRICE)

    def test_N13_recorded_loss_suppresses_repeats_and_raises_only_the_difference(self):
        sim = new_sim()
        sim.do("store", "quote", "o1", "n1", "s-o1")
        pay(sim, "small", "s-o1", 2_000)
        mine(sim)
        pay(sim, "large", "s-o1", 8_000)
        mine(sim)
        mine_empty(sim, 2)
        o = sim.store.orders["o1"]
        sim.do("store", "mark_issuing", "o1")
        sim.do("store", "mark_ready", "o1")
        sim.do("store", "mark_fulfilled", "o1")
        sim.do("chain", "drop", "small")
        # Remove the block holding "large" only.
        sim.do("chain", "reorg", 3, [[]] * 4)
        sim.do("chain", "drop", "large")
        self.assertEqual(sim.store.deficits(o)["post_issuance_deficit"], 8_000)
        sim.do("store", "record_loss", "o1", "post_issuance_deficit")
        alerts_before = list(sim.store.alerts)
        mine_empty(sim, 2)
        self.assertEqual(sim.store.alerts, alerts_before)
        self.assertNotIn("post_issuance_deficit", o.reasons)
        # A deeper reorg also removes "small": the deficit grows by 2,000.
        sim.do("chain", "reorg", sim.chain.tip - (sim.chain.position("small")[0]) + 1, [[]] * 8)
        sim.do("chain", "drop", "small")
        self.assertEqual(sim.store.deficits(o)["post_issuance_deficit"], 10_000)
        self.assertIn("post_issuance_deficit", o.reasons)
        self.assertEqual(sim.store.alerts[-1], ("o1", "post_issuance_deficit", 2_000))


if __name__ == "__main__":
    unittest.main()
