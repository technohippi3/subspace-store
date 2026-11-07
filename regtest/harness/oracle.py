"""The reference model as the oracle for a regtest run.

Each regtest scenario drives a `model.sim.Sim` through the same abstract
events in lockstep: quote, payment, blocks, freeze, local commit, proof,
checkpoint, `issuing` with an outcome, journal outages, reorgs, host loss.
At each step the report sets the state and refusals the model expects next
to what the real software did. A disagreement is a finding against the
specification. The model is never changed to match.

The model has one space with one delegate output, so each regtest space
gets its own Sim. Handles map to model orders by the registry's order id,
and names to model names one for one.
"""

from model.chain import Tx
from model.sim import Sim
from model.store import Refused


class Mirror:
    def __init__(self, price, base_height):
        self.sim = Sim()
        # Start the model's chain at the real tip, so heights, depths and the
        # model's root anchors (every 36 blocks) line up with the regtest
        # chain. Every regtest block mined after this is mirrored.
        self.sim.chain.__init__(base_height)
        self.price = price
        self.names = {}

    # Orders

    def list_name(self, handle):
        self.names[handle] = handle
        self.sim.do("store", "list_name", handle, self.price)

    def quote(self, oid, handle):
        return self._try("store", "quote", oid, handle, f"s-{oid}")

    def pay(self, oid, value):
        tx = Tx(f"t-{oid}", ((f"coin-{oid}", 0),), ((f"s-{oid}", value),))
        self.sim.do("chain", "add", tx)
        return tx.txid

    def mine(self, n=1):
        self.sim.do("chain", "mine")
        for _ in range(n - 1):
            self.sim.do("chain", "mine", [])

    def reorg(self, depth, replacement_blocks):
        self.sim.do("chain", "reorg", depth, [[] for _ in range(replacement_blocks)])

    def order_status(self, oid):
        return self.sim.store.orders[oid].status

    def reasons(self, oid):
        return sorted(self.sim.store.orders[oid].reasons)

    def cancel(self, oid):
        return self._try("store", "cancel", oid)

    # Batches

    def freeze(self, members=None):
        return self._try("controller", "freeze", members)

    def step(self, method, bid, *args):
        return self._try("controller", method, bid, *args)

    def drop(self, txid):
        self.sim.do("chain", "drop", txid)

    def certificate_status(self, oid):
        return self.sim.controller.certificate_status(oid)

    def batch_state(self, bid):
        return self.sim.controller.batches[bid].state

    def batch_members(self, bid):
        return list(self.sim.controller.batches[bid].members)

    def set_offhost(self, available, which):
        self.sim.do("sim", "set_offhost", available, which)

    def host_loss(self):
        self.sim.do("sim", "host_loss")

    def _try(self, target, method, *args):
        """(ok, value or refusal text)."""
        try:
            return True, self.sim.do(target, method, *args)
        except Refused as e:
            return False, str(e)
