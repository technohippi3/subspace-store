"""Record the transitions the service ledger makes, as vectors for the
TypeScript port: `order` for `ts/src/order.ts`, `funds` for
`ts/src/funds.ts` and `incident` for `ts/src/incident.ts`.

It watches the real `service.ledger.Ledger` while two things run:
- directed runs on a fresh ledger and a simulated chain. For the order
  family, every order status and every command: one order is brought to the
  status and the command applied once, plus a few command sequences the
  statuses alone don't reach (`DIRECTED_EXTRAS`). For the funds family, a
  few refund scenarios (`FUNDS_SCENARIOS`) for what the generated sequences
  reach rarely or never, such as a PSBT export or the refund address. For
  the incident family, one run through every incident outcome, which the
  generated sequences don't reach at all;
- the model twin's seeded generated sequences (tests/test_generated.py
  through tests/service_twin.py, with a process restart every 17 steps).

Each vector is one transition: the state before, what the ledger observed,
the event, and the state after, the effects (alerts, authorizations, sends)
and the refusal or null. A command's own transition is taken between the
evaluation that leads it and the one that follows it, where it has them.
The output names the Python sources by SHA-256, with the git commit and the
files that differ from it.

Nothing in the ledger is changed: methods are wrapped while this runs. The
vectors say what the Python service does on these runs. Agreement with them
is equivalence to the Python service, transition by transition: not a model
result and not regtest evidence. Deterministic: seeded sequences, a
simulated chain and a simulated clock.

    python3 tools/ledger_vectors.py --family order|funds|incident [--seeds N] [--steps N]
"""

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from model.chain import Chain, Tx  # noqa: E402
from service.journal import MemoryJournal  # noqa: E402
from service.ledger import (BATCHABLE, CONFIRMED, Ledger, Policy, Refused,  # noqa: E402
                            SendFailed, SendUncertain)
from tests.service_twin import ModelChainView, TwinStore, new_workdir, recipient  # noqa: E402
from tests.test_generated import Generator  # noqa: E402

RESTART_EVERY = 17  # as tests/test_service_twin.py

# Every Python source the vectors depend on.
SOURCES = ("tools/ledger_vectors.py", "service/ledger.py", "service/journal.py",
           "tests/service_twin.py", "tests/test_generated.py", "model/chain.py",
           "model/controller.py", "model/sim.py", "model/store.py")


# State and observations

ORDER_FIELDS = ("oid", "name", "status", "price", "price_reserve", "late_evaluated",
                "eligible", "reasons", "dest_address", "dest_script")
NAME_FIELDS = ("name", "price", "hold_order", "hold_expires_at", "hold_seen_height",
               "hold_latched", "fulfillment_order")
ATTEMPT_FIELDS = ("txid", "raw", "to_buyer", "fee", "charged", "exported", "attempted",
                  "acknowledged", "journaled")


def order_state(led, oid):
    o = led._order(oid)
    n = led._name(o["name"])
    order = {k: o[k] for k in ORDER_FIELDS}
    order["reasons"] = json.loads(order["reasons"])
    return {"order": order, "name": {k: n[k] for k in NAME_FIELDS}}


def order_observation(led, oid):
    return {"now": led.clock(), "tip": led.chain.tip,
            "payment_seen": bool(led.outputs(oid)),
            "confirmed": led.sum_at(oid, CONFIRMED),
            "batchable": led.sum_at(oid, BATCHABLE),
            "recipient_blocked": led.recipient_block(oid) is not None}


def funds_state(led, oid):
    o = led._order(oid)
    groups = []
    for g in led._groups_of(oid):
        attempts = []
        for a in led._attempts(g["gid"]):
            row = {k: a[k] for k in ATTEMPT_FIELDS}
            row["inputs"] = json.loads(a["inputs"])
            row["outputs"] = json.loads(a["outputs"])
            attempts.append(row)
        groups.append({"gid": g["gid"], "kind": g["kind"], "closed_by": g["closed_by"],
                       "needs_rebuild": g["needs_rebuild"], "paused": g["paused"],
                       "attempts": attempts})
    return {"order": {"oid": oid, "status": o["status"], "price_reserve": o["price_reserve"],
                      "reasons": json.loads(o["reasons"]), "losses": json.loads(o["losses"]),
                      "dest_script": o["dest_script"], "refund_address": o["refund_address"],
                      "refund_spk": o["refund_spk"]},
            "groups": groups}


def incident_state(led, oid):
    o = led._order(oid)
    return {"oid": oid, "incident": json.loads(o["incident"]) if o["incident"] else None}


def _tx_facts(chain, txid):
    return {"conf": chain.conf(txid),
            "known": chain.position(txid) is not None or chain.in_mempool(txid)}


def funds_observation(led, oid):
    chain = led.chain
    txs, spenders = {}, {}
    for g in led._groups_of(oid):
        for a in led._attempts(g["gid"]):
            txs[a["txid"]] = _tx_facts(chain, a["txid"])
            for op in json.loads(a["inputs"]):
                sp = chain.spender(tuple(op))
                spenders[f"{op[0]}:{op[1]}"] = sp
                if sp is not None:
                    txs[sp] = _tx_facts(chain, sp)
    return {"payments": [{"value": x["value"], "conf": x["conf"]} for x in led.outputs(oid)],
            "txs": txs, "spenders": spenders}


def last_n(led, table):
    return led.db.execute(f"select coalesce(max(n), 0) from {table}").fetchone()[0]


def point(fam, led, oid):
    """Everything a vector needs at one moment."""
    return {"state": fam.state(led, oid), "obs": fam.observation(led, oid),
            "alerts": last_n(led, "alerts"), "auths": last_n(led, "authorizations")}


def effects_between(led, a, b):
    alerts = [{"oid": r["oid"], "kind": r["kind"], "detail": json.loads(r["detail"])}
              for r in led.db.execute("select * from alerts where n > ? and n <= ? order by n",
                                      (a["alerts"], b["alerts"]))]
    auths = [{"gid": r["gid"], "amount": r["amount"], "available": r["available"]}
             for r in led.db.execute("select * from authorizations where n > ? and n <= ? "
                                     "order by n", (a["auths"], b["auths"]))]
    return {"alerts": alerts, "authorizations": auths}


class Family:
    def __init__(self, name, state, observation):
        self.name, self.state, self.observation = name, state, observation


ORDER = Family("order", order_state, order_observation)
FUNDS = Family("funds", funds_state, funds_observation)
INCIDENT = Family("incident", incident_state, lambda led, oid: {})


# Recording

class Recording:
    def __init__(self):
        self.vectors = {}
        self.seen = {}
        self.conflicts = []
        self.depth = {}
        self.command = None
        self.source = None
        self.sends = None
        self.led = None


rec = Recording()


def record(kind, before, event, after, refusal, extra=None):
    key = json.dumps([kind, before["state"], before["obs"], event], sort_keys=True)
    outcome = {"after": after["state"] if after is not None else None, "refusal": refusal,
               **(extra or {})}
    if key in rec.vectors:
        rec.seen[key] += 1
        if rec.vectors[key]["outcome"] != outcome:
            rec.conflicts.append(key)
        return
    rec.seen[key] = 1
    rec.vectors[key] = {"kind": kind, "before": before["state"], "observation": before["obs"],
                        "event": event, "outcome": outcome, "source": rec.source}


def wrap_step(fam, kind, orig, key_of):
    """An evaluation step the ledger runs from `observe`, for one record."""
    def step(self, key):
        if rec.depth.get(kind):  # the late payment's second step, inside this one
            return orig(self, key)
        oid = key_of(self, key)
        before = point(fam, self, oid)
        rec.depth[kind] = 1
        try:
            orig(self, key)
        finally:
            rec.depth[kind] = 0
        after = point(fam, self, oid)
        if fam is ORDER:
            record(kind, before, {"hold_seconds": self.policy.hold_seconds}, after, None)
        else:
            extra = effects_between(self, before, after)
            extra["sends"] = []
            record(kind, before, {"gid": key}, after, None, extra)
    return step


def wrap_observe(orig):
    def observe(self):
        cmd = rec.command
        if cmd is None:
            return orig(self)
        entry = point(cmd["fam"], self, cmd["oid"])
        orig(self)
        cmd["observes"].append((entry, point(cmd["fam"], self, cmd["oid"])))
    return observe


def wrap_command(fam, name, orig, leading, oid_of, event_of):
    def command(self, *args, **kwargs):
        if rec.command is not None:
            return orig(self, *args, **kwargs)
        try:
            oid = oid_of(self, *args)
            start = point(fam, self, oid)
            event = event_of(self, *args, **kwargs)
        except Refused:
            return orig(self, *args, **kwargs)  # no such record: nothing to record
        rec.command = cmd = {"fam": fam, "oid": oid, "observes": []}
        rec.sends, rec.led = [], self
        refusal, result = None, None
        try:
            result = orig(self, *args, **kwargs)
        except Refused as e:
            refusal, result = str(e), e
        finally:
            rec.command = None
            sends, rec.sends, rec.led = rec.sends, None, None
        end = point(fam, self, oid)
        lead = 1 if leading and cmd["observes"] else 0
        before = cmd["observes"][0][1] if lead else start
        after = cmd["observes"][lead][0] if refusal is None and len(cmd["observes"]) > lead \
            else end
        if fam is ORDER:
            event = {"hold_seconds": self.policy.hold_seconds}
            if name == "quote" and refusal is None:
                event["destination"] = {"address": after["state"]["order"]["dest_address"],
                                        "script": after["state"]["order"]["dest_script"]}
            record(name, before, event, None if refusal else after, refusal)
        else:
            extra = effects_between(self, before, after)
            extra["sends"] = sends
            record(name, before, event, after, refusal, extra)
        if isinstance(result, Refused):
            raise result
        return result
    return command


def wrap_send(orig):
    """Every transaction the ledger hands to the node, exactly as handed,
    with the group its stored attempt belongs to and the answer."""
    def send(self, tx):
        entry = None
        if rec.sends is not None:
            row = rec.led.db.execute("select gid from attempts where txid = ?",
                                     (tx["txid"],)).fetchone()
            entry = {"gid": row["gid"] if row else None, "tx": _tx_event(tx)}
            rec.sends.append(entry)
        try:
            orig(self, tx)
        except SendUncertain:
            if entry is not None:
                entry["answer"] = "uncertain"
            raise
        except SendFailed:
            if entry is not None:
                entry["answer"] = "failed"
            raise
        if entry is not None:
            entry["answer"] = "sent"
    return send


def wrap_reconcile(orig):
    """Store-wide: one vector per order with refund groups."""
    def reconcile_attempts(self):
        if rec.command is not None:
            return orig(self)
        oids = [r["oid"] for r in self.db.execute("select distinct oid from groups order by oid")]
        befores = {oid: point(FUNDS, self, oid) for oid in oids}
        result = orig(self)
        for oid in oids:
            after = point(FUNDS, self, oid)
            ours = {a["txid"]: g["gid"] for g in befores[oid]["state"]["groups"]
                    for a in g["attempts"]}
            extra = effects_between(self, befores[oid], after)
            extra["sends"] = []
            extra["rebroadcast"] = [{"gid": ours[t], "txid": t} for t in result if t in ours]
            record("reconcile_attempts", befores[oid], {}, after, None, extra)
        return result
    return reconcile_attempts


def wrap_flush(orig):
    """One journal entry acknowledged: the attempts of every group it holds
    become journaled. Recorded once per order, naming all of that order's
    groups in the entry."""
    def flush_journal(self):
        gids = [r["key"] for r in self.db.execute(
            "select key from journal_backlog where kind = 'group' order by rowid")]
        by_order = {}
        for gid in gids:
            by_order.setdefault(self._group(gid)["oid"], []).append(gid)
        befores = {oid: point(FUNDS, self, oid) for oid in by_order}
        acked = orig(self)
        for oid, group_ids in by_order.items():
            cleared = [gid for gid in group_ids if not self.db.execute(
                "select 1 from journal_backlog where kind = 'group' and key = ?",
                (gid,)).fetchone()]
            if cleared:
                after = point(FUNDS, self, oid)
                extra = effects_between(self, befores[oid], after)
                extra["sends"] = []
                record("journaled", befores[oid], {"gids": cleared}, after, None, extra)
        return acked
    return flush_journal


def _tx_event(tx):
    return {"txid": tx["txid"], "inputs": [list(i) for i in tx["inputs"]],
            "outputs": [list(o) for o in tx["outputs"]], "raw": tx.get("raw")}


def _group_oid(led, gid):
    return led._group(gid)["oid"]


def _add_attempt_event(led, gid, tx, to_buyer, fee, charged=None):
    exclusive = {a["txid"]: bool(led.chain.exclusive(Ledger.attempt_tx(a), tx))
                 for a in led._attempts(gid)}
    return {"gid": gid, "tx": _tx_event(tx), "to_buyer": to_buyer, "fee": fee,
            "charged": charged, "exclusive_with": exclusive}


ORDER_COMMANDS = ("quote", "cancel", "mark_issuing", "restore_issuing", "unissue", "mark_ready",
                  "unready", "mark_fulfilled", "invalidate_eligibility")
ORDER_LEADING = {"quote", "cancel", "mark_issuing", "mark_ready", "mark_fulfilled"}

FUNDS_COMMANDS = {
    # name: (leading observe, oid of the arguments, event of the arguments)
    "open_group": (True, lambda led, gid, oid, *a: oid,
                   lambda led, gid, oid, kind, tx, to_buyer, fee, charged=None:
                   {"gid": gid, "kind": kind, "tx": _tx_event(tx), "to_buyer": to_buyer,
                    "fee": fee, "charged": charged}),
    "add_attempt": (True, lambda led, gid, *a: _group_oid(led, gid), _add_attempt_event),
    "export_psbt": (False, lambda led, gid, txid: _group_oid(led, gid),
                    lambda led, gid, txid: {"gid": gid, "txid": txid}),
    "broadcast": (False, lambda led, gid, txid: _group_oid(led, gid),
                  lambda led, gid, txid: {"gid": gid, "txid": txid}),
    "rebroadcast": (False, lambda led, gid, txid: _group_oid(led, gid),
                    lambda led, gid, txid: {"gid": gid, "txid": txid}),
    "record_loss": (True, lambda led, oid, reason: oid,
                    lambda led, oid, reason: {"reason": reason}),
    "set_refund_address": (False, lambda led, oid, address, script: oid,
                           lambda led, oid, address, script:
                           {"address": address, "script": script,
                            "payment_address_in_use": bool(led.db.execute(
                                "select 1 from orders where dest_script = ?",
                                (script,)).fetchone())}),
}

INCIDENT_COMMANDS = {
    "open_incident": (False, lambda led, oid, kind, bid: oid,
                      lambda led, oid, kind, bid: {"kind": kind, "bid": bid}),
    "resolve_incident": (False, lambda led, oid, resolution: oid,
                         lambda led, oid, resolution: {"resolution": resolution}),
}


def install(family):
    Ledger.observe = wrap_observe(Ledger.observe)
    if family == "order":
        Ledger._step_order = wrap_step(ORDER, "evaluate", Ledger._step_order, lambda l, k: k)
        for name in ORDER_COMMANDS:
            setattr(Ledger, name, wrap_command(ORDER, name, getattr(Ledger, name),
                                               name in ORDER_LEADING,
                                               lambda led, oid, *a: oid,
                                               lambda led, oid, *a, **k: {}))
    elif family == "incident":
        for name, (leading, oid_of, event_of) in INCIDENT_COMMANDS.items():
            setattr(Ledger, name, wrap_command(INCIDENT, name, getattr(Ledger, name), leading,
                                               oid_of, event_of))
    else:
        Ledger._step_group = wrap_step(FUNDS, "step_group", Ledger._step_group, _group_oid)
        Ledger._reasons = wrap_step(FUNDS, "reasons", Ledger._reasons, lambda l, k: k)
        Ledger.reconcile_attempts = wrap_reconcile(Ledger.reconcile_attempts)
        Ledger.flush_journal = wrap_flush(Ledger.flush_journal)
        ModelChainView.send = wrap_send(ModelChainView.send)
        for name, (leading, oid_of, event_of) in FUNDS_COMMANDS.items():
            setattr(Ledger, name, wrap_command(FUNDS, name, getattr(Ledger, name), leading,
                                               oid_of, event_of))


# Directed runs

STATUSES = ("requested", "quoted", "converted", "issuing", "ready", "fulfilled",
            "cancelled", "refund_due", "unpaid")
# Command sequences from a status that the single commands don't reach.
DIRECTED_EXTRAS = (
    ("converted", ("invalidate_eligibility", "mark_issuing")),  # batch entry refused
    ("issuing", ("unissue", "restore_issuing")),
    ("ready", ("unready", "mark_ready", "mark_fulfilled")),
)


class Directed:
    """One order on one name, in a fresh ledger on a simulated chain, with
    a simulated clock and an in-memory journal."""

    PRICE = 10_000

    def __init__(self, workdir):
        self.chain = Chain()
        self.view = ModelChainView(self.chain)
        self.view.new_destination = self._destination
        self.journal = MemoryJournal()
        self.n = 0
        self.now = [0]
        self.led = Ledger(Path(workdir) / "store.db", self.view, self.journal, Policy(),
                          clock=lambda: self.now[0])
        self.led.list_name("one@space", self.PRICE)
        self.oid, _ = self.led.request("one@space", recipient("directed-buyer"))

    def _destination(self, oid):
        self.n += 1
        return f"dest-{self.n}", recipient(f"dest-{self.n}")

    def pay(self, value, blocks):
        self.n += 1
        script = self.led._order(self.oid)["dest_script"]
        txid = f"pay{self.n}"
        self.chain.add(Tx(txid, ((f"coin{self.n}", 0),), ((script, value),)))
        self.mine(blocks)
        return txid

    def mine(self, blocks):
        for _ in range(blocks):
            self.chain.mine()
        self.led.observe()

    def bring_to(self, status):
        led, oid = self.led, self.oid
        if status == "requested":
            return
        led.quote(oid)
        if status == "cancelled":
            led.cancel(oid)
        elif status == "unpaid":
            self.now[0] += led.policy.hold_seconds
            led.observe()
        elif status == "refund_due":
            # Seen before expiry, then the extension lapses short of the price.
            self.pay(self.PRICE // 2, 1)
            self.mine(7)
        elif status != "quoted":
            self.pay(self.PRICE, 3)
            for step, reached in (("mark_issuing", "issuing"), ("mark_ready", "ready"),
                                  ("mark_fulfilled", "fulfilled")):
                if status == "converted":
                    break
                getattr(led, step)(oid)
                if status == reached:
                    break
        got = led._order(oid)["status"]
        if got != status:
            raise RuntimeError(f"directed run reached {got}, not {status}")


def run_order_directed():
    runs = [(s, (c,)) for s in STATUSES for c in ORDER_COMMANDS] + list(DIRECTED_EXTRAS)
    for status, commands in runs:
        with new_workdir() as wd:
            d = Directed(wd)
            rec.source = None
            d.bring_to(status)
            rec.source = "directed"
            for c in commands:
                try:
                    getattr(d.led, c)(d.oid)
                except Refused:
                    pass
            d.led.close()


def _refund_tx(txid, coin, value):
    return {"txid": txid, "inputs": [coin], "outputs": [("refund-addr", value)]}


def _try(call, *args, **kwargs):
    try:
        return call(*args, **kwargs)
    except Refused:
        return None


def scenario_excess(d):
    """An excess refunded: exported, broadcast, seen, settled and closed."""
    led, oid = d.led, d.oid
    d.bring_to("converted")
    extra = d.pay(3_000, 6)
    _try(led.open_group, "g1", oid, "excess", _refund_tx("a1", (extra, 0), 2_700), 2_700, 300)
    led.export_psbt("g1", "a1")
    d.view.send_mode = "ok"
    led.broadcast("g1", "a1")
    d.chain.add(Tx("a1", ((extra, 0),), (("refund-addr", 2_700),)))
    d.mine(1)
    led.reconcile_attempts()
    d.mine(6)
    _try(led.record_loss, oid, "refunds")


def scenario_cancellation_lost(d):
    """A cancellation refund whose broadcast answer is lost, found nowhere,
    rebroadcast, then bumped within its family."""
    led, oid = d.led, d.oid
    d.bring_to("converted")
    pay = f"pay{d.n}"
    d.mine(3)
    led.cancel(oid)
    _try(led.open_group, "g1", oid, "cancellation", _refund_tx("a1", (pay, 0), 9_700), 9_700, 300)
    d.view.send_mode = "lost"
    led.broadcast("g1", "a1")
    led.reconcile_attempts()
    d.view.send_mode = "ok"
    led.rebroadcast("g1", "a1")
    _try(led.add_attempt, "g1", _refund_tx("a2", (pay, 0), 9_400), 9_400, 600)
    # Not a replacement family and no settled conflict: refused.
    _try(led.add_attempt, "g1", _refund_tx("a3", ("elsewhere", 0), 9_400), 9_400, 600)


def scenario_refusals(d):
    """What opening a refund refuses, and nothing leaving before the journal
    acknowledges it."""
    led, oid = d.led, d.oid
    d.bring_to("converted")
    pay = f"pay{d.n}"
    d.mine(3)
    _try(led.open_group, "g1", oid, "cancellation", _refund_tx("a1", (pay, 0), 100), 100, 300)
    _try(led.open_group, "g1", oid, "gift", _refund_tx("a1", (pay, 0), 100), 100, 300)
    _try(led.open_group, "g1", oid, "excess", _refund_tx("a1", (pay, 0), 100), 100, 300)
    _try(led.record_loss, oid, "nonsense")
    _try(led.record_loss, oid, "issuance")
    extra = d.pay(1_200, 6)
    # One sat short of the excess minimum, then exactly at it.
    _try(led.open_group, "g2", oid, "excess", _refund_tx("a2", (extra, 0), 545), 545, 655)
    d.journal.set_available(False)
    _try(led.open_group, "g2", oid, "excess", _refund_tx("a2", (extra, 0), 546), 546, 654)
    _try(led.open_group, "g2", oid, "excess", _refund_tx("a9", (extra, 0), 546), 546, 654)
    _try(led.export_psbt, "g2", "a2")
    _try(led.broadcast, "g2", "a2")
    _try(led.rebroadcast, "g2", "a2")
    # Never attempted and seen nowhere: reconciliation doesn't send it.
    led.reconcile_attempts()
    d.journal.set_available(True)
    led.observe()
    _try(led.add_attempt, "g2", _refund_tx("a3", (extra, 0), 800), 800, 400, 5_000)


def scenario_one_entry_two_groups(d):
    """Two refund groups opened while the journal is down, then acknowledged
    together in one entry."""
    led, oid = d.led, d.oid
    d.bring_to("converted")
    extra = d.pay(3_000, 6)
    d.journal.set_available(False)
    _try(led.open_group, "g1", oid, "excess", _refund_tx("a1", (extra, 0), 546), 546, 654)
    _try(led.open_group, "g2", oid, "excess", _refund_tx("a2", (extra, 0), 546), 546, 654)
    d.journal.set_available(True)
    led.observe()


def scenario_refund_address(d):
    """A refund destination is the buyer's, never the order's own, and is
    fixed once a refund is built."""
    led, oid = d.led, d.oid
    d.bring_to("converted")
    own = led._order(oid)["dest_script"]
    _try(led.set_refund_address, oid, "own-address", own)
    # Another order's payment address, while it is quoted.
    led.list_name("two@space", d.PRICE)
    other, _ = led.request("two@space", recipient("directed-buyer-2"))
    led.quote(other)
    _try(led.set_refund_address, oid, "other-address", led._order(other)["dest_script"])
    _try(led.set_refund_address, oid, "buyer-address", "0014" + "11" * 20)
    _try(led.set_refund_address, oid, "buyer-address-2", "0014" + "22" * 20)
    extra = d.pay(3_000, 6)
    _try(led.open_group, "g1", oid, "excess", _refund_tx("a1", (extra, 0), 2_700), 2_700, 300)
    _try(led.set_refund_address, oid, "buyer-address-3", "0014" + "33" * 20)


def scenario_refund_address_before_quote(d):
    """A refund destination set before the quote, when the order has no
    payment script yet, and a wallet that then hands out that same script
    for the quote. The quote skips it (T3), so the order never refunds to
    its own address."""
    led, oid = d.led, d.oid
    led.set_refund_address(oid, "next-wallet-address", recipient(f"dest-{d.n + 1}"))
    led.quote(oid)
    d.pay(d.PRICE, 6)


FUNDS_SCENARIOS = (scenario_excess, scenario_cancellation_lost, scenario_refusals,
                   scenario_one_entry_two_groups, scenario_refund_address,
                   scenario_refund_address_before_quote)


def run_incident_directed():
    """Opened, extended, refused without a resolution, resolved, refused
    again, and a new incident after the resolution."""
    with new_workdir() as wd:
        rec.source = "directed"
        d = Directed(wd)
        led, oid = d.led, d.oid
        d.bring_to("fulfilled")
        _try(led.resolve_incident, oid, "nothing open")
        led.open_incident(oid, "finality_lost", "b1")
        led.open_incident(oid, "finality_lost", "b1")
        led.open_incident(oid, "superseded", "b2")
        _try(led.resolve_incident, oid, "")
        _try(led.resolve_incident, oid, None)
        led.resolve_incident(oid, "reissued in b3")
        _try(led.resolve_incident, oid, "again")
        led.open_incident(oid, "no_live_batch", None)
        d.led.close()


def run_funds_directed():
    for scenario in FUNDS_SCENARIOS:
        with new_workdir() as wd:
            rec.source = "directed"
            d = Directed(wd)
            scenario(d)
            d.led.close()


# Generated sequences

def run_seed(seed, steps):
    with new_workdir() as wd:
        gen = Generator(seed)
        sim = gen.sim
        twin = TwinStore(sim.store, sim.chain, wd)
        sim.store = twin
        sim.controller.store = twin
        for name, n in twin.model.names.items():
            twin.service.list_name(f"{name}@twin", n.price)
        for i in range(steps):
            gen.step()
            if i % RESTART_EVERY == RESTART_EVERY - 1:
                twin.restart()
        twin.service.close()


def fingerprint():
    files = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in SOURCES}
    combined = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    try:
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True,
                              text=True, check=True).stdout.strip()
        changed = subprocess.run(["git", "status", "--porcelain", "--", *SOURCES], cwd=ROOT,
                                 capture_output=True, text=True, check=True).stdout
        changed = sorted(line[3:] for line in changed.splitlines())
    except (OSError, subprocess.CalledProcessError):
        head, changed = None, None
    return {"sha256": combined, "files": files, "git_head": head,
            "changed_from_head": changed}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--family", choices=("order", "funds", "incident"), required=True)
    ap.add_argument("--seeds", type=int, default=24)
    ap.add_argument("--steps", type=int, default=150)
    args = ap.parse_args(argv)
    install(args.family)
    {"order": run_order_directed, "funds": run_funds_directed,
     "incident": run_incident_directed}[args.family]()
    rec.source = "generated"
    for seed in range(args.seeds):
        run_seed(seed, args.steps)
    vectors = list(rec.vectors.values())
    counts = {}
    for v in vectors:
        k = v["kind"] + (":refused" if v["outcome"]["refusal"] else "")
        counts[k] = counts.get(k, 0) + 1
    json.dump({"family": args.family,
               "source": "service.ledger.Ledger: directed runs, then the model twin's "
                         "generated sequences",
               "evidence": "equivalence to the Python service; not model or regtest evidence",
               "python_sources": fingerprint(),
               "policy": {"hold_seconds": Policy().hold_seconds,
                          "excess_minimum_over_fee": Policy().excess_minimum_over_fee},
               "seeds": args.seeds, "steps": args.steps,
               "calls": sum(rec.seen.values()), "unique": len(vectors), "counts": counts,
               "conflicts": rec.conflicts, "vectors": vectors}, sys.stdout, sort_keys=True)
    return 1 if rec.conflicts else 0


if __name__ == "__main__":
    sys.exit(main())
