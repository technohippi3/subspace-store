"""Batch issuance controller for fixed-price sales, simulated (MVP slice).

A reference model of the controller rules in CONTROLLER-DESIGN.md draft 5
and the batch, cancellation, restore and finality cases of PAYMENT-SPEC.md
draft 9. It covers:
- batch entry and the binding pre-broadcast check, with rebuilds and a pause
  after three in a row;
- one active commitment per space, with the delegate output read from the
  chain when the batch is marked `issuing`;
- the `issuing` transition, which cancellation serializes against, and which
  waits for both the store's order locks and the controller's broadcast
  intent to be acknowledged off-host;
- broadcast with a known, lost or unsent outcome, through one send path that
  checks both acknowledgments immediately before transmission;
- readback of an uncertain broadcast, which is never retried;
- safe supersession, which only the owner can start;
- operational finality at `d >= 150`, its loss after a deep reorg, "ready",
  and per-handle publication and delivery against the current chain.

`subs` itself is reduced to single steps (stage, local commit, prove). A
commitment is a transaction spending the space's delegate output, with an
output carrying the root. A handle is represented by its order id. This is a
simulation, not evidence about `subs`.
"""

import copy
from dataclasses import dataclass, field

from .chain import Tx
from .store import SETTLED, Refused

FINAL_D = 150  # tip - mined_height, subs' operational finality
MAX_REBUILDS = 3
MAX_CHUNK = 100
GENESIS_DELEGATE = ("delegate-genesis", 0)

PREPARING = ("frozen", "committed_local", "proved", "checkpointed")
CLOSED = ("rebuilt", "final", "superseded")
WATCHED = ("broadcast", "broadcast_uncertain", "mined")
LIVE = ("issuing", "broadcast", "broadcast_uncertain", "mined", "final")


@dataclass
class Batch:
    bid: str
    members: list
    state: str = "frozen"
    root: object = None
    delegate_in: object = None
    txid: object = None
    # Recorded locally in the serialized `issuing` step. Whether it reached
    # the off-host journal is read from the journal itself, never from here.
    intent: bool = False
    # Set immediately before the broadcast call. Local knowledge only: after a
    # host loss it can't be trusted, and a journaled intent is uncertain.
    attempted: bool = False
    supersedes: object = None
    published: set = field(default_factory=set)
    delivered: set = field(default_factory=set)


class Controller:
    DURABLE = ("batches", "delegate", "rebuilds_in_a_row", "paused_at", "alerts", "n")

    def __init__(self, chain, store):
        self.chain = chain
        self.store = store
        self.batches = {}
        self.delegate = GENESIS_DELEGATE
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
        orders = self.store.orders
        for b in self.batches.values():
            if b.state in PREPARING and any(m not in orders for m in b.members):
                # Not yet checkpointed, and the store's journal lagged so far
                # that a member is gone: redo the batch from the start.
                b.state = "rebuilt"
                self.alerts.append(("rebuilt_on_restore", b.bid))
                continue
            if b.state == "issuing" and b.intent:
                # A journaled intent without a recorded answer is uncertain:
                # the call may have happened before the host was lost.
                b.state = "broadcast_uncertain"
                b.attempted = True
            elif b.state == "checkpointed" and b.members and all(
                    self.store.orders[m].status == "issuing" for m in b.members):
                # Members were marked issuing, but the intent never reached the
                # off-host journal, so the send path refused: never sent.
                b.state = "issuing"
                b.intent = False
                b.attempted = False
            elif b.state in WATCHED or b.state == "final":
                b.attempted = True
            if b.state not in ("rebuilt", "superseded") and (
                    b.intent or b.state in WATCHED or b.state == "final"):
                # The store's journal may lag the controller's. Every member of
                # a batch that may have escaped is non-cancellable again before
                # anything else runs, cancellation included. A member found
                # paid again after a supersession is unissued again by observe.
                for m in b.members:
                    if orders[m].status == "converted":
                        self.store.restore_issuing(m)
        # An order the store's journal shows as issuing or ready, with no live
        # batch in the controller's journal, was never sent or was superseded:
        # every send needs its batch's intent journaled, and a batch leaves
        # that state only as rebuilt (known unsent) or superseded. It is paid
        # again. A fulfilled one keeps its status and gets an incident.
        live = {m for b in self.batches.values() if b.state in LIVE for m in b.members}
        for o in list(orders.values()):
            if o.oid in live:
                continue
            if o.status == "ready":
                self.store.unready(o.oid)
            if o.status == "issuing":
                self.store.unissue(o.oid)
            elif o.status == "fulfilled":
                last = [b.bid for b in self.batches.values() if o.oid in b.members]
                self.store.open_incident(o.oid, "no_live_batch", last[-1] if last else None)
        # Read the chain back for every uncertain broadcast, and adopt a
        # commitment found there before anything else.
        for b in list(self.batches.values()):
            if b.state == "broadcast_uncertain":
                self.readback(b.bid)
        self.observe()

    def _issuance_acknowledged(self, b):
        """Both halves of the `issuing` step are in the off-host journals: the
        controller's intent for exactly this commitment, and every member's
        `issuing` mark in the store's journal."""
        acked = (self.offhost or {}).get("batches", {}).get(b.bid)
        if acked is None or not acked.intent:
            return False
        if (acked.root, acked.delegate_in, acked.members) != (b.root, b.delegate_in, b.members):
            return False
        orders = (self.store.offhost or {}).get("orders", {})
        return all(m in orders and orders[m].status == "issuing" for m in b.members)

    def _journal_issuance(self, b):
        store_ok = self.store.ack_journal()
        controller_ok = self.ack_journal()
        if not (store_ok and controller_ok):
            raise Refused("order locks or broadcast intent not acknowledged off-host; not sent")

    # Helpers

    def _open(self):
        return [b for b in self.batches.values() if b.state not in CLOSED]

    def _members_busy(self):
        return {m for b in self._open() for m in b.members}

    def _new_bid(self):
        self.n += 1
        return f"b{self.n}"

    def _paused(self):
        return self.paused_at is not None and self.chain.tip <= self.paused_at

    def _live_delegate(self):
        """The current delegate output, followed from genesis along mined spends
        on the best chain, as `spaced` would report it."""
        spends = self.chain.mined_spends()
        op = GENESIS_DELEGATE
        while op in spends:
            op = (spends[op], 0)
        return op

    def _live_final(self, b):
        pos = self.chain.position(b.txid) if b.txid else None
        return pos is not None and self.chain.tip - pos[0] >= FINAL_D

    def _commitment_seen(self, b):
        """A transaction carrying the batch's root that spends its delegate
        output, mined or in the mempool."""
        if b.root is None or b.delegate_in is None:
            return None
        for tx in self.chain.txs.values():
            seen = self.chain.position(tx.txid) is not None or self.chain.in_mempool(tx.txid)
            if seen and b.delegate_in in tx.inputs and \
                    any(spk == f"op_return:{b.root}" for spk, _ in tx.outputs):
                return tx.txid
        return None

    def _other_active(self, b):
        return any(o is not b and o.state not in PREPARING for o in self._open())

    # Cycle

    def freeze(self, members=None):
        """Choose members from converted orders that pass batch entry.

        One commitment per space: nothing is frozen while another batch is
        open, from `frozen` up to `final`."""
        self.store.observe()
        if self._paused():
            raise Refused("paused until the next block")
        if self._open():
            raise Refused("another batch is open; one commitment per space")
        busy = self._members_busy()
        candidates = [o.oid for o in self.store.orders.values()
                      if o.oid not in busy and self.store.batch_entry_ok(o)]
        chosen = candidates if members is None else [m for m in members if m in candidates]
        if not chosen:
            raise Refused("nothing to batch")
        bid = self._new_bid()
        self.batches[bid] = Batch(bid, sorted(chosen), delegate_in=self._live_delegate())
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
        # The coordinated snapshot confirms every object off-host: the store's
        # orders as well as the batch.
        b.state = "checkpointed"
        if not (self.store.ack_journal() and self.ack_journal()):
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
        failed the check. If either journal doesn't acknowledge, the batch
        stays `issuing` with nothing sent, and `resume` continues it.
        """
        b = self.batches[bid]
        if b.state != "checkpointed":
            raise Refused("not checkpointed")
        if self._other_active(b):
            raise Refused("another commitment is active")
        failing = self._failing(b)
        if failing:
            return self._rebuild(b, failing)
        self.rebuilds_in_a_row = 0
        # One serialized step: every member becomes non-cancellable, and the
        # intent records the delegate output read from the chain now.
        for m in b.members:
            self.store.mark_issuing(m)
        b.delegate_in = self._live_delegate()
        b.state = "issuing"
        b.intent = True
        self._journal_issuance(b)
        self._broadcast(b, outcome)
        return bid

    def resume(self, bid, outcome="ok"):
        """Send an `issuing` batch whose broadcast was never attempted.

        Time has passed since the check, so before the first transmission the
        binding check runs again with fresh depths and eligibility, and the
        delegate output is read again. A failing member makes the batch
        `rebuilt`, journaled before any member is paid again. An attempted
        broadcast stays on the uncertainty path."""
        b = self.batches[bid]
        if b.state != "issuing":
            raise Refused("nothing to resume")
        if b.attempted:
            raise Refused("the broadcast was attempted: the outcome is uncertain")
        if self._other_active(b):
            raise Refused("another commitment is active")
        self.store.observe()
        failing = [m for m in b.members
                   if not self.store.issuing_recheck_ok(self.store.orders[m])]
        if failing:
            return self._rebuild_unsent(b, failing)
        b.delegate_in = self._live_delegate()
        b.intent = True
        self._journal_issuance(b)
        self._broadcast(b, outcome)
        return bid

    def _rebuild_unsent(self, b, failing):
        before = (b.state, b.intent)
        b.state, b.intent = "rebuilt", False
        if not self.ack_journal():
            b.state, b.intent = before
            raise Refused("rebuild not acknowledged off-host; nothing sent, still issuing")
        for m in b.members:
            self.store.unissue(m)
        return self._rebuild(b, failing)

    def _broadcast(self, b, outcome):
        # The only path to the network for a commitment. Checked immediately
        # before transmission, not after.
        if not self._issuance_acknowledged(b):
            raise Refused("order locks or broadcast intent not acknowledged off-host; not sent")
        b.attempted = True
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
        """`/rollback-local`, only before `issuing` and only while nothing
        carrying the root can be on the network."""
        b = self.batches[bid]
        if b.state not in PREPARING or b.intent or b.attempted or self._commitment_seen(b):
            raise Refused("never roll back a commitment that may have escaped")
        b.state = "rebuilt"
        self.ack_journal()

    def replace_commitment(self, bid):
        raise Refused("needs the owner's decision and safe supersession")

    def readback(self, bid):
        """Look for an uncertain broadcast on the chain or in the mempool."""
        b = self.batches[bid]
        if b.state != "broadcast_uncertain":
            return False
        txid = self._commitment_seen(b)
        if txid is None:
            return False
        b.txid = txid
        b.state = "broadcast"
        self.ack_journal()
        return True

    def owner_supersede(self, bid, txid):
        """The owner's explicit rollback: a different spend of the delegate output."""
        b = self.batches[bid]
        self.chain.add(Tx(txid, (b.delegate_in,),
                          (("delegate", 0), ("op_return:rollback", 0))))

    # Watching

    def observe(self):
        for b in list(self.batches.values()):
            if b.state == "final" and not self._live_final(b):
                # A reorg took the commitment below d >= 150 or off the best
                # chain: finality is lost until it holds again.
                b.state = "mined" if self.chain.position(b.txid) else "broadcast"
                self.alerts.append(("finality_lost", b.bid))
                for m in b.members:
                    status = self.store.orders[m].status
                    if status == "ready":
                        self.store.unready(m)
                    elif status == "fulfilled":
                        self.alerts.append(("fulfilled_without_finality", m))
                        self.store.open_incident(m, "finality_lost", b.bid)
            if b.state == "final":
                self._mark_ready(b)
                continue
            if b.state not in WATCHED:
                continue
            if self._superseded(b):
                b.state = "superseded"
                for m in b.members:
                    status = self.store.orders[m].status
                    if status == "ready":
                        # A ready restored from a newer store journal: back
                        # through issuing to paid, like any member.
                        self.store.unready(m)
                        status = "issuing"
                    if status == "issuing":
                        self.store.unissue(m)
                    elif status == "fulfilled":
                        # Delivered before finality was lost: never undone
                        # automatically, left to the operator.
                        self.alerts.append(("fulfilled_superseded", m))
                        self.store.open_incident(m, "superseded", b.bid)
                continue
            if b.txid and self.chain.position(b.txid):
                b.state = "mined"
                if self._live_final(b):
                    b.state = "final"
                    self._mark_ready(b)
            elif b.state == "mined":
                b.state = "broadcast"
            if b.state != "final":
                # "ready" needs d >= 150 on the current chain. A member restored
                # as ready from a store journal newer than the controller's
                # returns to issuing until this batch is final again.
                for m in b.members:
                    status = self.store.orders[m].status
                    if status == "ready":
                        self.store.unready(m)
                    elif status == "fulfilled":
                        self.store.open_incident(m, "finality_lost", b.bid)
        self.delegate = self._live_delegate()
        self.ack_journal()

    def _mark_ready(self, b):
        for m in b.members:
            if self.store.orders[m].status == "issuing":
                self.store.mark_ready(m)

    def _superseded(self, b):
        spender = self.chain.spender(b.delegate_in)
        if spender is None or spender == b.txid:
            return False
        if self.chain.conf(spender) < SETTLED:
            return False
        tx = self.chain.txs[spender]
        return not any(spk == f"op_return:{b.root}" for spk, _ in tx.outputs)

    def certificate_current(self, oid):
        """True only while the order's batch is final on the current chain.
        Fulfilled alone records a past delivery, not a valid certificate."""
        return any(oid in b.members and b.state == "final" and self._live_final(b)
                   for b in self.batches.values())

    # Publication

    def publish(self, bid, handles):
        """One `/publish` call. Immediately before it, the live chain must
        carry the batch's commitment at d >= 150."""
        b = self.batches[bid]
        if b.state != "final" or not self._live_final(b):
            raise Refused("not final on the current chain")
        if not handles:
            return 0  # an empty list would mean "all unpublished" upstream
        if len(handles) > MAX_CHUNK:
            raise Refused("chunk too large")
        b.published |= {h for h in handles if h in b.members}
        self.ack_journal()
        return len(handles)

    def confirm_delivery(self, bid, oid):
        b = self.batches[bid]
        if b.state != "final" or not self._live_final(b):
            raise Refused("not final on the current chain")
        if oid not in b.members:
            raise Refused("not a member")
        if oid not in b.published:
            raise Refused("not published")
        b.delivered.add(oid)
        self.store.mark_fulfilled(oid)
        self.ack_journal()
