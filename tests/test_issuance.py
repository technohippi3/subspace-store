"""Named cases X1 to X9, B1 to B5, J1, J2 and N12 (fixed-price issuance).

Model only: `subs` is reduced to single steps and a commitment is a simulated
transaction spending the delegate output.
"""

import unittest

from model.store import Refused
from tests.helpers import (FEE, PRICE, converted_order, mine, mine_empty,
                           new_sim, refund_tx)

NAMES = ("n1", "n2", "n3", "n4")


def setup(paid=PRICE, orders=1, depth=10):
    sim = new_sim(names=NAMES)
    for i in range(orders):
        converted_order(sim, oid=f"o{i + 1}", name=NAMES[i], paid=paid, depth=depth)
    return sim


def prepare(sim):
    bid = sim.do("controller", "freeze")
    sim.do("controller", "commit_local", bid)
    sim.do("controller", "prove", bid)
    sim.do("controller", "checkpoint", bid)
    return bid


def issue(sim, bid, outcome="ok"):
    return sim.do("controller", "check_and_issue", bid, outcome)


def finalize(sim):
    mine(sim)
    mine_empty(sim, 150)


class CancellationAgainstIssuance(unittest.TestCase):
    def test_X1_cancelled_order_is_never_batched(self):
        sim = setup(orders=2)
        sim.do("store", "cancel", "o1")
        bid = sim.do("controller", "freeze")
        self.assertEqual(sim.controller.batches[bid].members, ["o2"])

    def test_X2_cancellation_during_proving_rebuilds_without_it(self):
        sim = setup(orders=2)
        bid = sim.do("controller", "freeze")
        sim.do("controller", "commit_local", bid)
        sim.do("store", "cancel", "o1")
        sim.do("controller", "prove", bid)
        sim.do("controller", "checkpoint", bid)
        nb = issue(sim, bid)
        self.assertNotEqual(nb, bid)
        self.assertEqual(sim.controller.batches[bid].state, "rebuilt")
        self.assertEqual(sim.controller.batches[nb].members, ["o2"])
        sim.do("store", "open_group", "g1", "o1", "cancellation",
               refund_tx("a1", [("sc1", 0)], 9_700), 9_700, FEE)

    def test_X3_cancellation_and_issuing_serialize(self):
        # Cancellation first: the check removes the order.
        sim = setup(orders=1)
        bid = prepare(sim)
        sim.do("store", "cancel", "o1")
        with self.assertRaises(Refused):
            issue(sim, bid)
        self.assertEqual(sim.store.orders["o1"].status, "cancelled")
        # Issuing first: the cancellation is refused.
        sim = setup(orders=1)
        bid = prepare(sim)
        issue(sim, bid)
        with self.assertRaises(Refused):
            sim.do("store", "cancel", "o1")
        self.assertEqual(sim.store.orders["o1"].status, "issuing")

    def test_X4_lost_broadcast_answer(self):
        sim = setup()
        bid = prepare(sim)
        issue(sim, bid, outcome="lost")
        self.assertEqual(sim.controller.batches[bid].state, "broadcast_uncertain")
        for call in (("store", "cancel", "o1"),
                     ("controller", "retry_broadcast", bid),
                     ("controller", "rollback_local", bid)):
            with self.assertRaises(Refused):
                sim.do(*call)

    def test_X5_absent_from_every_mempool_is_not_supersession(self):
        sim = setup()
        bid = prepare(sim)
        issue(sim, bid, outcome="unsent")
        mine_empty(sim, 300)
        self.assertFalse(sim.do("controller", "readback", bid))
        self.assertEqual(sim.controller.batches[bid].state, "broadcast_uncertain")
        with self.assertRaises(Refused):
            sim.do("store", "cancel", "o1")

    def test_X6_reorg_is_not_supersession(self):
        sim = setup()
        bid = prepare(sim)
        issue(sim, bid)
        mine(sim)
        self.assertEqual(sim.controller.batches[bid].state, "mined")
        sim.do("chain", "reorg", 1, [[], []])
        sim.do("chain", "drop", f"commit-{bid}")
        self.assertEqual(sim.controller.batches[bid].state, "broadcast")
        with self.assertRaises(Refused):
            sim.do("store", "cancel", "o1")

    def test_X7_owner_supersession_makes_the_order_paid_again(self):
        sim = setup()
        bid = prepare(sim)
        issue(sim, bid)
        sim.do("controller", "owner_supersede", bid, "rollback-1")
        sim.do("chain", "mine", ["rollback-1"])
        mine_empty(sim, 4)
        self.assertEqual(sim.controller.batches[bid].state, "broadcast")
        mine_empty(sim, 1)
        self.assertEqual(sim.controller.batches[bid].state, "superseded")
        self.assertEqual(sim.store.orders["o1"].status, "converted")
        sim.do("store", "cancel", "o1")

    def test_X8_fulfilled_is_never_cancelled(self):
        sim = setup()
        bid = prepare(sim)
        issue(sim, bid)
        finalize(sim)
        self.assertEqual(sim.controller.batches[bid].state, "final")
        self.assertEqual(sim.store.orders["o1"].status, "ready")
        self.assertEqual(sim.do("controller", "publish", bid, ["o1"]), 1)
        sim.do("controller", "confirm_delivery", bid, "o1")
        self.assertEqual(sim.store.orders["o1"].status, "fulfilled")
        with self.assertRaises(Refused):
            sim.do("store", "cancel", "o1")

    def test_X9_excess_refund_while_issuing(self):
        sim = setup(paid=13_000)
        bid = prepare(sim)
        issue(sim, bid)
        sim.do("store", "open_group", "g1", "o1", "excess",
               refund_tx("r1", [("sc1", 0)], 2_700), 2_700, FEE)
        self.assertEqual(sim.store.orders["o1"].price_reserve, PRICE)


class BatchEntry(unittest.TestCase):
    def _two_with_young_o1(self):
        sim = new_sim(names=NAMES)
        converted_order(sim, oid="o2", name="n2", depth=10)
        converted_order(sim, oid="o1", name="n1", depth=3)
        return sim

    def test_B1_member_loses_depth_and_is_rebuilt_out(self):
        sim = self._two_with_young_o1()
        bid = prepare(sim)
        sim.do("chain", "reorg", 3, [[], ["t-o1"], []])
        nb = issue(sim, bid)
        self.assertEqual(sim.controller.batches[nb].members, ["o2"])
        o1 = sim.store.orders["o1"]
        self.assertIn("issuance", o1.reasons)
        self.assertEqual(sim.store.names["n1"].fulfillment, "o1")
        sim.do("controller", "commit_local", nb)
        sim.do("controller", "prove", nb)
        sim.do("controller", "checkpoint", nb)
        issue(sim, nb)
        self.assertEqual(sim.store.orders["o2"].status, "issuing")

    def test_B2_eligibility_conflict_is_rebuilt_out(self):
        sim = setup(orders=2)
        bid = prepare(sim)
        sim.do("store", "invalidate_eligibility", "o1")
        nb = issue(sim, bid)
        self.assertEqual(sim.controller.batches[nb].members, ["o2"])

    def test_B3_passing_members_become_issuing(self):
        sim = setup(orders=2)
        bid = prepare(sim)
        self.assertEqual(issue(sim, bid), bid)
        self.assertEqual({sim.store.orders[m].status for m in ("o1", "o2")}, {"issuing"})
        self.assertTrue(sim.chain.in_mempool(f"commit-{bid}"))

    def test_B4_check_runs_again_after_restart(self):
        sim = self._two_with_young_o1()
        bid = prepare(sim)
        sim.do("sim", "host_loss")
        sim.do("chain", "reorg", 3, [[], ["t-o1"], []])
        nb = issue(sim, bid)
        self.assertEqual(sim.controller.batches[nb].members, ["o2"])

    def test_B5_three_rebuilds_pause_until_the_next_block(self):
        sim = setup(orders=4)
        bid = prepare(sim)
        for victim in ("o1", "o2"):
            sim.do("store", "invalidate_eligibility", victim)
            bid = issue(sim, bid)
            sim.do("controller", "commit_local", bid)
            sim.do("controller", "prove", bid)
            sim.do("controller", "checkpoint", bid)
        sim.do("store", "invalidate_eligibility", "o3")
        with self.assertRaises(Refused):
            issue(sim, bid)
        self.assertIn(("rebuilds", bid), sim.controller.alerts)
        self.assertFalse(any(t.startswith("commit-") for t in sim.chain.txs))
        with self.assertRaises(Refused):
            sim.do("controller", "freeze")
        mine_empty(sim)
        nb = sim.do("controller", "freeze")
        self.assertEqual(sim.controller.batches[nb].members, ["o4"])


class RestoreAgainstReservations(unittest.TestCase):
    def test_J1_journaled_refund_survives_host_loss(self):
        sim = setup()
        sim.do("store", "cancel", "o1")
        sim.do("store", "open_group", "g1", "o1", "cancellation",
               refund_tx("a1", [("sc1", 0)], 9_700), 9_700, FEE)
        sim.do("sim", "set_offhost", False)
        sim.do("sim", "host_loss")
        self.assertIn("g1", sim.store.groups)
        self.assertEqual(sim.store.reserved(sim.store.orders["o1"]), 10_000)
        self.assertEqual(sim.store.reconcile_attempts(), [])

    def test_J2_nothing_escapes_without_an_acknowledged_journal(self):
        sim = setup()
        sim.do("store", "cancel", "o1")
        sim.do("sim", "set_offhost", False)
        sim.do("store", "open_group", "g1", "o1", "cancellation",
               refund_tx("a1", [("sc1", 0)], 9_700), 9_700, FEE)
        for call in (("store", "broadcast", "g1", "a1"),
                     ("store", "export_psbt", "g1", "a1")):
            with self.assertRaises(Refused):
                sim.do(*call)
        self.assertFalse(sim.chain.in_mempool("a1"))
        sim.do("sim", "set_offhost", True)
        sim.do("store", "advance", 0)
        sim.do("store", "broadcast", "g1", "a1")
        self.assertTrue(sim.chain.in_mempool("a1"))

    def test_N12_shortfall_never_replaces_an_escaped_commitment(self):
        sim = setup(depth=3)
        bid = prepare(sim)
        issue(sim, bid)
        sim.do("chain", "reorg", 3, [[]] * 4)
        sim.do("chain", "drop", "t-o1")
        self.assertIn("post_issuance_deficit", sim.store.orders["o1"].reasons)
        for call in (("controller", "replace_commitment", bid),
                     ("controller", "rollback_local", bid)):
            with self.assertRaises(Refused):
                sim.do(*call)
        self.assertEqual(sim.store.orders["o1"].status, "issuing")


class ControllerRestore(unittest.TestCase):
    def test_restore_with_acknowledged_intent_is_uncertain(self):
        sim = setup()
        bid = prepare(sim)
        issue(sim, bid, outcome="unsent")
        sim.do("sim", "host_loss")
        self.assertEqual(sim.controller.batches[bid].state, "broadcast_uncertain")
        with self.assertRaises(Refused):
            sim.do("controller", "resume", bid)

    def test_journal_outage_before_issuing_sends_nothing_and_restores_to_paid(self):
        sim = setup()
        bid = prepare(sim)
        sim.do("sim", "set_offhost", False)
        with self.assertRaises(Refused):
            issue(sim, bid)
        self.assertFalse(any(t.startswith("commit-") for t in sim.chain.txs))
        sim.do("sim", "host_loss")
        self.assertEqual(sim.controller.batches[bid].state, "checkpointed")
        self.assertEqual(sim.store.orders["o1"].status, "converted")
        sim.do("sim", "set_offhost", True)
        issue(sim, bid)
        self.assertEqual(sim.controller.batches[bid].state, "broadcast")

    def test_unacknowledged_controller_intent_was_never_sent_and_resumes(self):
        sim = setup()
        bid = prepare(sim)
        sim.controller.offhost_available = False  # only the controller's journal is down
        with self.assertRaises(Refused):
            issue(sim, bid)
        self.assertFalse(any(t.startswith("commit-") for t in sim.chain.txs))
        sim.controller.restore_from_offhost()
        self.assertEqual(sim.store.orders["o1"].status, "issuing")
        self.assertEqual(sim.controller.batches[bid].state, "issuing")
        sim.controller.offhost_available = True
        sim.controller.resume(bid)
        self.assertEqual(sim.controller.batches[bid].state, "broadcast")

    def test_readback_adopts_a_lost_answer(self):
        sim = setup()
        bid = prepare(sim)
        issue(sim, bid, outcome="lost")
        self.assertTrue(sim.do("controller", "readback", bid))
        finalize(sim)
        self.assertEqual(sim.controller.batches[bid].state, "final")

    def test_next_batch_spends_the_new_delegate_output(self):
        sim = setup(orders=2)
        bid = sim.do("controller", "freeze", ["o1"])
        for step in ("commit_local", "prove", "checkpoint"):
            sim.do("controller", step, bid)
        issue(sim, bid)
        with self.assertRaises(Refused):
            sim.do("controller", "freeze")
        finalize(sim)
        nb = sim.do("controller", "freeze")
        self.assertEqual(sim.controller.batches[nb].delegate_in, (f"commit-{bid}", 0))

    def test_empty_publish_is_a_local_no_op(self):
        sim = setup()
        bid = prepare(sim)
        issue(sim, bid)
        finalize(sim)
        self.assertEqual(sim.do("controller", "publish", bid, []), 0)
        self.assertEqual(sim.store.orders["o1"].status, "ready")


if __name__ == "__main__":
    unittest.main()
