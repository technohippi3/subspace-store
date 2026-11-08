"""Named cases X1 to X10, B1 to B7, J1 to J12, L1 to L9 and N12 (fixed-price
issuance).

B6, B7, J3 to J10 and L1 to L5 are regressions from the model review of
2026-11-07: each replays a sequence the earlier model got wrong. L6 to L8
come from the first regtest findings (R10, R11), and L9 from R23 and R24.
They are still model cases.

Model only: `subs` is reduced to single steps and a commitment is a simulated
transaction spending the delegate output.
"""

import unittest

from model.store import Refused
from tests.helpers import (FEE, PRICE, converted_order, cover, lose_finality, mine,
                           mine_empty, new_sim, refund_due_order, refund_tx)

NAMES = ("n1", "n2", "n3", "n4")


def setup(paid=PRICE, orders=1, depth=10, **config):
    sim = new_sim(names=NAMES, **config)
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
    """Mine the commitment to d >= 150, then on until an anchor covers it."""
    mine(sim)
    mine_empty(sim, 150)
    cover(sim)


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

    def test_X10_reversed_supersession_locks_members_again(self):
        # Found by a 300-seed generated run (seed 5): a supersession settled at
        # 6 conf, then a deeper reorg removed it.
        def superseded(cancel):
            sim = setup()
            bid = prepare(sim)
            issue(sim, bid)
            sim.do("controller", "owner_supersede", bid, "rollback-1")
            sim.do("chain", "mine", ["rollback-1"])
            mine_empty(sim, 5)
            self.assertEqual(sim.controller.batches[bid].state, "superseded")
            if cancel:
                sim.do("store", "cancel", "o1")
            return sim, bid

        def undo(sim):
            depth = sim.chain.conf("rollback-1")
            sim.do("chain", "reorg", depth, [[] for _ in range(depth + 1)])
            sim.do("chain", "drop", "rollback-1")

        # A paid member is locked again, and nothing else may spend the
        # delegate output while the old commitment can still confirm.
        sim, bid = superseded(cancel=False)
        nb = prepare(sim)
        undo(sim)
        self.assertEqual(sim.controller.batches[bid].state, "broadcast")
        self.assertIn(("supersession_reversed", bid), sim.controller.alerts)
        self.assertEqual(sim.store.orders["o1"].status, "issuing")
        with self.assertRaises(Refused):
            sim.do("store", "cancel", "o1")
        with self.assertRaises(Refused):
            issue(sim, nb)
        self.assertFalse(sim.chain.in_mempool(f"commit-{nb}"))
        sim.do("controller", "rebroadcast_commitment", bid)
        finalize(sim)
        self.assertEqual(sim.store.orders["o1"].status, "ready")
        # A member already cancelled keeps its status, with an incident.
        sim, bid = superseded(cancel=True)
        undo(sim)
        o1 = sim.store.orders["o1"]
        self.assertEqual(o1.status, "cancelled")
        self.assertEqual(o1.incident.kinds, ["supersession_reversed"])

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


    def test_B6_one_commitment_per_space(self):
        sim = setup(orders=1)
        b1 = sim.do("controller", "freeze")
        converted_order(sim, oid="o2", name="n2", depth=10)
        # Two batches can't be prepared side by side, so they can't both spend
        # the delegate output.
        with self.assertRaises(Refused):
            sim.do("controller", "freeze")
        for step in ("commit_local", "prove", "checkpoint"):
            sim.do("controller", step, b1)
        issue(sim, b1)
        with self.assertRaises(Refused):
            sim.do("controller", "freeze")
        finalize(sim)
        b2 = prepare(sim)
        self.assertEqual(sim.controller.batches[b2].members, ["o2"])
        issue(sim, b2)
        commits = [t for t in sim.chain.txs.values() if t.txid.startswith("commit-")]
        self.assertEqual([t.inputs for t in commits],
                         [(("delegate-genesis", 0),), ((f"commit-{b1}", 0),)])

    def test_B7_delegate_output_is_read_when_issuing(self):
        sim = setup()
        bid = prepare(sim)
        self.assertEqual(sim.controller.batches[bid].delegate_in, ("delegate-genesis", 0))
        sim.do("controller", "owner_supersede", bid, "rollback-1")
        sim.do("chain", "mine", ["rollback-1"])
        mine_empty(sim, 5)
        issue(sim, bid)
        self.assertEqual(sim.chain.txs[f"commit-{bid}"].inputs, (("rollback-1", 0),))
        self.assertEqual(sim.controller.offhost["batches"][bid].delegate_in, ("rollback-1", 0))


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

    def test_J3_store_journal_down_blocks_the_broadcast(self):
        sim = setup()
        bid = prepare(sim)
        sim.do("sim", "set_offhost", False, "store")
        with self.assertRaises(Refused):
            issue(sim, bid)
        self.assertFalse(any(t.startswith("commit-") for t in sim.chain.txs))
        self.assertEqual(sim.controller.batches[bid].state, "issuing")
        self.assertEqual(sim.store.orders["o1"].status, "issuing")
        with self.assertRaises(Refused):
            sim.do("controller", "resume", bid)
        self.assertFalse(any(t.startswith("commit-") for t in sim.chain.txs))
        sim.do("sim", "set_offhost", True, "store")
        sim.do("controller", "resume", bid)
        self.assertEqual(sim.controller.batches[bid].state, "broadcast")
        self.assertEqual([t for t in sim.chain.txs if t.startswith("commit-")],
                         [f"commit-{bid}"])

    def test_J4_restore_marks_members_issuing_before_cancellation(self):
        sim = setup()
        bid = prepare(sim)
        sim.do("sim", "set_offhost", False, "store")
        with self.assertRaises(Refused):
            issue(sim, bid)
        self.assertTrue(sim.controller.offhost["batches"][bid].intent)
        self.assertEqual(sim.store.offhost["orders"]["o1"].status, "converted")
        sim.do("sim", "host_loss")
        self.assertEqual(sim.controller.batches[bid].state, "broadcast_uncertain")
        self.assertEqual(sim.store.orders["o1"].status, "issuing")
        with self.assertRaises(Refused):
            sim.do("store", "cancel", "o1")

    def test_J5_unacknowledged_refund_is_never_rebroadcast(self):
        sim = new_sim()
        refund_due_order(sim)
        sim.do("sim", "set_offhost", False, "store")
        sim.do("store", "open_group", "g1", "o1", "cancellation",
               refund_tx("a1", [("sc1", 0)], 9_700), 9_700, FEE)
        with self.assertRaises(Refused):
            sim.do("store", "rebroadcast", "g1", "a1")
        self.assertNotIn("a1", sim.chain.txs)
        sim.do("sim", "set_offhost", True, "store")
        sim.do("store", "advance", 0)
        sim.do("store", "rebroadcast", "g1", "a1")
        self.assertTrue(sim.chain.in_mempool("a1"))

    def test_J6_restored_resume_journals_the_intent_first(self):
        sim = setup()
        bid = prepare(sim)
        sim.do("sim", "set_offhost", False, "controller")
        with self.assertRaises(Refused):
            issue(sim, bid)
        sim.do("sim", "host_loss")
        b = sim.controller.batches[bid]
        self.assertEqual((b.state, b.intent), ("issuing", False))
        sim.do("sim", "set_offhost", True, "controller")
        sim.do("controller", "resume", bid)
        self.assertTrue(sim.controller.offhost["batches"][bid].intent)
        self.assertTrue(sim.chain.in_mempool(f"commit-{bid}"))
        with self.assertRaises(Refused):
            sim.do("controller", "rollback_local", bid)
        self.assertEqual(b.state, "broadcast")

    def test_J7_late_acknowledged_intent_resumes_once(self):
        sim = setup()
        bid = prepare(sim)
        sim.do("sim", "set_offhost", False, "controller")
        with self.assertRaises(Refused):
            issue(sim, bid)
        sim.do("sim", "set_offhost", True, "controller")
        mine_empty(sim)  # an unrelated acknowledgment journals the intent
        self.assertTrue(sim.controller.offhost["batches"][bid].intent)
        sim.do("controller", "resume", bid, "lost")
        self.assertEqual(sim.controller.batches[bid].state, "broadcast_uncertain")
        with self.assertRaises(Refused):
            sim.do("controller", "resume", bid)
        self.assertEqual([t for t in sim.chain.txs if t.startswith("commit-")],
                         [f"commit-{bid}"])

    def test_J8_restore_reads_back_before_trusting_ready(self):
        # Found by a 300-seed generated run: the store's journal was ahead of
        # the controller's.
        sim = setup()
        bid = prepare(sim)
        issue(sim, bid, outcome="lost")
        sim.do("sim", "set_offhost", False, "controller")
        self.assertTrue(sim.do("controller", "readback", bid))
        finalize(sim)
        self.assertEqual(sim.store.orders["o1"].status, "ready")
        self.assertEqual(sim.controller.offhost["batches"][bid].state, "broadcast_uncertain")
        sim.do("sim", "host_loss")
        self.assertEqual(sim.controller.batches[bid].state, "final")
        self.assertEqual(sim.controller.batches[bid].txid, f"commit-{bid}")
        self.assertEqual(sim.store.orders["o1"].status, "ready")

    def test_J9_resume_repeats_the_binding_check(self):
        for host_loss in (False, True):
            with self.subTest(host_loss=host_loss):
                sim = new_sim(names=NAMES)
                converted_order(sim, oid="o2", name="n2", depth=10)
                converted_order(sim, oid="o1", name="n1", depth=3)
                bid = prepare(sim)
                sim.do("sim", "set_offhost", False, "controller")
                with self.assertRaises(Refused):
                    issue(sim, bid)
                sim.do("chain", "reorg", 3, [[]] * 4)
                sim.do("chain", "drop", "t-o1")
                self.assertEqual(sim.chain.conf("t-o1"), 0)
                if host_loss:
                    sim.do("sim", "host_loss")
                sim.do("sim", "set_offhost", True, "controller")
                nb = sim.do("controller", "resume", bid)
                self.assertFalse(any(t.startswith("commit-") for t in sim.chain.txs))
                self.assertEqual(sim.controller.batches[bid].state, "rebuilt")
                self.assertEqual(sim.controller.offhost["batches"][bid].state, "rebuilt")
                self.assertEqual(sim.controller.batches[nb].members, ["o2"])
                o1 = sim.store.orders["o1"]
                self.assertEqual(o1.status, "converted")
                self.assertIn("issuance", o1.reasons)
                self.assertEqual(sim.store.names["n1"].fulfillment, "o1")
                self.assertEqual(sim.store.orders["o2"].status, "converted")

    def test_J9_unacknowledged_rebuild_keeps_the_batch_issuing(self):
        sim = setup(depth=3)
        bid = prepare(sim)
        sim.do("sim", "set_offhost", False, "controller")
        with self.assertRaises(Refused):
            issue(sim, bid)
        sim.do("chain", "reorg", 3, [[]] * 4)
        sim.do("chain", "drop", "t-o1")
        with self.assertRaises(Refused):
            sim.do("controller", "resume", bid)
        self.assertEqual(sim.controller.batches[bid].state, "issuing")
        self.assertEqual(sim.store.orders["o1"].status, "issuing")
        self.assertFalse(any(t.startswith("commit-") for t in sim.chain.txs))

    def test_J10_restore_never_leaves_a_superseded_member_ready(self):
        sim = setup()
        bid = prepare(sim)
        issue(sim, bid)
        sim.do("sim", "set_offhost", False, "controller")
        finalize(sim)
        sim.do("sim", "set_offhost", False, "store")
        self.assertEqual(sim.controller.offhost["batches"][bid].state, "broadcast")
        self.assertEqual(sim.store.offhost["orders"]["o1"].status, "ready")
        txid = f"commit-{bid}"
        depth = sim.chain.conf(txid)
        sim.do("chain", "reorg", depth, [[] for _ in range(depth + 1)])
        sim.do("chain", "drop", txid)
        sim.do("controller", "owner_supersede", bid, "rollback-1")
        sim.do("chain", "mine", ["rollback-1"])
        mine_empty(sim, 5)
        sim.do("sim", "host_loss")
        self.assertEqual(sim.controller.batches[bid].state, "superseded")
        self.assertEqual(sim.store.orders["o1"].status, "converted")
        self.assertFalse(sim.controller.certificate_current("o1"))
        sim.do("sim", "set_offhost", True)
        sim.do("store", "cancel", "o1")

    def test_J11_payment_instructions_wait_for_the_acknowledgment(self):
        sim = new_sim(names=("n1", "n2"))
        sim.do("store", "advance", 0)
        # Known down: refused, with no order and no hold.
        sim.do("sim", "set_offhost", False, "store")
        with self.assertRaises(Refused):
            sim.do("store", "quote", "o1", "n1", "s-o1")
        self.assertNotIn("o1", sim.store.orders)
        self.assertIsNone(sim.store.names["n1"].hold)
        sim.do("sim", "set_offhost", True, "store")
        # Recorded, but the acknowledgment doesn't arrive: no instructions.
        sim.store.auto_ack = False
        self.assertIsNone(sim.do("store", "quote", "o1", "n1", "s-o1"))
        self.assertEqual(sim.store.orders["o1"].status, "quoted")
        self.assertIsNone(sim.store.instructions("o1"))
        sim.do("sim", "host_loss")
        self.assertNotIn("o1", sim.store.orders)
        self.assertIsNone(sim.store.names["n1"].hold)
        # Acknowledged: the script is given out, and survives a loss.
        sim.store.auto_ack = True
        self.assertEqual(sim.do("store", "quote", "o2", "n2", "s-o2"), "s-o2")
        sim.do("sim", "host_loss")
        self.assertEqual(sim.store.instructions("o2"), "s-o2")
        self.assertEqual(sim.store.names["n2"].hold.oid, "o2")

    def test_J12_a_cancellation_is_final_only_once_acknowledged(self):
        sim = setup(orders=2)
        self.assertTrue(sim.do("store", "cancel", "o2"))
        sim.do("sim", "set_offhost", False, "store")
        self.assertFalse(sim.do("store", "cancel", "o1"))
        self.assertFalse(sim.do("store", "cancel", "o1"))
        self.assertEqual(sim.store.orders["o1"].status, "cancelled")
        sim.do("sim", "host_loss")
        self.assertEqual(sim.store.orders["o1"].status, "converted")
        self.assertEqual(sim.store.names["n1"].fulfillment, "o1")
        self.assertEqual(sim.store.orders["o2"].status, "cancelled")
        self.assertIsNone(sim.store.names["n2"].fulfillment)
        sim.do("sim", "set_offhost", True, "store")
        self.assertTrue(sim.do("store", "cancel", "o1"))

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


class FinalityPublicationDelivery(unittest.TestCase):
    def _final(self):
        sim = setup()
        bid = prepare(sim)
        issue(sim, bid)
        finalize(sim)
        self.assertEqual(sim.controller.batches[bid].state, "final")
        self.assertEqual(sim.store.orders["o1"].status, "ready")
        return sim, bid

    def _refused_until_final(self, sim, bid):
        for call in (("controller", "publish", bid, ["o1"]),
                     ("controller", "confirm_delivery", bid, "o1"),
                     ("store", "cancel", "o1")):
            with self.assertRaises(Refused):
                sim.do(*call)

    def test_L1_lost_finality_reverts_ready_and_blocks_delivery(self):
        # Below d >= 150, still mined.
        sim, bid = self._final()
        lose_finality(sim, f"commit-{bid}")
        self.assertEqual(sim.controller.batches[bid].state, "mined")
        self.assertIn(("finality_lost", bid), sim.controller.alerts)
        self.assertEqual(sim.store.orders["o1"].status, "issuing")
        self._refused_until_final(sim, bid)
        # Off the chain entirely.
        sim, bid = self._final()
        txid = f"commit-{bid}"
        depth = sim.chain.conf(txid)
        sim.do("chain", "reorg", depth, [[] for _ in range(depth + 1)])
        sim.do("chain", "drop", txid)
        self.assertEqual(sim.chain.conf(txid), 0)
        self.assertEqual(sim.controller.batches[bid].state, "broadcast")
        self.assertEqual(sim.store.orders["o1"].status, "issuing")
        self.assertEqual(sim.controller.delegate, ("delegate-genesis", 0))
        self._refused_until_final(sim, bid)

    def test_L2_regained_finality_resumes_publication(self):
        sim, bid = self._final()
        removed = lose_finality(sim, f"commit-{bid}")
        self.assertEqual(sim.store.orders["o1"].status, "issuing")
        mine_empty(sim, removed)
        self.assertEqual(sim.controller.batches[bid].state, "final")
        self.assertEqual(sim.store.orders["o1"].status, "ready")
        self.assertEqual(sim.do("controller", "publish", bid, ["o1"]), 1)
        sim.do("controller", "confirm_delivery", bid, "o1")
        self.assertEqual(sim.store.orders["o1"].status, "fulfilled")

    def test_L3_delivery_needs_publication(self):
        sim, bid = self._final()
        with self.assertRaises(Refused):
            sim.do("controller", "confirm_delivery", bid, "o1")
        sim.do("controller", "publish", bid, ["o1"])
        sim.do("controller", "confirm_delivery", bid, "o1")
        self.assertEqual(sim.store.orders["o1"].status, "fulfilled")

    def test_L4_fulfilled_member_survives_a_later_supersession(self):
        # Found by a 300-seed generated run.
        sim, bid = self._final()
        sim.do("controller", "publish", bid, ["o1"])
        sim.do("controller", "confirm_delivery", bid, "o1")
        txid = f"commit-{bid}"
        depth = sim.chain.conf(txid)
        sim.do("chain", "reorg", depth, [[] for _ in range(depth + 1)])
        sim.do("chain", "drop", txid)
        self.assertIn(("fulfilled_without_finality", "o1"), sim.controller.alerts)
        sim.do("controller", "owner_supersede", bid, "rollback-1")
        sim.do("chain", "mine", ["rollback-1"])
        mine_empty(sim, 5)
        self.assertEqual(sim.controller.batches[bid].state, "superseded")
        o1 = sim.store.orders["o1"]
        self.assertEqual(o1.status, "fulfilled")
        self.assertIn(("fulfilled_superseded", "o1"), sim.controller.alerts)
        self.assertEqual(o1.incident.kinds, ["finality_lost", "superseded"])
        self.assertIsNone(o1.incident.resolution)
        self.assertFalse(sim.controller.certificate_current("o1"))
        self.assertEqual(sim.store.names["n1"].fulfillment, "o1")
        self.assertEqual(sim.store.groups, {})
        with self.assertRaises(Refused):
            sim.do("store", "cancel", "o1")

    def test_L5_incident_needs_an_operator_resolution(self):
        sim, bid = self._final()
        sim.do("controller", "publish", bid, ["o1"])
        sim.do("controller", "confirm_delivery", bid, "o1")
        self.assertTrue(sim.controller.certificate_current("o1"))
        self.assertIsNone(sim.store.orders["o1"].incident)
        removed = lose_finality(sim, f"commit-{bid}")
        o1 = sim.store.orders["o1"]
        self.assertFalse(sim.controller.certificate_current("o1"))
        self.assertEqual(o1.incident.kinds, ["finality_lost"])
        # The incident is durable: it survives a host loss.
        sim.do("sim", "host_loss")
        o1 = sim.store.orders["o1"]
        self.assertEqual(o1.incident.kinds, ["finality_lost"])
        # Regaining finality makes the certificate current, but only the
        # operator closes the incident.
        mine_empty(sim, removed)
        self.assertTrue(sim.controller.certificate_current("o1"))
        self.assertIsNone(o1.incident.resolution)
        with self.assertRaises(Refused):
            sim.do("store", "resolve_incident", "o1", "")
        before = sim.obligations()
        sim.do("store", "resolve_incident", "o1", "commitment final again; delivery stands")
        self.assertEqual(o1.incident.resolution, "commitment final again; delivery stands")
        self.assertEqual(sim.obligations(), before)
        self.assertEqual(o1.status, "fulfilled")
        with self.assertRaises(Refused):
            sim.do("store", "resolve_incident", "o1", "again")

    def test_L6_ready_waits_for_anchor_coverage(self):
        # Regtest R11: at d = 150 the newest root anchor can trail by up to 35
        # blocks, and the certificate then verifies as pending.
        sim = setup()
        bid = prepare(sim)
        while (sim.chain.tip + 1 + 150) % 36 != 12:
            mine_empty(sim)
        issue(sim, bid)
        mine(sim)
        mine_empty(sim, 150)
        ctl = sim.controller
        h = sim.chain.position(f"commit-{bid}")[0]
        self.assertEqual(ctl.batches[bid].state, "final")
        self.assertEqual(ctl.newest_anchor() - h, 138)
        self.assertEqual(ctl.certificate_status("o1"), "awaiting_anchor")
        self.assertEqual(sim.store.orders["o1"].status, "issuing")
        self._refused_until_final(sim, bid)
        # Waiting, not a failed verification: nothing is paused.
        self.assertIsNone(ctl.paused_at)
        self.assertFalse(any(a[0] in ("rebuilds", "recovery_paused") for a in ctl.alerts))
        mine_empty(sim, 23)
        self.assertEqual(ctl.certificate_status("o1"), "awaiting_anchor")
        mine_empty(sim, 1)
        self.assertEqual(ctl.newest_anchor() - h, 174)
        self.assertEqual(ctl.certificate_status("o1"), "verified")
        self.assertEqual(sim.store.orders["o1"].status, "ready")
        self.assertEqual(sim.do("controller", "publish", bid, ["o1"]), 1)

    def test_L9_delivery_waits_for_the_root_the_certificate_was_built_on(self):
        # Regtest R24: subs builds a handle's certificate against the space's
        # latest on-chain commitment when the handle is published, so it can
        # prove inclusion in a later root than its batch's.
        for published_before_later in (False, True):
            with self.subTest(published_before_later=published_before_later):
                sim, b1 = self._final()
                ctl = sim.controller
                if published_before_later:
                    sim.do("controller", "publish", b1, ["o1"])
                converted_order(sim, oid="o2", name="n2", depth=10)
                b2 = prepare(sim)
                issue(sim, b2)
                mine(sim)
                mine_empty(sim, 149)
                h2 = sim.chain.position(f"commit-{b2}")[0]
                self.assertEqual(sim.chain.tip - h2, 149)
                self.assertEqual(ctl.batches[b1].state, "final")
                self.assertEqual(ctl._certificates(ctl.batches[b1]), "verified")
                if published_before_later:
                    # Built on b1's root, which is final and covered.
                    sim.do("controller", "confirm_delivery", b1, "o1")
                    self.assertEqual(sim.store.orders["o1"].status, "fulfilled")
                    continue
                # The batch's own root allows publication; the certificate is
                # built on b2's root at d = 149.
                self.assertEqual(sim.do("controller", "publish", b1, ["o1"]), 1)
                self.assertEqual(ctl.batches[b1].served_under["o1"], b2)
                with self.assertRaises(Refused):
                    sim.do("controller", "confirm_delivery", b1, "o1")
                self.assertEqual(sim.store.orders["o1"].status, "ready")
                mine_empty(sim)
                self.assertEqual(ctl.batches[b2].state, "final")
                if ctl._certificates(ctl.batches[b2]) == "awaiting_anchor":
                    with self.assertRaises(Refused):
                        sim.do("controller", "confirm_delivery", b1, "o1")
                    cover(sim)
                # Waiting, not a failure: nothing paused, no alert.
                self.assertIsNone(ctl.paused_at)
                self.assertFalse(any(a[1] == b1 for a in ctl.alerts if len(a) > 1))
                sim.do("controller", "confirm_delivery", b1, "o1")
                self.assertEqual(sim.store.orders["o1"].status, "fulfilled")

    def test_L7_lost_commitment_returns_from_journaled_bytes(self):
        # Regtest R10: after a deep reorg the commitment was in no mempool.
        sim, bid = self._final()
        txid = f"commit-{bid}"
        raw = sim.controller.offhost["batches"][bid].raw
        self.assertEqual(raw, sim.chain.txs[txid])
        depth = sim.chain.conf(txid)
        sim.do("chain", "reorg", depth, [[] for _ in range(depth + 1)])
        sim.do("chain", "drop", txid)
        self.assertFalse(sim.chain.in_mempool(txid))
        self.assertEqual(sim.controller.batches[bid].state, "broadcast")
        with self.assertRaises(Refused):
            sim.do("controller", "retry_broadcast", bid)
        sim.do("controller", "rebroadcast_commitment", bid)
        self.assertTrue(sim.chain.in_mempool(txid))
        self.assertEqual(sim.chain.txs[txid], raw)
        self.assertEqual([t for t in sim.chain.txs if t.startswith("commit-")], [txid])
        with self.assertRaises(Refused):
            sim.do("controller", "rebroadcast_commitment", bid)
        finalize(sim)
        self.assertEqual(sim.controller.batches[bid].state, "final")
        self.assertEqual(sim.store.orders["o1"].status, "ready")

    def test_L8_without_journaled_bytes_recovery_pauses(self):
        # Answer lost, then evicted before any readback saw it: no bytes.
        sim = setup()
        bid = prepare(sim)
        issue(sim, bid, outcome="lost")
        sim.do("chain", "drop", f"commit-{bid}")
        self.assertFalse(sim.do("controller", "readback", bid))
        with self.assertRaises(Refused):
            sim.do("controller", "rebroadcast_commitment", bid)
        b = sim.controller.batches[bid]
        self.assertTrue(b.recovery_paused)
        self.assertIn(("recovery_paused", bid), sim.controller.alerts)
        self.assertTrue(sim.controller.offhost["batches"][bid].recovery_paused)
        for call in (("controller", "retry_broadcast", bid),
                     ("store", "cancel", "o1"),
                     ("controller", "freeze")):
            with self.assertRaises(Refused):
                sim.do(*call)
        self.assertEqual(sim.store.orders["o1"].status, "issuing")
        self.assertFalse(sim.chain.in_mempool(f"commit-{bid}"))
        # With the prepare/send split (U1(c)) the bytes are journaled before
        # the send, and the same failure is recoverable without the owner.
        sim = setup(journal_bytes_before_send=True)
        bid = prepare(sim)
        issue(sim, bid, outcome="unsent")
        self.assertIsNotNone(sim.controller.offhost["batches"][bid].raw)
        sim.do("controller", "rebroadcast_commitment", bid)
        self.assertTrue(sim.do("controller", "readback", bid))
        finalize(sim)
        self.assertEqual(sim.store.orders["o1"].status, "ready")


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
