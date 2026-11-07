"""A journaled harness around the chain and the store.

Every call is appended to a journal before it runs, so a run can be replayed
from scratch, or cut at any point and resumed, and its durable obligations
compared with an uninterrupted run.
"""

from .chain import Chain
from .controller import Controller
from .store import Refused, Store


class Sim:
    def __init__(self, journal_bytes_before_send=False):
        """journal_bytes_before_send models the prepare/send split asked of
        `subs` (U1(c)): the signed commitment is journaled before the send."""
        self.config = {"journal_bytes_before_send": journal_bytes_before_send}
        self.chain = Chain()
        self.store = Store(self.chain)
        self.controller = Controller(self.chain, self.store, journal_bytes_before_send)
        self.journal = []

    def do(self, target, method, *args, **kwargs):
        self.journal.append((target, method, args, kwargs))
        if target == "sim":
            return getattr(self, "_" + method)(*args, **kwargs)
        obj = {"chain": self.chain, "store": self.store,
               "controller": self.controller}[target]
        try:
            return getattr(obj, method)(*args, **kwargs)
        finally:
            if target == "chain":
                self.store.observe()
                self.controller.observe()

    # Faults

    def _set_offhost(self, available, which="both"):
        """Make the off-host journals available or not, together or alone."""
        if which in ("both", "store"):
            self.store.offhost_available = available
        if which in ("both", "controller"):
            self.controller.offhost_available = available

    def _host_loss(self):
        """Lose the host: keep the chain, restore state from the off-host
        journal, then reconcile."""
        self.store.restore_from_offhost()
        self.controller.restore_from_offhost()
        self.store.observe()

    def try_do(self, target, method, *args, **kwargs):
        try:
            self.do(target, method, *args, **kwargs)
            return True
        except Refused:
            return False

    @classmethod
    def replay(cls, journal, **config):
        sim = cls(**config)
        for target, method, args, kwargs in journal:
            sim.try_do(target, method, *args, **kwargs)
        return sim

    def obligations(self):
        s = self.store
        return {
            "names": {k: (n.hold.oid if n.hold else None, n.fulfillment)
                      for k, n in sorted(s.names.items())},
            "orders": {k: (o.status, o.price_reserve, tuple(sorted(o.reasons)),
                           tuple(sorted(o.losses.items())))
                       for k, o in sorted(s.orders.items())},
            "groups": {k: (g.reservation(), g.closed_by, g.needs_rebuild,
                           len(g.attempts))
                       for k, g in sorted(s.groups.items())},
            "batches": {k: (b.state, tuple(b.members), b.txid)
                        for k, b in sorted(self.controller.batches.items())},
            "delegate": self.controller.delegate,
            "tip": self.chain.tip,
        }
