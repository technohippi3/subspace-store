"""Seeded generated event sequences with invariant checks after every step,
plus replay and cut-and-resume checks. Model only.

Every transmission is also checked at the moment it happens: a commitment
or refund transaction reaching the simulated network must already have its
journal entries acknowledged off-host. Checking the latest snapshot after
the step can't see the order of the two.

Set SUBSPACE_MODEL_RUNS and SUBSPACE_MODEL_STEPS to run longer.
"""

import os
import random
import unittest

from model.chain import Tx
from model.sim import Sim
from model.controller import FINAL_D
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
        self.sends = 0
        self.resumed = 0
        self.statuses = {}
        self.violations = []
        self._hook_sends()

    def _hook_sends(self):
        """Check acknowledgment immediately before each transmission."""
        chain, ctl, st = self.sim.chain, self.sim.controller, self.sim.store
        add = chain.add

        def checked_add(tx):
            if tx.txid.startswith("commit-"):
                self.sends += 1
                bid = tx.txid[len("commit-"):]
                acked = (ctl.offhost or {}).get("batches", {}).get(bid)
                orders = (st.offhost or {}).get("orders", {})
                root = tx.outputs[1][0]
                ok = (acked is not None and acked.intent
                      and f"op_return:{acked.root}" == root
                      and (acked.delegate_in,) == tx.inputs
                      and all(orders.get(m) is not None and orders[m].status == "issuing"
                              for m in acked.members))
                if not ok:
                    self.violations.append(f"{tx.txid} sent before both journals acknowledged")
            elif tx.txid.startswith("a"):
                gid = next((g.gid for g in st.groups.values() if tx.txid in g.txids()), None)
                groups = (st.offhost or {}).get("groups", {})
                if gid is None or gid not in groups or tx.txid not in groups[gid].txids():
                    self.violations.append(f"{tx.txid} sent before its journal entry was acknowledged")
            return add(tx)

        chain.add = checked_add

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
                   "batch": 3, "send": 3, "readback": 1, "supersede": 0.6,
                   "finality": 1, "publish": 1.5, "deliver": 2, "outage": 0.8, "recover": 1,
                   "host_loss": 0.5, "resume": 3, "rebroadcast": 1, "rollback": 0.5,
                   "deep_reorg": 0.15}
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
            # Continue the open batch being prepared, or freeze a new one.
            stages = {"frozen": "commit_local", "committed_local": "prove",
                      "proved": "checkpoint"}
            try:
                prep = [b for b in s.controller.batches.values() if b.state in stages]
                bid = prep[0].bid if prep else s.do("controller", "freeze")
                while s.controller.batches[bid].state in stages:
                    s.do("controller", stages[s.controller.batches[bid].state], bid)
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
        elif op == "publish":
            for b in s.controller.batches.values():
                if b.state in ("final", "mined"):
                    handles = [m for m in b.members if r.random() < 0.7]
                    s.try_do("controller", "publish", b.bid, handles)
        elif op == "deliver":
            for b in s.controller.batches.values():
                if b.state in ("final", "mined"):
                    for m in b.members:
                        if st.orders[m].status in ("ready", "issuing"):
                            s.try_do("controller", "confirm_delivery", b.bid, m)
        elif op == "outage":
            # The two journals fail together or independently.
            s.do("sim", "set_offhost", r.random() < 0.7,
                 r.choice(["both", "store", "controller"]))
        elif op == "recover":
            s.do("sim", "set_offhost", True)
        elif op == "host_loss":
            s.do("sim", "host_loss")
        elif op == "resume":
            stuck = [b for b in s.controller.batches.values() if b.state == "issuing"]
            if stuck and s.try_do("controller", "resume", r.choice(stuck).bid,
                                  r.choice(["ok", "ok", "lost", "unsent"])):
                self.resumed += 1
        elif op == "rebroadcast" and st.groups:
            g = r.choice(list(st.groups.values()))
            s.try_do("store", "rebroadcast", g.gid, r.choice(g.attempts).tx.txid)
        elif op == "rollback" and s.controller.batches:
            s.try_do("controller", "rollback_local",
                     r.choice(list(s.controller.batches.values())).bid)
        elif op == "deep_reorg":
            # A reorg across commitment finality, which sometimes drops the
            # commitment and sometimes mines it again later.
            final = [b for b in s.controller.batches.values()
                     if b.txid and s.chain.position(b.txid) is not None]
            if final:
                b = r.choice(final)
                depth = s.chain.tip - s.chain.position(b.txid)[0] + 1
                if r.random() < 0.5:
                    s.do("chain", "reorg", depth, [[] for _ in range(depth + 1)])
                    s.do("chain", "drop", b.txid)
                else:
                    s.do("chain", "reorg", depth, [[]] + [None] * depth)


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
    test.assertEqual(gen.violations, [])
    # One commitment per delegate output: no two commitment transactions known
    # to the simulated network spend the same outpoint.
    spent = {}
    for txid, tx in chain.txs.items():
        if txid.startswith("commit-"):
            for op in tx.inputs:
                test.assertNotIn(op, spent, f"{txid} competes with {spent.get(op)}")
                spent[op] = txid
    # A final batch is final on the current chain, and its members are never
    # merely paid.
    for b in ctl.batches.values():
        if b.state == "final":
            pos = chain.position(b.txid)
            test.assertTrue(pos is not None and chain.tip - pos[0] >= FINAL_D, b.bid)
        if b.state not in ("rebuilt", "superseded") and (
                b.intent or b.state in ("broadcast", "broadcast_uncertain", "mined", "final")):
            for m in b.members:
                test.assertNotIn(st.orders[m].status, ("converted", "cancelled"),
                                 (b.bid, m, b.state))
    # Ready means final on the current chain; delivery happens only then, and
    # only after publication.
    for o in st.orders.values():
        b = next((b for b in ctl.batches.values() if o.oid in b.members
                  and b.state in issued_states), None)
        if o.status == "ready":
            test.assertEqual(b.state, "final", o.oid)
        if o.status == "fulfilled" and gen.statuses.get(o.oid) != "fulfilled":
            pos = chain.position(b.txid)
            test.assertTrue(pos is not None and chain.tip - pos[0] >= FINAL_D,
                            f"{o.oid} delivered without finality")
            test.assertIn(o.oid, b.published)
            test.assertTrue(ctl.certificate_current(o.oid))
        gen.statuses[o.oid] = o.status
    for txid in chain.txs:
        if txid.startswith("commit-"):
            bid = txid[len("commit-"):]
            acked = ctl.offhost["batches"].get(bid)
            test.assertTrue(acked is not None and acked.intent,
                            f"{txid} escaped without an acknowledged intent")
    for o in st.orders.values():
        if o.status == "fulfilled" and not ctl.certificate_current(o.oid):
            # Fulfilled records a delivery, not a valid certificate: without
            # current finality there is a durable recovery incident.
            test.assertIsNotNone(o.incident, o.oid)
        if o.status == "fulfilled" and o.oid not in seen_members:
            test.assertTrue(set(o.incident.kinds) & {"superseded", "no_live_batch"}, o.oid)
        elif o.status in ("issuing", "ready", "fulfilled"):
            test.assertIn(o.oid, seen_members, (o.oid, o.status))
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
        # Supersession and resume are also covered by the scripted scenarios
        # below, so their coverage doesn't depend on these weights.
        for expected in ("final", "broadcast_uncertain", "rebuilt", "ready", "fulfilled"):
            self.assertIn(expected, states)

    def test_generator_reaches_the_repair_paths(self):
        """Lost finality, and both journals failing independently, occur."""
        lost = 0
        outages = set()
        for seed in range(RUNS):
            gen = Generator(seed)
            for _ in range(STEPS):
                gen.step()
            lost += sum(1 for a in gen.sim.controller.alerts if a[0] == "finality_lost")
            outages |= {args[1] for t, m, args, kw in gen.sim.journal
                        if m == "set_offhost" and not args[0]}
        self.assertGreater(lost, 0)
        self.assertEqual(outages, {"both", "store", "controller"})

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


class Scripted:
    """A fixed event sequence run under the same invariant checks, after
    every step, as the generated runs, including the send-time check."""

    def __init__(self, test):
        self.test = test
        self.gen = Generator(0)
        self.sim = self.gen.sim

    def do(self, *call, refused=False):
        if refused:
            with self.test.assertRaises(Refused):
                self.sim.do(*call)
            result = None
        else:
            result = self.sim.do(*call)
        check(self.gen, self.test)
        return result

    def paid(self, oid, name, depth):
        self.do("store", "quote", oid, name, f"s-{oid}")
        self.do("chain", "add", Tx(f"t-{oid}", ((f"coin-t-{oid}", 0),), ((f"s-{oid}", PRICE),)))
        self.do("chain", "mine")
        for _ in range(depth - 1):
            self.do("chain", "mine", [])

    def prepared(self, members=None):
        bid = self.do("controller", "freeze", members)
        for stage in ("commit_local", "prove", "checkpoint"):
            self.do("controller", stage, bid)
        return bid

    def blocks(self, n):
        for _ in range(n):
            self.do("chain", "mine")

    def remove(self, txid):
        depth = self.sim.chain.conf(txid)
        self.do("chain", "reorg", depth, [[] for _ in range(depth + 1)])
        self.do("chain", "drop", txid)


class ScriptedScenarios(unittest.TestCase):
    """Targeted sequences for resume, supersession and restore, so their
    coverage doesn't depend on the generator's weights. Model only."""

    def test_resume_after_each_kind_of_outage(self):
        for which in ("store", "controller", "both"):
            with self.subTest(which=which):
                sc = Scripted(self)
                sc.paid("o1", "n1", 10)
                bid = sc.prepared()
                sc.do("sim", "set_offhost", False, which)
                sc.do("controller", "check_and_issue", bid, refused=True)
                sc.do("controller", "resume", bid, refused=True)
                sc.do("sim", "set_offhost", True)
                sc.do("controller", "resume", bid)
                sc.do("controller", "resume", bid, refused=True)
                sc.blocks(151)
                sc.do("controller", "publish", bid, ["o1"])
                sc.do("controller", "confirm_delivery", bid, "o1")
                self.assertEqual(sc.sim.store.orders["o1"].status, "fulfilled")

    def test_resume_after_payment_loss_rebuilds(self):
        for host_loss in (False, True):
            with self.subTest(host_loss=host_loss):
                sc = Scripted(self)
                sc.paid("o2", "n2", 10)
                sc.paid("o1", "n1", 3)
                bid = sc.prepared()
                sc.do("sim", "set_offhost", False, "controller")
                sc.do("controller", "check_and_issue", bid, refused=True)
                sc.remove("t-o1")
                if host_loss:
                    sc.do("sim", "host_loss")
                sc.do("sim", "set_offhost", True)
                nb = sc.do("controller", "resume", bid)
                self.assertNotEqual(nb, bid)
                self.assertEqual(sc.sim.controller.batches[nb].members, ["o2"])
                self.assertEqual(sc.gen.sends, 0)  # nothing transmitted

    def test_owner_supersession_then_rebatch(self):
        sc = Scripted(self)
        sc.paid("o1", "n1", 10)
        bid = sc.prepared()
        sc.do("controller", "check_and_issue", bid, "unsent")
        sc.do("controller", "readback", bid)
        sc.do("store", "cancel", "o1", refused=True)
        sc.do("controller", "owner_supersede", bid, "rb-1")
        sc.do("chain", "mine", ["rb-1"])
        for _ in range(5):
            sc.do("chain", "mine", [])
        self.assertEqual(sc.sim.controller.batches[bid].state, "superseded")
        self.assertEqual(sc.sim.store.orders["o1"].status, "converted")
        nb = sc.prepared()
        sc.do("controller", "check_and_issue", nb)
        self.assertEqual(sc.sim.chain.txs[f"commit-{nb}"].inputs, (("rb-1", 0),))

    def test_stale_controller_journal_supersession_and_restore(self):
        for delivered in (False, True):
            with self.subTest(delivered=delivered):
                sc = Scripted(self)
                sc.paid("o1", "n1", 10)
                bid = sc.prepared()
                sc.do("controller", "check_and_issue", bid)
                sc.do("sim", "set_offhost", False, "controller")
                sc.blocks(151)
                if delivered:
                    sc.do("controller", "publish", bid, ["o1"])
                    sc.do("controller", "confirm_delivery", bid, "o1")
                sc.do("sim", "set_offhost", False, "store")
                sc.remove(f"commit-{bid}")
                sc.do("controller", "owner_supersede", bid, "rb-1")
                sc.do("chain", "mine", ["rb-1"])
                for _ in range(5):
                    sc.do("chain", "mine", [])
                sc.do("sim", "host_loss")
                sc.do("sim", "set_offhost", True)
                o1 = sc.sim.store.orders["o1"]
                self.assertEqual(sc.sim.controller.batches[bid].state, "superseded")
                if delivered:
                    self.assertEqual(o1.status, "fulfilled")
                    self.assertIn("superseded", o1.incident.kinds)
                    sc.do("store", "resolve_incident", "o1", "operator reissues by hand")
                else:
                    self.assertEqual(o1.status, "converted")
                    sc.do("store", "cancel", "o1")


if __name__ == "__main__":
    unittest.main()
