"""Fixed-price payments, reservations and refunds.

A reference model of PAYMENT-SPEC.md draft 8 (docs/spec). It covers
fixed-price holds, conversion to a fulfillment reservation, late payments,
cancellation, the price reserve, the two sufficiency rules, the
`reconciling` reasons with recorded losses, and refund obligation groups.
Auctions, batches, the controller and evidence are later slices.

Everything here is a simulation. A passing model case says the rules are
consistent on a simulated chain, nothing more.
"""

from dataclasses import dataclass, field

CONFIRMED, BATCHABLE, SETTLED = 1, 3, 6
HOLD_MINUTES = 15  # proposal
EXTENSION_BLOCKS = 6
EXCESS_MINIMUM_OVER_FEE = 546  # proposal

FULFILLABLE = ("converted", "issuing", "fulfilled")
REFUNDABLE_IN_FULL = ("cancelled", "refund_due")


class Refused(Exception):
    pass


@dataclass
class Attempt:
    tx: object
    to_buyer: int
    fee: int
    charged: int
    exported: bool = False
    attempted: bool = False
    acknowledged: bool = False

    @property
    def store_cost(self):
        return self.to_buyer + self.fee - self.charged


@dataclass
class Group:
    gid: str
    oid: str
    kind: str  # "excess" or "cancellation"
    attempts: list = field(default_factory=list)
    closed_by: object = None
    needs_rebuild: bool = False
    paused: bool = False

    def reservation(self):
        return max(a.charged for a in self.attempts)

    def txids(self):
        return {a.tx.txid for a in self.attempts}

    def attempt(self, txid):
        return next(a for a in self.attempts if a.tx.txid == txid)


@dataclass
class Hold:
    oid: str
    expires_at: int
    seen_height: object = None
    latched: object = None


@dataclass
class Order:
    oid: str
    name: str
    price: int
    script: str
    status: str = "quoted"
    price_reserve: int = 0
    late_evaluated: bool = False
    reasons: set = field(default_factory=set)
    losses: dict = field(default_factory=dict)


@dataclass
class Name:
    price: int
    hold: object = None
    fulfillment: object = None


class Store:
    def __init__(self, chain):
        self.chain = chain
        self.now = 0  # minutes
        self.names = {}
        self.orders = {}
        self.groups = {}
        self.alerts = []
        self.authorizations = []  # (amount authorized, available at that moment)

    # Owner and clock

    def list_name(self, name, price):
        self.names[name] = Name(price)

    def set_price(self, name, price):
        self.names[name].price = price
        self.observe()

    def advance(self, minutes):
        self.now += minutes
        self.observe()

    # Balances

    def _outputs(self, o):
        return self.chain.outputs_to(o.script)

    def sum_at(self, o, depth):
        return sum(x["value"] for x in self._outputs(o) if x["conf"] >= depth)

    def _groups(self, o):
        return [g for g in self.groups.values() if g.oid == o.oid]

    def refunded_total(self, o):
        return sum(g.attempt(g.closed_by).charged for g in self._groups(o) if g.closed_by)

    def reserved(self, o):
        return sum(g.reservation() for g in self._groups(o) if not g.closed_by)

    def available(self, o):
        return (self.sum_at(o, SETTLED) - self.refunded_total(o)
                - self.reserved(o) - o.price_reserve)

    def deficits(self, o):
        batchable = self.sum_at(o, BATCHABLE)
        settled = self.sum_at(o, SETTLED)
        shortfall = o.price_reserve - batchable if o.price_reserve > 0 else 0
        exposure = (self.refunded_total(o) + self.reserved(o)
                    - max(0, settled - o.price_reserve))
        return {
            "issuance": shortfall if o.status == "converted" else 0,
            "post_issuance_deficit": shortfall if o.status in ("issuing", "fulfilled") else 0,
            "refunds": exposure,
        }

    # Buyer

    def quote(self, oid, name, script):
        self.observe()
        n = self.names[name]
        if oid in self.orders:
            raise Refused("order exists")
        if n.hold is not None or n.fulfillment is not None:
            raise Refused("taken for now")
        self.orders[oid] = Order(oid, name, n.price, script)
        n.hold = Hold(oid, self.now + HOLD_MINUTES)
        self.observe()

    # Owner and controller

    def cancel(self, oid):
        self.observe()
        o = self.orders[oid]
        if o.status in ("issuing", "fulfilled"):
            raise Refused("not cancellable once issuing")
        n = self.names[o.name]
        if n.fulfillment == oid:
            n.fulfillment = None
        if n.hold is not None and n.hold.oid == oid:
            n.hold = None
        o.status = "cancelled"
        o.price_reserve = 0
        self.observe()

    def mark_issuing(self, oid):
        self.observe()
        o = self.orders[oid]
        if o.status != "converted":
            raise Refused("not converted")
        if "issuance" in o.reasons or self.sum_at(o, BATCHABLE) < o.price_reserve:
            raise Refused("batch entry refused")
        o.status = "issuing"
        self.observe()

    def mark_fulfilled(self, oid):
        self.observe()
        o = self.orders[oid]
        if o.status != "issuing":
            raise Refused("not issuing")
        o.status = "fulfilled"
        self.observe()

    def record_loss(self, oid, reason):
        self.observe()
        o = self.orders[oid]
        value = self.deficits(o)[reason]
        if value <= 0:
            raise Refused("no deficit to record")
        o.losses[reason] = value
        o.reasons.discard(reason)
        self.observe()

    # Refunds

    def open_group(self, gid, oid, kind, tx, to_buyer, fee, charged=None):
        self.observe()
        o = self.orders[oid]
        if gid in self.groups:
            raise Refused("group exists")
        if kind == "cancellation" and o.status not in REFUNDABLE_IN_FULL:
            raise Refused("order is not cancelled or refund due")
        if "refunds" in o.reasons:
            raise Refused("refunds are reconciling")
        charged = to_buyer + fee if charged is None else charged
        avail = self.available(o)
        if kind == "excess" and avail < fee + EXCESS_MINIMUM_OVER_FEE:
            raise Refused("excess below the refund minimum")
        if charged > avail:
            raise Refused("not enough settled funds")
        self.authorizations.append((charged, avail))
        self.groups[gid] = Group(gid, oid, kind, [Attempt(tx, to_buyer, fee, charged)])
        self.observe()

    def add_attempt(self, gid, tx, to_buyer, fee, charged=None):
        self.observe()
        g = self.groups[gid]
        o = self.orders[g.oid]
        if g.closed_by:
            raise Refused("group closed")
        charged = to_buyer + fee if charged is None else charged
        in_family = set(g.attempts[0].tx.inputs) <= set(tx.inputs)
        if not in_family and not self._conflict_settled(g):
            raise Refused("a replacement family needs a settled conflicting spend")
        if not all(self.chain.exclusive(a.tx, tx) for a in g.attempts):
            if not g.paused:
                self.alerts.append((g.oid, "refund_paused", gid))
            g.paused = True
            raise Refused("not mutually exclusive with every attempt; paused")
        increase = max(0, charged - g.reservation())
        avail = self.available(o)
        if increase > avail:
            raise Refused("not enough settled funds for the increase")
        self.authorizations.append((increase, avail))
        g.attempts.append(Attempt(tx, to_buyer, fee, charged))
        g.paused = False
        self.observe()

    def export_psbt(self, gid, txid):
        self.groups[gid].attempt(txid).exported = True

    def release(self, gid):
        raise Refused("a reservation is released only by settled evidence")

    def broadcast(self, gid, txid, response_lost=False, reached_network=True):
        a = self.groups[gid].attempt(txid)
        a.attempted = True  # recorded before the node is called
        if reached_network:
            self.chain.add(a.tx)
        if reached_network and not response_lost:
            a.acknowledged = True
        self.observe()

    def reconcile_attempts(self):
        """After a restart: look every attempt up before doing anything else.

        Returns the txids that must be rebroadcast as the same transaction.
        """
        rebroadcast = []
        for g in self.groups.values():
            for a in g.attempts:
                known = (self.chain.position(a.tx.txid) is not None
                         or self.chain.in_mempool(a.tx.txid))
                if known:
                    a.acknowledged = True
                elif a.attempted:
                    rebroadcast.append(a.tx.txid)
        return rebroadcast

    def rebroadcast(self, gid, txid):
        self.chain.add(self.groups[gid].attempt(txid).tx)
        self.observe()

    # Evaluation

    def observe(self):
        for o in list(self.orders.values()):
            self._step_order(o)
        for g in self.groups.values():
            self._step_group(g)
        for o in self.orders.values():
            self._reasons(o)

    def _step_order(self, o):
        n = self.names[o.name]
        if o.status == "quoted" and n.hold is not None and n.hold.oid == o.oid:
            h = n.hold
            tip = self.chain.tip
            if h.seen_height is None and self._outputs(o) and self.now < h.expires_at:
                h.seen_height = tip
            confirmed = self.sum_at(o, CONFIRMED)
            if h.seen_height is None:
                active = self.now < h.expires_at
            elif tip <= h.seen_height + EXTENSION_BLOCKS:
                active = True
            else:
                if h.latched is None:
                    h.latched = confirmed >= o.price
                if h.latched and confirmed < o.price:
                    h.latched = False
                active = bool(h.latched)
            if active and self.sum_at(o, BATCHABLE) >= o.price:
                n.hold = None
                n.fulfillment = o.oid
                o.status = "converted"
                o.price_reserve = o.price
            elif not active:
                n.hold = None
                o.status = "refund_due" if confirmed > 0 else "unpaid"
        elif o.status == "unpaid" and not o.late_evaluated and self.sum_at(o, CONFIRMED) > 0:
            o.late_evaluated = True
            if n.hold is None and n.fulfillment is None and n.price <= o.price:
                o.price = n.price
                o.status = "quoted"
                n.hold = Hold(o.oid, self.now + HOLD_MINUTES, seen_height=self.chain.tip)
                self._step_order(o)
            else:
                o.status = "refund_due"

    def _conflict_settled(self, g):
        ids = g.txids()
        for a in g.attempts:
            for op in a.tx.inputs:
                sp = self.chain.spender(op)
                if sp is not None and sp not in ids and self.chain.conf(sp) >= SETTLED:
                    return True
        return False

    def _step_group(self, g):
        settled = [a for a in g.attempts if self.chain.conf(a.tx.txid) >= SETTLED]
        if g.closed_by is None and settled:
            g.closed_by = settled[0].tx.txid
        elif g.closed_by is not None and self.chain.conf(g.closed_by) < SETTLED:
            g.closed_by = settled[0].tx.txid if settled else None
        if self._conflict_settled(g):
            g.needs_rebuild = True

    def _reasons(self, o):
        for reason, value in self.deficits(o).items():
            over = value - o.losses.get(reason, 0)
            if over > 0:
                if reason not in o.reasons:
                    self.alerts.append((o.oid, reason, over))
                o.reasons.add(reason)
            else:
                o.reasons.discard(reason)
