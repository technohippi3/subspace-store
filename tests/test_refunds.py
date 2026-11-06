"""Named cases F1 to F5, G1 to G11 and R1 to R16 (refunds). Model only."""

import unittest

from model.chain import Tx
from model.sim import Sim
from model.store import Refused
from tests.helpers import (FEE, PRICE, converted_order, mine, mine_empty,
                           new_sim, pay, refund_due_order, refund_tx)


def settled_converted(sim, paid):
    o = converted_order(sim, paid=paid, depth=6)
    assert o.status == "converted"
    return o


class RefundArithmetic(unittest.TestCase):
    def test_F1_price_stays_reserved(self):
        sim = new_sim()
        o = settled_converted(sim, 13_000)
        with self.assertRaises(Refused):
            sim.do("store", "open_group", "g1", "o1", "excess",
                   refund_tx("r1", [("sc1", 0)], 12_700), 12_700, FEE)
        sim.do("store", "open_group", "g1", "o1", "excess",
               refund_tx("r1", [("sc1", 0)], 2_700), 2_700, FEE)
        self.assertEqual(sim.store.reserved(o), 3_000)

    def test_F2_second_excess_group_refused(self):
        sim = new_sim()
        settled_converted(sim, 13_000)
        sim.do("store", "open_group", "g1", "o1", "excess",
               refund_tx("r1", [("sc1", 0)], 2_700), 2_700, FEE)
        with self.assertRaises(Refused):
            sim.do("store", "open_group", "g2", "o1", "excess",
                   refund_tx("r2", [("sc2", 0)], 2_700), 2_700, FEE)

    def test_F3_cancellation_refund_net_of_fee(self):
        sim = new_sim()
        o = refund_due_order(sim)
        sim.do("store", "open_group", "g1", "o1", "cancellation",
               refund_tx("r1", [("sc1", 0)], 9_700), 9_700, FEE)
        g = sim.store.groups["g1"]
        self.assertEqual((g.attempts[0].to_buyer, g.attempts[0].fee), (9_700, FEE))
        self.assertEqual(sim.store.reserved(o), 10_000)

    def test_F4_cancellation_after_excess_never_exceeds_received(self):
        sim = new_sim()
        o = settled_converted(sim, 13_000)
        sim.do("store", "open_group", "g1", "o1", "excess",
               refund_tx("r1", [("sc1", 0)], 2_700), 2_700, FEE)
        sim.do("store", "cancel", "o1")
        with self.assertRaises(Refused):
            sim.do("store", "open_group", "g2", "o1", "cancellation",
                   refund_tx("r2", [("sc2", 0)], 9_701), 9_701, FEE)
        sim.do("store", "open_group", "g2", "o1", "cancellation",
               refund_tx("r2", [("sc2", 0)], 9_700), 9_700, FEE)
        self.assertEqual(sim.store.reserved(o), 13_000)

    def test_F5_excess_below_minimum(self):
        sim = new_sim()
        settled_converted(sim, 10_400)
        with self.assertRaises(Refused):
            sim.do("store", "open_group", "g1", "o1", "excess",
                   refund_tx("r1", [("sc1", 0)], 100), 100, FEE)


class ObligationGroups(unittest.TestCase):
    def setUp(self):
        self.sim = new_sim()

    def group(self, paid=PRICE, inputs=(("sc1", 0),)):
        o = refund_due_order(self.sim, paid=paid)
        self.sim.do("store", "open_group", "g1", "o1", "cancellation",
                    refund_tx("a1", inputs, 9_700), 9_700, FEE)
        return o

    def test_G1_same_amount_replacement_needs_no_capacity(self):
        o = self.group()
        self.assertEqual(self.sim.store.available(o), 0)
        self.sim.do("store", "add_attempt", "g1",
                    refund_tx("a2", [("sc1", 0), ("sc2", 0)], 9_700), 9_700, FEE)
        self.assertEqual(self.sim.store.reserved(o), 10_000)

    def test_G2_increase_refused_without_capacity(self):
        o = self.group(paid=10_300)
        self.assertEqual(self.sim.store.available(o), 300)
        with self.assertRaises(Refused):
            self.sim.do("store", "add_attempt", "g1",
                        refund_tx("a2", [("sc1", 0)], 10_200), 10_200, FEE)

    def test_G3_increase_authorizes_only_the_difference(self):
        o = self.group(paid=10_600)
        self.sim.do("store", "add_attempt", "g1",
                    refund_tx("a2", [("sc1", 0)], 10_200), 10_200, FEE)
        self.assertEqual(self.sim.store.reserved(o), 10_500)
        self.assertEqual(self.sim.store.available(o), 100)

    def test_G4_fee_bump_net_of_fee(self):
        o = self.group()
        self.sim.do("store", "add_attempt", "g1",
                    refund_tx("a2", [("sc1", 0)], 9_400), 9_400, 600)
        self.assertEqual(self.sim.store.reserved(o), 10_000)

    def test_G5_fee_bump_absorbed_by_store(self):
        o = self.group()
        self.sim.do("store", "add_attempt", "g1",
                    refund_tx("a2", [("sc1", 0)], 9_700), 9_700, 600, 10_000)
        a2 = self.sim.store.groups["g1"].attempt("a2")
        self.assertEqual((a2.charged, a2.store_cost), (10_000, 300))
        self.assertEqual(self.sim.store.reserved(o), 10_000)

    def _three_attempts(self):
        o = self.group(inputs=(("sc1", 0), ("sc2", 0)))
        self.sim.do("store", "add_attempt", "g1",
                    refund_tx("a2", [("sc1", 0), ("sc2", 0)], 9_400), 9_400, 600)
        self.sim.do("chain", "add", Tx("c1", (("sc2", 0),), (("owner-wallet", 10_000),)))
        mine(self.sim)
        mine_empty(self.sim, 5)
        self.assertTrue(self.sim.store.groups["g1"].needs_rebuild)
        self.sim.do("store", "add_attempt", "g1",
                    refund_tx("a3", [("sc1", 0)], 9_700), 9_700, FEE)
        return o

    def test_G6_reservation_is_the_largest_attempt_counted_once(self):
        o = self._three_attempts()
        self.assertEqual(len(self.sim.store.groups["g1"].attempts), 3)
        self.assertEqual(self.sim.store.reserved(o), 10_000)

    def test_G7_settled_attempt_closes_the_group(self):
        o = self._three_attempts()
        self.sim.do("store", "broadcast", "g1", "a3")
        mine(self.sim)
        mine_empty(self.sim, 5)
        g = self.sim.store.groups["g1"]
        self.assertEqual(g.closed_by, "a3")
        self.assertEqual(self.sim.store.refunded_total(o), 10_000)
        self.assertEqual(self.sim.store.reserved(o), 0)

    def test_G8_deep_reorg_reopens_the_group(self):
        o = self._three_attempts()
        self.sim.do("store", "broadcast", "g1", "a3")
        mine(self.sim)
        mine_empty(self.sim, 5)
        self.sim.do("chain", "reorg", 6, [[]] * 7)
        g = self.sim.store.groups["g1"]
        self.assertIsNone(g.closed_by)
        self.assertEqual(self.sim.store.refunded_total(o), 0)
        self.assertEqual(self.sim.store.reserved(o), 10_000)

    def test_G9_restart_recomputes_the_same_reservation(self):
        self._three_attempts()
        replayed = Sim.replay(self.sim.journal)
        self.assertEqual(replayed.obligations(), self.sim.obligations())
        self.assertEqual(replayed.store.reserved(replayed.store.orders["o1"]), 10_000)

    def test_G10_two_groups_sum_their_maxima(self):
        sim = new_sim()
        o = settled_converted(sim, 13_000)
        sim.do("store", "open_group", "g1", "o1", "excess",
               refund_tx("r1", [("sc1", 0)], 2_700), 2_700, FEE)
        sim.do("store", "cancel", "o1")
        sim.do("store", "open_group", "g2", "o1", "cancellation",
               refund_tx("r2", [("sc2", 0)], 9_700), 9_700, FEE)
        self.assertEqual(sim.store.reserved(o), 13_000)

    def test_G11_lower_replacement_frees_nothing(self):
        o = self.group()
        self.sim.do("store", "add_attempt", "g1",
                    refund_tx("a2", [("sc1", 0)], 8_700), 8_700, FEE)
        self.assertEqual(self.sim.store.reserved(o), 10_000)


class RefundReconciliation(unittest.TestCase):
    def setUp(self):
        self.sim = new_sim()
        self.o = refund_due_order(self.sim, settle_depth=12)

    def open(self, inputs=(("sc1", 0),), gid="g1", txid="a1"):
        self.sim.do("store", "open_group", gid, "o1", "cancellation",
                    refund_tx(txid, inputs, 9_700), 9_700, FEE)

    def test_R1_racing_requests_reserve_once(self):
        self.open()
        with self.assertRaises(Refused):
            self.open(gid="g2", txid="b1")

    def test_R2_lost_response_found_after_restart(self):
        self.open()
        self.sim.do("store", "broadcast", "g1", "a1", response_lost=True)
        restarted = Sim.replay(self.sim.journal)
        self.assertEqual(restarted.store.reconcile_attempts(), [])
        self.assertTrue(restarted.store.groups["g1"].attempt("a1").acknowledged)
        with self.assertRaises(Refused):
            restarted.do("store", "open_group", "g2", "o1", "cancellation",
                         refund_tx("b1", [("sc9", 0)], 9_700), 9_700, FEE)

    def test_R3_failed_send_rebroadcasts_the_same_transaction(self):
        self.open()
        self.sim.do("store", "broadcast", "g1", "a1", reached_network=False)
        self.assertEqual(self.sim.store.reconcile_attempts(), ["a1"])
        self.sim.do("store", "rebroadcast", "g1", "a1")
        self.assertTrue(self.sim.chain.in_mempool("a1"))
        self.assertEqual(self.sim.store.reserved(self.o), 10_000)

    def test_R4_eviction_keeps_the_reservation(self):
        self.open()
        self.sim.do("store", "broadcast", "g1", "a1")
        self.sim.do("chain", "drop", "a1")
        self.assertEqual(self.sim.store.reserved(self.o), 10_000)
        self.assertEqual(self.sim.store.reconcile_attempts(), ["a1"])

    def test_R5_fee_bump_pays_exactly_once(self):
        self.open()
        self.sim.do("store", "add_attempt", "g1",
                    refund_tx("a2", [("sc1", 0)], 9_400), 9_400, 600)
        self.sim.do("store", "broadcast", "g1", "a1")
        self.sim.do("store", "broadcast", "g1", "a2")
        mine(self.sim)
        mine_empty(self.sim, 5)
        mined = [t for t in ("a1", "a2") if self.sim.chain.position(t)]
        self.assertEqual(len(mined), 1)
        self.assertEqual(self.sim.store.groups["g1"].closed_by, mined[0])

    def test_R6_reorged_settled_refund_reopens_without_a_new_group(self):
        self.open()
        self.sim.do("store", "broadcast", "g1", "a1")
        mine(self.sim)
        mine_empty(self.sim, 5)
        self.assertEqual(self.sim.store.groups["g1"].closed_by, "a1")
        self.sim.do("chain", "reorg", 7, [[]] * 8)
        self.assertIsNone(self.sim.store.groups["g1"].closed_by)
        with self.assertRaises(Refused):
            self.open(gid="g2", txid="b1", inputs=(("sc9", 0),))

    def _settled_conflict(self, inputs=(("sc1", 0),), conflict_outputs=(("owner-wallet", 10_000),)):
        self.open(inputs=inputs)
        self.sim.do("chain", "add", Tx("c1", (("sc1", 0),), conflict_outputs))
        mine(self.sim)
        mine_empty(self.sim, 5)

    def test_R7_settled_conflict_marks_needs_rebuild(self):
        self._settled_conflict()
        self.assertTrue(self.sim.store.groups["g1"].needs_rebuild)
        self.assertEqual(self.sim.store.reserved(self.o), 10_000)

    def test_R8_conflict_loses_depth_no_fresh_family(self):
        self._settled_conflict()
        self.sim.do("chain", "reorg", 6, [[]] * 7)
        self.assertTrue(self.sim.store.groups["g1"].needs_rebuild)
        with self.assertRaises(Refused):
            self.sim.do("store", "add_attempt", "g1",
                        refund_tx("a3", [("sc5", 0)], 9_700), 9_700, FEE)

    def test_R9_fresh_family_from_unspent_old_input(self):
        self._settled_conflict(inputs=(("sc1", 0), ("sc2", 0)))
        self.sim.do("store", "add_attempt", "g1",
                    refund_tx("a3", [("sc2", 0)], 9_700), 9_700, FEE)
        self.sim.do("store", "broadcast", "g1", "a1")
        self.sim.do("store", "broadcast", "g1", "a3")
        mine(self.sim)
        mined = [t for t in ("a1", "a3") if self.sim.chain.position(t)]
        self.assertLessEqual(len(mined), 1)

    def test_R10_exported_psbt_is_never_released_locally(self):
        self.open()
        self.sim.store.export_psbt("g1", "a1")
        with self.assertRaises(Refused):
            self.sim.store.release("g1")
        self.assertEqual(self.sim.store.reserved(self.o), 10_000)

    def test_R12_independent_payment_refused_and_paused(self):
        self._settled_conflict(conflict_outputs=(("elsewhere", 10_000),))
        with self.assertRaises(Refused):
            self.sim.do("store", "add_attempt", "g1",
                        refund_tx("a3", [("sc9", 0)], 9_700), 9_700, FEE)
        g = self.sim.store.groups["g1"]
        self.assertTrue(g.paused)
        self.assertIn(("o1", "refund_paused", "g1"), self.sim.store.alerts)

    def _dependent_replacement(self):
        self._settled_conflict(conflict_outputs=(("refund-wallet", 10_000),))
        self.sim.do("store", "add_attempt", "g1",
                    refund_tx("a3", [("c1", 0)], 9_700), 9_700, FEE)
        self.sim.do("store", "broadcast", "g1", "a3")
        mine(self.sim)
        self.assertIsNotNone(self.sim.chain.position("a3"))
        self.sim.do("chain", "reorg", 7, [[]] * 8)
        self.sim.do("store", "broadcast", "g1", "a1")
        self.sim.do("chain", "mine", ["a1"])
        mine(self.sim)

    def test_R13_dependency_on_the_conflict_keeps_exclusivity(self):
        self._dependent_replacement()
        self.assertIsNotNone(self.sim.chain.position("a1"))
        self.assertIsNone(self.sim.chain.position("a3"))

    def test_R14_group_refunded_once(self):
        self._dependent_replacement()
        mine_empty(self.sim, 5)
        g = self.sim.store.groups["g1"]
        self.assertEqual(g.closed_by, "a1")
        self.assertEqual(self.sim.store.refunded_total(self.o), 10_000)


class SettledDepthRoundTrips(unittest.TestCase):
    def _excess_setup(self):
        sim = new_sim()
        o = settled_converted(sim, 13_000)
        sim.do("store", "open_group", "g1", "o1", "excess",
               refund_tx("r1", [("sc1", 0)], 2_700), 2_700, FEE)
        before = sim.store.available(o)
        # payment at 6 conf: reorg so it is re-mined one block later, at 5 conf
        sim.do("chain", "reorg", 6, [[], ["t-o1"], [], [], [], []])
        return sim, o, before

    def test_R11_payment_falls_to_five(self):
        sim, o, _ = self._excess_setup()
        self.assertEqual(sim.chain.conf("t-o1"), 5)
        self.assertIn("refunds", o.reasons)
        with self.assertRaises(Refused):
            sim.do("store", "open_group", "g2", "o1", "excess",
                   refund_tx("r2", [("sc2", 0)], 100), 100, FEE)
        sim.do("store", "mark_issuing", "o1")
        self.assertEqual(o.status, "issuing")

    def test_R15_payment_returns_to_six(self):
        sim, o, before = self._excess_setup()
        mine_empty(sim)
        self.assertNotIn("refunds", o.reasons)
        self.assertEqual(sim.store.available(o), before)
        self.assertEqual(sim.store.reserved(o), 3_000)

    def test_R16_settled_refund_attempt_round_trip(self):
        sim = new_sim()
        o = refund_due_order(sim, settle_depth=12)
        sim.do("store", "open_group", "g1", "o1", "cancellation",
               refund_tx("a1", [("sc1", 0)], 9_700), 9_700, FEE)
        sim.do("store", "broadcast", "g1", "a1")
        mine(sim)
        mine_empty(sim, 5)
        self.assertEqual(sim.store.groups["g1"].closed_by, "a1")
        sim.do("chain", "reorg", 6, [[], ["a1"], [], [], [], []])
        self.assertEqual(sim.chain.conf("a1"), 5)
        self.assertIsNone(sim.store.groups["g1"].closed_by)
        self.assertEqual(sim.store.reserved(o), 10_000)
        mine_empty(sim)
        self.assertEqual(sim.store.groups["g1"].closed_by, "a1")
        self.assertEqual(sim.store.refunded_total(o), 10_000)
        self.assertEqual(sim.store.reserved(o), 0)
        self.assertEqual(len(sim.store.groups["g1"].attempts), 1)


if __name__ == "__main__":
    unittest.main()
