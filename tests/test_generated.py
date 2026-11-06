"""Seeded generated event sequences with invariant checks after every step,
plus replay and cut-and-resume checks. Model only.

Set SUBSPACE_MODEL_RUNS and SUBSPACE_MODEL_STEPS to run longer.
"""

import os
import random
import unittest

from model.chain import Tx
from model.sim import Sim
from model.store import BATCHABLE, SETTLED, Refused

RUNS = int(os.environ.get("SUBSPACE_MODEL_RUNS", "40"))
STEPS = int(os.environ.get("SUBSPACE_MODEL_STEPS", "150"))
PRICE = 10_000


class Generator:
    def __init__(self, seed):
        self.r = random.Random(seed)
        self.sim = Sim()
        for name in ("n1", "n2"):
            self.sim.do("store", "list_name", name, PRICE)
        self.n = 0
        self.max_reservation = {}

    def uid(self, prefix):
        self.n += 1
        return f"{prefix}{self.n}"

    def step(self):
        s, r = self.sim, self.r
        st = s.store
        orders = list(st.orders.values())
        weights = {"quote": 3, "pay": 4, "mine": 6, "mine_empty": 3, "reorg": 2,
                   "vanish": 1, "advance": 1, "refund": 3, "broadcast": 2,
                   "bump": 1, "conflict": 1, "replace": 1, "cancel": 0.4,
                   "loss": 2, "drop": 1,
                   "batch": 3, "send": 3, "readback": 1, "supersede": 0.3,
                   "finality": 0.5, "deliver": 2, "outage": 0.5, "host_loss": 0.5}
        op = r.choices(list(weights), weights=list(weights.values()))[0]
        if op == "quote":
            s.try_do("store", "quote", self.uid("o"), r.choice(["n1", "n2"]),
                     self.uid("s"))
        elif op == "pay" and orders:
            o = r.choice(orders)
            value = r.choice([PRICE, PRICE, PRICE // 2, PRICE + 3_000, PRICE + 3_000, 4_000])
            txid = self.uid("t")
            outs = ((o.script, value),)
            if r.random() < 0.2:
                outs = ((o.script, value // 2), (o.script, value - value // 2))
            s.do("chain", "add", Tx(txid, ((f"coin-{txid}", 0),), outs))
        elif op == "mine":
            s.do("chain", "mine")
        elif op == "mine_empty":
            s.do("chain", "mine", [])
        elif op == "reorg" and s.chain.blocks:
            depth = min(len(s.chain.blocks), r.choice([1, 1, 2, 3, 5, 6, 7, 9]))
            new = [None if r.random() < 0.5 else [] for _ in range(depth + 1)]
            s.do("chain", "reorg", depth, new)
        elif op == "vanish" and s.chain.blocks:
            # A deep reorg whose replacement chain omits the removed payments.
            depth = min(len(s.chain.blocks), r.choice([4, 7, 10, 14]))
            removed = [t for b in s.chain.blocks[-depth:] for t in b if t.startswith("t")]
            s.do("chain", "reorg", depth, [[] for _ in range(depth + 1)])
            for txid in removed:
                s.do("chain", "drop", txid)
        elif op == "advance":
            s.do("store", "advance", r.choice([5, 10, 20]))
        elif op == "refund" and orders:
            o = r.choice(orders)
            kind = "cancellation" if o.status in ("cancelled", "refund_due") else "excess"
            avail = st.available(o)
            fee = 300
            to_buyer = max(1, avail - fee) if r.random() < 0.8 else avail + 500
            coin = (self.uid("sc"), 0)
            tx = Tx(self.uid("a"), (coin,), (("refund-addr", to_buyer),))
            s.try_do("store", "open_group", self.uid("g"), o.oid, kind, tx, to_buyer, fee)
        elif op == "broadcast" and st.groups:
            g = r.choice(list(st.groups.values()))
            a = r.choice(g.attempts)
            s.try_do("store", "broadcast", g.gid, a.tx.txid,
                     response_lost=r.random() < 0.2, reached_network=r.random() < 0.9)
        elif op == "bump" and st.groups:
            g = r.choice(list(st.groups.values()))
            first = g.attempts[0]
            tx = Tx(self.uid("a"), first.tx.inputs,
                    (("refund-addr", max(1, first.to_buyer - 300)),))
            s.try_do("store", "add_attempt", g.gid, tx,
                     max(1, first.to_buyer - 300), first.fee + 300)
        elif op == "conflict" and st.groups:
            g = r.choice(list(st.groups.values()))
            op_in = r.choice(g.attempts[0].tx.inputs)
            out = "refund-wallet" if r.random() < 0.5 else "elsewhere"
            s.do("chain", "add", Tx(self.uid("c"), (op_in,), ((out, 10_000),)))
        elif op == "replace" and st.groups:
            g = r.choice(list(st.groups.values()))
            conflicts = [t for t in s.chain.txs.values()
                         if t.txid.startswith("c") and t.outputs[0][0] == "refund-wallet"]
            src = (r.choice(conflicts).txid, 0) if conflicts and r.random() < 0.7 \
                else (self.uid("sc"), 0)
            a0 = g.attempts[0]
            tx = Tx(self.uid("a"), (src,), (("refund-addr", a0.to_buyer),))
            s.try_do("store", "add_attempt", g.gid, tx, a0.to_buyer, a0.fee)
        elif op == "cancel" and orders:
            s.try_do("store", "cancel", r.choice(orders).oid)
        elif op == "loss" and orders:
            o = r.choice(orders)
            if o.reasons:
                s.try_do("store", "record_loss", o.oid, r.choice(sorted(o.reasons)))
        elif op == "drop" and s.chain.mempool:
            s.do("chain", "drop", r.choice(s.chain.mempool))
        elif op == "batch":
            try:
                bid = s.do("controller", "freeze")
                for stage in ("commit_local", "prove", "checkpoint"):
                    s.do("controller", stage, bid)
            except Refused:
                pass
        elif op == "send":
            ready = [b for b in s.controller.batches.values() if b.state == "checkpointed"]
            if ready:
                s.try_do("controller", "check_and_issue", r.choice(ready).bid,
                         r.choice(["ok", "ok", "ok", "lost", "unsent"]))
        elif op == "readback":
            unsure = [b for b in s.controller.batches.values()
                      if b.state == "broadcast_uncertain"]
            if unsure:
                s.do("controller", "readback", r.choice(unsure).bid)
        elif op == "supersede":
            live = [b for b in s.controller.batches.values()
                    if b.state in ("broadcast", "broadcast_uncertain", "mined")]
            if live:
                s.do("controller", "owner_supersede", r.choice(live).bid, self.uid("rb"))
        elif op == "finality":
            for _ in range(r.choice([20, 150])):
                s.do("chain", "mine")
        elif op == "deliver":
            for b in s.controller.batches.values():
                if b.state == "final":
                    for m in b.members:
                        if st.orders[m].status == "ready":
                            s.try_do("controller", "confirm_delivery", b.bid, m)
        elif op == "outage":
            s.do("sim", "set_offhost", r.random() < 0.6)
        elif op == "host_loss":
            s.do("sim", "host_loss")


def check(gen, test):
    st = gen.sim.store
    chain = gen.sim.chain
    # Authorizations satisfied their inequality when made.
    for amount, available in st.authorizations:
        test.assertLessEqual(amount, available)
    for name, n in st.names.items():
        if n.hold is not None:
            test.assertEqual(st.orders[n.hold.oid].status, "quoted")
        if n.fulfillment is not None:
            test.assertIn(st.orders[n.fulfillment].status,
                          ("converted", "issuing", "ready", "fulfilled"))
        if n.hold is not None and n.fulfillment is not None:
            test.fail(f"{name} has a hold and a fulfillment reservation")
    for o in st.orders.values():
        # Each outpoint once.
        ops = [x["outpoint"] for x in st._outputs(o)]
        test.assertEqual(len(ops), len(set(ops)))
        if o.status in ("cancelled", "refund_due"):
            test.assertEqual(o.price_reserve, 0)
        # Reasons match an independent recomputation.
        batchable = sum(x["value"] for x in st._outputs(o) if x["conf"] >= BATCHABLE)
        settled = sum(x["value"] for x in st._outputs(o) if x["conf"] >= SETTLED)
        groups = [g for g in st.groups.values() if g.oid == o.oid]
        reserved = sum(max(a.charged for a in g.attempts) for g in groups if not g.closed_by)
        refunded = sum(g.attempt(g.closed_by).charged for g in groups if g.closed_by)
        test.assertEqual(st.reserved(o), reserved)
        shortfall = o.price_reserve - batchable if o.price_reserve > 0 else 0
        expected = {
            "issuance": shortfall if o.status == "converted" else 0,
            "post_issuance_deficit": shortfall if o.status in ("issuing", "ready", "fulfilled") else 0,
            "refunds": refunded + reserved - max(0, settled - o.price_reserve),
        }
        for reason, value in expected.items():
            active = value - o.losses.get(reason, 0) > 0
            test.assertEqual(reason in o.reasons, active, (o.oid, reason, value))
    ctl = gen.sim.controller
    issued_states = ("issuing", "broadcast", "broadcast_uncertain", "mined", "final")
    seen_members = {}
    for b in ctl.batches.values():
        if b.state in issued_states:
            for m in b.members:
                test.assertNotIn(m, seen_members, "order in two issued batches")
                seen_members[m] = b.bid
                test.assertNotEqual(st.orders[m].status, "cancelled")
    for txid in chain.txs:
        if txid.startswith("commit-"):
            bid = txid[len("commit-"):]
            acked = ctl.offhost["batches"].get(bid)
            test.assertTrue(acked is not None and acked.intent,
                            f"{txid} escaped without an acknowledged intent")
    for o in st.orders.values():
        if o.status in ("ready", "fulfilled"):
            test.assertIn(o.oid, seen_members)
    for g in st.groups.values():
        for a in g.attempts:
            if a.tx.txid in chain.txs:
                test.assertTrue(st.offhost is not None and a.tx.txid in
                                st.offhost["groups"].get(g.gid, g).txids()
                                if g.gid in st.offhost["groups"] else False,
                                f"{a.tx.txid} escaped without an acknowledged journal entry")
        mined = [a for a in g.attempts if chain.position(a.tx.txid) is not None]
        test.assertLessEqual(len(mined), 1, g.gid)
        res = g.reservation()
        test.assertGreaterEqual(res, gen.max_reservation.get(g.gid, 0))
        gen.max_reservation[g.gid] = res


class Generated(unittest.TestCase):
    def test_generated_sequences_hold_invariants(self):
        for seed in range(RUNS):
            gen = Generator(seed)
            for _ in range(STEPS):
                gen.step()
                check(gen, self)

    def test_generator_reaches_every_reason_and_loss(self):
        seen, losses = set(), 0
        for seed in range(RUNS):
            gen = Generator(seed)
            for _ in range(STEPS):
                gen.step()
                for o in gen.sim.store.orders.values():
                    seen |= o.reasons
            losses += sum(len(o.losses) for o in gen.sim.store.orders.values())
        self.assertEqual(seen, {"issuance", "post_issuance_deficit", "refunds"})
        self.assertGreater(losses, 0)

    def test_generator_reaches_the_issuance_states(self):
        states = set()
        for seed in range(RUNS):
            gen = Generator(seed)
            for _ in range(STEPS):
                gen.step()
                states |= {b.state for b in gen.sim.controller.batches.values()}
                states |= {o.status for o in gen.sim.store.orders.values()}
        for expected in ("final", "superseded", "broadcast_uncertain", "rebuilt",
                         "ready", "fulfilled"):
            self.assertIn(expected, states)

    def test_replay_and_cut_and_resume_match(self):
        for seed in range(RUNS):
            gen = Generator(seed)
            for _ in range(STEPS):
                gen.step()
            journal = gen.sim.journal
            self.assertEqual(Sim.replay(journal).obligations(), gen.sim.obligations())
            cut = random.Random(seed + 1000).randrange(len(journal) + 1)
            resumed = Sim.replay(journal[:cut])
            for target, method, args, kwargs in journal[cut:]:
                resumed.try_do(target, method, *args, **kwargs)
            self.assertEqual(resumed.obligations(), gen.sim.obligations())


if __name__ == "__main__":
    unittest.main()
