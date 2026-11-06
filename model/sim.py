"""A journaled harness around the chain and the store.

Every call is appended to a journal before it runs, so a run can be replayed
from scratch, or cut at any point and resumed, and its durable obligations
compared with an uninterrupted run.
"""

from .chain import Chain
from .store import Refused, Store


class Sim:
    def __init__(self):
        self.chain = Chain()
        self.store = Store(self.chain)
        self.journal = []

    def do(self, target, method, *args, **kwargs):
        self.journal.append((target, method, args, kwargs))
        obj = self.chain if target == "chain" else self.store
        try:
            return getattr(obj, method)(*args, **kwargs)
        finally:
            if target == "chain":
                self.store.observe()

    def try_do(self, target, method, *args, **kwargs):
        try:
            self.do(target, method, *args, **kwargs)
            return True
        except Refused:
            return False

    @classmethod
    def replay(cls, journal):
        sim = cls()
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
            "tip": self.chain.tip,
        }
