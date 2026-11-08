"""Run the service's ledger beside the reference model's store.

`TwinStore` stands in for the model's store inside a model `Sim`. Every call
that the generator, the sim or the model controller makes into the store is
applied to the model first, then to the service's `Ledger`, which reads the
same simulated chain through `ModelChainView`. `differences` compares their
durable state. The service is a separate implementation, so agreement here
is evidence that it follows the model's rules on these sequences, and only
that: it is a model-twin result, not regtest evidence.

A host loss is twinned too (case H7): the model keeps what its off-host
journal acknowledged, and the service is rebuilt from its own journal
alone into a fresh database file, then both evaluate.
"""

import hashlib
import itertools
import tempfile
from pathlib import Path

from model.chain import Tx
from model.store import Refused as ModelRefused
from service.journal import MemoryJournal
from service.ledger import (Ledger, Policy, Refused, SendFailed, SendUncertain,
                            restore_from_journal, valid_p2tr)

SPACE = "@twin"


def handle(name):
    return f"{name}{SPACE}"


def recipient(oid):
    """A distinct P2TR script per order with a valid BIP340 key: the first
    counter whose hash is a curve coordinate. Deterministic, no randomness."""
    for i in itertools.count():
        script = "5120" + hashlib.sha256(f"{oid}/{i}".encode()).hexdigest()
        if valid_p2tr(script):
            return script


def as_dict(tx):
    return {"txid": tx.txid, "inputs": [tuple(i) for i in tx.inputs],
            "outputs": [tuple(o) for o in tx.outputs]}


class ModelChainView:
    """The service's chain view over the model's simulated chain."""

    def __init__(self, chain):
        self.chain = chain
        self.next_destination = None
        self.send_mode = "ok"

    def refresh(self):
        pass

    @property
    def tip(self):
        return self.chain.tip

    def outputs_to(self, script):
        return self.chain.outputs_to(script)

    def conf(self, txid):
        return self.chain.conf(txid)

    def position(self, txid):
        return self.chain.position(txid)

    def in_mempool(self, txid):
        return self.chain.in_mempool(txid)

    def spender(self, outpoint):
        return self.chain.spender(tuple(outpoint))

    def _tx(self, d):
        return self.chain.txs.get(d["txid"]) or Tx(
            d["txid"], tuple(tuple(i) for i in d["inputs"]),
            tuple(tuple(o) for o in d["outputs"]))

    def exclusive(self, a, b):
        return self.chain.exclusive(self._tx(a), self._tx(b))

    def new_destination(self, oid):
        script = self.next_destination
        return script, script

    def refund_script(self, address):
        return "0014" + hashlib.sha256(address.encode()).hexdigest()[:40]

    def send(self, tx):
        # The model's own call already put the transaction on the simulated
        # network, or didn't; here only the answer is reproduced.
        if self.send_mode == "lost":
            raise SendUncertain("answer lost")
        if self.send_mode == "unsent":
            raise SendFailed("not reached")


class TwinStore:
    MIRRORED = {"list_name", "set_price", "advance", "quote", "cancel", "mark_issuing",
                "unissue", "restore_issuing", "unready", "mark_ready", "mark_fulfilled",
                "invalidate_eligibility", "open_incident", "resolve_incident", "record_loss",
                "open_group", "add_attempt", "export_psbt", "release", "broadcast",
                "rebroadcast", "reconcile_attempts", "observe", "ack_journal"}

    def __init__(self, model_store, chain, workdir):
        object.__setattr__(self, "model", model_store)
        object.__setattr__(self, "view", ModelChainView(chain))
        object.__setattr__(self, "journal", MemoryJournal())
        object.__setattr__(self, "minutes", 0)
        object.__setattr__(self, "db_path", Path(workdir) / "service.db")
        object.__setattr__(self, "service", self._open())
        object.__setattr__(self, "mismatches", [])
        object.__setattr__(self, "restarts", 0)
        object.__setattr__(self, "host_losses", 0)
        object.__setattr__(self, "workdir", Path(workdir))

    def _open(self):
        return Ledger(self.db_path, self.view, self.journal, Policy(),
                      clock=lambda: self.minutes * 60)

    def restart(self):
        """A process restart: the service reopens from its database file."""
        self.service.close()
        object.__setattr__(self, "service", self._open())
        object.__setattr__(self, "restarts", self.restarts + 1)

    def restore_from_offhost(self):
        """A host loss. The model restores its acknowledged state, which
        also sets its clock back to the acknowledged one; the clock is an
        input here, so the service's follows. The service's database is
        dropped and rebuilt from its journal alone."""
        self.model.restore_from_offhost()
        object.__setattr__(self, "minutes", self.model.now)
        self.service.close()
        n = self.host_losses + 1
        object.__setattr__(self, "host_losses", n)
        object.__setattr__(self, "db_path", self.workdir / f"service-restored-{n}.db")
        restore_from_journal(self.db_path, self.journal)
        object.__setattr__(self, "service", self._open())
        self.service.observe()

    def __getattr__(self, name):
        attr = getattr(self.model, name)
        if name in self.MIRRORED and callable(attr):
            return lambda *a, **k: self._both(name, attr, *a, **k)
        return attr

    def __setattr__(self, name, value):
        setattr(self.model, name, value)
        if name == "offhost_available":
            self.journal.set_available(value)

    def _both(self, name, model_call, *args, **kwargs):
        try:
            result = model_call(*args, **kwargs)
            model_refused = None
        except ModelRefused as e:
            result, model_refused = None, e
        try:
            service_result = getattr(self, "_s_" + name)(*args, **kwargs)
            service_refused = None
        except Refused as e:
            service_result, service_refused = None, e
        if (model_refused is None) != (service_refused is None):
            self.mismatches.append(
                f"{name}{args}: model {'refused: ' + str(model_refused) if model_refused else 'ok'}, "
                f"service {'refused: ' + str(service_refused) if service_refused else 'ok'}")
        if name == "reconcile_attempts" and model_refused is None and \
                sorted(result) != sorted(service_result or []):
            self.mismatches.append(f"reconcile_attempts: model {result}, service {service_result}")
        if model_refused:
            raise model_refused
        return result

    # The service's side of each call

    def _s_list_name(self, name, price):
        self.service.list_name(handle(name), price)

    def _s_set_price(self, name, price):
        self.service.set_price(handle(name), price)

    def _s_advance(self, minutes):
        object.__setattr__(self, "minutes", self.minutes + minutes)
        self.service.observe()

    def _s_quote(self, oid, name, script):
        self.service.request(handle(name), recipient(oid), oid=oid)
        self.view.next_destination = script
        self.service.quote(oid)

    def _s_cancel(self, oid):
        self.service.cancel(oid)

    def _s_mark_issuing(self, oid):
        self.service.mark_issuing(oid)

    def _s_unissue(self, oid):
        self.service.unissue(oid)

    def _s_restore_issuing(self, oid):
        self.service.restore_issuing(oid)

    def _s_unready(self, oid):
        self.service.unready(oid)

    def _s_mark_ready(self, oid):
        self.service.mark_ready(oid)

    def _s_mark_fulfilled(self, oid):
        self.service.mark_fulfilled(oid)

    def _s_invalidate_eligibility(self, oid):
        self.service.invalidate_eligibility(oid)

    def _s_open_incident(self, oid, kind, bid):
        self.service.open_incident(oid, kind, bid)

    def _s_resolve_incident(self, oid, resolution):
        self.service.resolve_incident(oid, resolution)

    def _s_record_loss(self, oid, reason):
        self.service.record_loss(oid, reason)

    def _s_open_group(self, gid, oid, kind, tx, to_buyer, fee, charged=None):
        self.service.open_group(gid, oid, kind, as_dict(tx), to_buyer, fee, charged)

    def _s_add_attempt(self, gid, tx, to_buyer, fee, charged=None):
        self.service.add_attempt(gid, as_dict(tx), to_buyer, fee, charged)

    def _s_export_psbt(self, gid, txid):
        self.service.export_psbt(gid, txid)

    def _s_release(self, gid):
        self.service.release(gid)

    def _s_broadcast(self, gid, txid, response_lost=False, reached_network=True):
        self.view.send_mode = ("unsent" if not reached_network
                               else "lost" if response_lost else "ok")
        self.service.broadcast(gid, txid)

    def _s_rebroadcast(self, gid, txid):
        self.view.send_mode = "ok"
        self.service.rebroadcast(gid, txid)

    def _s_reconcile_attempts(self):
        return self.service.reconcile_attempts()

    def _s_observe(self):
        self.service.observe()

    def _s_ack_journal(self):
        self.service.flush_journal()


def differences(twin):
    """Durable state that differs between the model and the service."""
    m, s = twin.model, twin.service
    out = []

    def cmp(what, a, b):
        if a != b:
            out.append(f"{what}: model {a!r}, service {b!r}")

    for name, n in m.names.items():
        row = s._name(handle(name))
        cmp(f"{name} price", n.price, row["price"])
        cmp(f"{name} hold", n.hold.oid if n.hold else None, row["hold_order"])
        if n.hold:
            cmp(f"{name} hold expiry", n.hold.expires_at * 60, row["hold_expires_at"])
            cmp(f"{name} seen height", n.hold.seen_height, row["hold_seen_height"])
            cmp(f"{name} latched", None if n.hold.latched is None else int(n.hold.latched),
                row["hold_latched"])
        cmp(f"{name} fulfillment", n.fulfillment, row["fulfillment_order"])
    for oid, o in m.orders.items():
        v = s.operator_view(oid)
        cmp(f"{oid} status", o.status, v["status"])
        cmp(f"{oid} price", o.price, v["price"])
        cmp(f"{oid} price_reserve", o.price_reserve, v["price_reserve"])
        cmp(f"{oid} reasons", sorted(o.reasons), v["reasons"])
        cmp(f"{oid} losses", dict(o.losses), v["losses"])
        cmp(f"{oid} eligible", o.eligible, bool(v["eligible"]))
        cmp(f"{oid} late_evaluated", o.late_evaluated, bool(v["late_evaluated"]))
        inc = None if o.incident is None else {"bid": o.incident.bid,
                                               "kinds": list(o.incident.kinds),
                                               "resolution": o.incident.resolution}
        cmp(f"{oid} incident", inc, v["incident"])
        cmp(f"{oid} available", m.available(o), v["available"])
        cmp(f"{oid} reserved", m.reserved(o), v["reserved"])
        cmp(f"{oid} refunded_total", m.refunded_total(o), v["refunded_total"])
    for gid, g in m.groups.items():
        row = s._group(gid)
        cmp(f"{gid} order", g.oid, row["oid"])
        cmp(f"{gid} closed_by", g.closed_by, row["closed_by"])
        cmp(f"{gid} needs_rebuild", g.needs_rebuild, bool(row["needs_rebuild"]))
        cmp(f"{gid} paused", g.paused, bool(row["paused"]))
        cmp(f"{gid} reservation", g.reservation(), s._reservation(gid))
        attempts = s._attempts(gid)
        cmp(f"{gid} attempts", [a.tx.txid for a in g.attempts], [a["txid"] for a in attempts])
        for a, r in zip(g.attempts, attempts):
            cmp(f"{gid}/{a.tx.txid} amounts", (a.to_buyer, a.fee, a.charged),
                (r["to_buyer"], r["fee"], r["charged"]))
            cmp(f"{gid}/{a.tx.txid} flags", (a.exported, a.attempted, a.acknowledged),
                (bool(r["exported"]), bool(r["attempted"]), bool(r["acknowledged"])))
            cmp(f"{gid}/{a.tx.txid} journaled", m._acked_attempt(gid, a.tx.txid),
                bool(r["journaled"]))
    cmp("authorizations", [tuple(x) for x in m.authorizations],
        [(r["amount"], r["available"]) for r in
         s.db.execute("select amount, available from authorizations order by n")])
    import json
    cmp("alerts", [tuple(a) for a in m.alerts],
        [(a["oid"], a["kind"], json.loads(a["detail"])) for a in s.alerts()])
    return out


def new_workdir():
    return tempfile.TemporaryDirectory()
