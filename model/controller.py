"""Batch issuance controller for fixed-price sales, simulated (MVP slice).

A reference model of the controller rules in CONTROLLER-DESIGN.md draft 4
and the batch, cancellation and restore cases of PAYMENT-SPEC.md draft 8. It
covers:
- batch entry and the binding pre-broadcast check, with rebuilds and a pause
  after three in a row;
- the `issuing` transition, which cancellation serializes against;
- broadcast with a known, lost or unsent outcome;
- readback of an uncertain broadcast, which is never retried;
- safe supersession, which only the owner can start;
- operational finality at `d >= 150`, "ready", and per-handle publication;
- an off-host journal snapshot that the broadcast waits for.

`subs` itself is reduced to single steps (stage, local commit, prove). A
commitment is a transaction spending the space's delegate output, with an
output carrying the root. This is a simulation, not evidence about `subs`.
"""

import copy
from dataclasses import dataclass, field

from .chain import Tx
from .store import SETTLED, Refused

FINAL_D = 150  # tip - mined_height, subs' operational finality
MAX_REBUILDS = 3


@dataclass
class Batch:
    bid: str
    members: list
    state: str = "frozen"
    root: object = None
    delegate_in: object = None
    txid: object = None
    intent: bool = False
    supersedes: object = None
    delivered: set = field(default_factory=set)


class Controller:
    DURABLE = ("batches", "delegate", "rebuilds_in_a_row", "paused_at", "alerts", "n")

    def __init__(self, chain, store):
        self.chain = chain
        self.store = store
        self.batches = {}
        self.delegate = ("delegate-genesis", 0)
        self.rebuilds_in_a_row = 0
        self.paused_at = None
        self.alerts = []
        self.n = 0
        self.offhost_available = True
        self.offhost = None
        self.ack_journal()

    # Off-host journal

    def ack_journal(self):
        if not self.offhost_available:
            return False
        self.offhost = {k: copy.deepcopy(getattr(self, k)) for k in self.DURABLE}
        return True

    def restore_from_offhost(self):
        for k, v in copy.deepcopy(self.offhost).items():
            setattr(self, k, v)
        # A journaled broadcast intent without a recorded answer is uncertain:
        # the call may have happened before the host was lost.
        for b in self.batches.values():
            if b.state == "issuing" and b.intent:
                b.state = "broadcast_uncertain"
            elif b.state == "checkpointed" and b.members and all(
                    self.store.orders[m].status == "issuing" for m in b.members):
                # Members were marked issuing, but the intent never reached the
                # off-host journal, so the broadcast was never called.
                b.state = "issuing"
                b.intent = False
        self.observe()

    # Helpers

    def _open(self):
        return [b for b in self.batches.values()
                if b.state not in ("rebuilt", "final", "superseded")]

    def _members_busy(self):
        return {m for b in self._open() for m in b.members}

    def _new_bid(self):
        self.n += 1
        return f"b{self.n}"

    def _paused(self):
        return self.paused_at is not None and self.chain.tip <= self.paused_at

    # Cycle

    def freeze(self, members=None):
        """Choose members from converted orders that pass batch entry."""
        self.store.observe()
        if self._paused():
            raise Refused("paused until the next block")
        if any(b.state not in ("frozen", "committed_local", "proved", "checkpointed")
               for b in self._open()):
            raise Refused("a previous commitment is not final")
        busy = self._members_busy()
        candidates = [o.oid for o in self.store.orders.values()
                      if o.oid not in busy and self.store.batch_entry_ok(o)]
        chosen = candidates if members is None else [m for m in members if m in candidates]
        if not chosen:
            raise Refused("nothing to batch")
        bid = self._new_bid()
        self.batches[bid] = Batch(bid, sorted(chosen), delegate_in=self.delegate)
        self.ack_journal()
        return bid

    def commit_local(self, bid):
        b = self.batches[bid]
        if b.state != "frozen":
            raise Refused("not frozen")
        b.root = f"root-{bid}-" + "-".join(b.members)
        b.state = "committed_local"
        self.ack_journal()

    def prove(self, bid):
        b = self.batches[bid]
        if b.state != "committed_local":
            raise Refused("not committed locally")
        b.state = "proved"
        self.ack_journal()

    def checkpoint(self, bid):
        b = self.batches[bid]
        if b.state != "proved":
            raise Refused("not proved")
        b.state = "checkpointed"
        if not self.ack_journal():
            b.state = "proved"
            raise Refused("checkpoint not acknowledged off-host")

    def _failing(self, b):
        self.store.observe()
        return [m for m in b.members if not self.store.batch_entry_ok(self.store.orders[m])]

    def check_and_issue(self, bid, outcome="ok"):
        """The binding check, then `issuing` and the broadcast.

        outcome: "ok" (answer recorded), "lost" (sent, answer lost) or
        "unsent" (the call failed before reaching the network, unknown to us).
        Returns the batch that went on, which is a rebuilt one if a member
        failed the check.
        """
        b = self.batches[bid]
        if b.state != "checkpointed":
            raise Refused("not checkpointed")
        failing = self._failing(b)
        if failing:
            return self._rebuild(b, failing)
        self.rebuilds_in_a_row = 0
        # One serialized step: every member becomes non-cancellable.
        for m in b.members:
            self.store.mark_issuing(m)
        b.state = "issuing"
        b.intent = True
        if not self.ack_journal():
            raise Refused("broadcast intent not acknowledged off-host; not sent")
        self._broadcast(b, outcome)
        return bid

    def resume(self, bid, outcome="ok"):
        """Retry a broadcast whose intent was never acknowledged off-host."""
        b = self.batches[bid]
        if b.state != "issuing":
            raise Refused("nothing to resume")
        if self.offhost.get("batches", {}).get(bid) and self.offhost["batches"][bid].intent:
            raise Refused("intent was acknowledged: the outcome is uncertain")
        if not self.ack_journal():
            raise Refused("broadcast intent not acknowledged off-host; not sent")
        self._broadcast(b, outcome)

    def _broadcast(self, b, outcome):
        tx = Tx(f"commit-{b.bid}", (b.delegate_in,),
                (("delegate", 0), (f"op_return:{b.root}", 0)))
        if outcome in ("ok", "lost"):
            self.chain.add(tx)
        if outcome == "ok":
            b.txid = tx.txid
            b.state = "broadcast"
        else:
            b.state = "broadcast_uncertain"
        self.ack_journal()
        self.store.observe()

    def _rebuild(self, b, failing):
        b.state = "rebuilt"
        self.rebuilds_in_a_row += 1
        if self.rebuilds_in_a_row >= MAX_REBUILDS:
            self.paused_at = self.chain.tip
            self.alerts.append(("rebuilds", b.bid))
            self.ack_journal()
            raise Refused("three rebuilds in a row: paused until the next block")
        keep = [m for m in b.members if m not in failing]
        if not keep:
            self.ack_journal()
            raise Refused("every member failed the check")
        nb = self._new_bid()
        self.batches[nb] = Batch(nb, keep, delegate_in=b.delegate_in, supersedes=b.bid)
        self.ack_journal()
        return nb

    def retry_broadcast(self, bid):
        raise Refused("never repeat a broadcast whose outcome is unknown")

    def rollback_local(self, bid):
        b = self.batches[bid]
        if b.intent:
            raise Refused("never roll back a commitment with a broadcast intent")
        b.state = "rebuilt"
        self.ack_journal()

    def replace_commitment(self, bid):
        raise Refused("needs the owner's decision and safe supersession")

    def readback(self, bid):
        """Look for an uncertain broadcast on the chain or in the mempool."""
        b = self.batches[bid]
        if b.state != "broadcast_uncertain":
            return False
        for tx in self.chain.txs.values():
            seen = self.chain.position(tx.txid) is not None or self.chain.in_mempool(tx.txid)
            if seen and b.delegate_in in tx.inputs and \
                    any(spk == f"op_return:{b.root}" for spk, _ in tx.outputs):
                b.txid = tx.txid
                b.state = "broadcast"
                self.ack_journal()
                return True
        return False

    def owner_supersede(self, bid, txid):
        """The owner's explicit rollback: a different spend of the delegate output."""
        b = self.batches[bid]
        self.chain.add(Tx(txid, (b.delegate_in,),
                          (("delegate", 0), ("op_return:rollback", 0))))

    # Watching

    def observe(self):
        for b in list(self.batches.values()):
            if b.state not in ("broadcast", "broadcast_uncertain", "mined"):
                continue
            if self._superseded(b):
                b.state = "superseded"
                for m in b.members:
                    if self.store.orders[m].status == "issuing":
                        self.store.unissue(m)
                spender = self.chain.spender(b.delegate_in)
                self.delegate = (spender, 0)
                continue
            if b.txid and self.chain.position(b.txid):
                h = self.chain.position(b.txid)[0]
                b.state = "mined"
                if self.chain.tip - h >= FINAL_D:
                    b.state = "final"
                    self.delegate = (b.txid, 0)
                    for m in b.members:
                        if self.store.orders[m].status == "issuing":
                            self.store.mark_ready(m)
            elif b.state == "mined":
                b.state = "broadcast"
        self.ack_journal()

    def _superseded(self, b):
        spender = self.chain.spender(b.delegate_in)
        if spender is None or spender == b.txid:
            return False
        if self.chain.conf(spender) < SETTLED:
            return False
        tx = self.chain.txs[spender]
        return not any(spk == f"op_return:{b.root}" for spk, _ in tx.outputs)

    # Publication

    def publish(self, bid, handles):
        b = self.batches[bid]
        if b.state != "final":
            raise Refused("not final")
        if not handles:
            return 0  # an empty list would mean "all unpublished" upstream
        if len(handles) > 100:
            raise Refused("chunk too large")
        return len(handles)

    def confirm_delivery(self, bid, oid):
        b = self.batches[bid]
        if b.state != "final" or oid not in b.members:
            raise Refused("not a final member")
        b.delivered.add(oid)
        self.store.mark_fulfilled(oid)
        self.ack_journal()
