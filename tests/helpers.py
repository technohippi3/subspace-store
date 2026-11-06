"""Shared helpers for the named model cases."""

from model.chain import Tx
from model.sim import Sim

PRICE = 10_000
FEE = 300


def new_sim(price=PRICE, names=("n1",)):
    sim = Sim()
    for name in names:
        sim.do("store", "list_name", name, price)
    return sim


def pay_tx(txid, script, value, *more_outputs):
    return Tx(txid, ((f"coin-{txid}", 0),), ((script, value),) + tuple(more_outputs))


def pay(sim, txid, script, value, *more_outputs):
    tx = pay_tx(txid, script, value, *more_outputs)
    sim.do("chain", "add", tx)
    return tx


def mine(sim, n=1):
    for _ in range(n):
        sim.do("chain", "mine")


def mine_empty(sim, n=1):
    for _ in range(n):
        sim.do("chain", "mine", [])


def refund_tx(txid, inputs, to_buyer, dest="buyer-refund-address"):
    return Tx(txid, tuple(inputs), ((dest, to_buyer),))


def converted_order(sim, oid="o1", paid=PRICE, depth=3, name="n1"):
    """Quote and pay an order, then leave its payment at `depth` confirmations."""
    sim.do("store", "quote", oid, name, f"s-{oid}")
    pay(sim, f"t-{oid}", f"s-{oid}", paid)
    mine(sim)
    mine_empty(sim, depth - 1)
    return sim.store.orders[oid]


def refund_due_order(sim, oid="o1", paid=PRICE, settle_depth=10):
    """Make `oid` refund due through a late payment while another order holds
    the name, with its payment `settle_depth` blocks deep."""
    store = sim.store
    sim.do("store", "quote", oid, "n1", f"s-{oid}")
    sim.do("store", "advance", 16)
    sim.do("store", "quote", "holder", "n1", "s-holder")
    pay(sim, f"t-{oid}", f"s-{oid}", paid)
    mine(sim)
    mine_empty(sim, settle_depth - 1)
    assert store.orders[oid].status == "refund_due", store.orders[oid].status
    return store.orders[oid]
