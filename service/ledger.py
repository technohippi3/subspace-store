"""Fixed-price orders, holds, payments, cancellation and refund obligations,
kept in SQLite.

This implements the fixed-price rules of docs/spec/PAYMENT-SPEC.md. It is
written separately from the reference model (model/store.py), and
tests/test_service_twin.py runs both on the same generated event sequences
and the same simulated chain, comparing their state after every step.

All chain access goes through a chain view (see `ChainView` below):
`service/bitcoin.py` reads Bitcoin Core, and the twin tests read the model's
simulated chain. Balances are never stored. They are derived from the chain
position of each payment output at the moment of evaluation, and refund
totals are derived from the journaled attempts.

Evaluation order follows the model: an operation evaluates the store
(`observe`), runs its own database transaction, then evaluates again. Each
evaluation commits, then writes the off-host journal backlog. A refund
attempt counts as journaled only once its group's entry is acknowledged, and
nothing is exported or broadcast before that.
"""

import hashlib
import json
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass

from .journal import JournalDown

# Depth thresholds, in conventional confirmations (PAYMENT-SPEC.md, "Terms").
CONFIRMED, BATCHABLE, SETTLED = 1, 3, 6
EXTENSION_BLOCKS = 6

FULFILLABLE = ("converted", "issuing", "ready", "fulfilled")
ISSUED = ("issuing", "ready", "fulfilled")
REFUNDABLE_IN_FULL = ("cancelled", "refund_due")
REASONS = ("issuance", "post_issuance_deficit", "refunds")

# Recipient requests (PAYMENT-SPEC.md, "Recipient requests"). Always used
# with fullmatch: "$" would also accept a trailing newline.
LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
HANDLE_RE = re.compile(rf"{LABEL}@{LABEL}")
P2TR_RE = re.compile(r"5120([0-9a-f]{64})")
SECP256K1_P = 2**256 - 2**32 - 977


def canonical_handle(handle):
    return isinstance(handle, str) and HANDLE_RE.fullmatch(handle) is not None


def valid_p2tr(script):
    """34-byte P2TR whose x-only key is a valid BIP340 public key: the
    coordinate is below the field size and lift_x finds a curve point."""
    m = P2TR_RE.fullmatch(script) if isinstance(script, str) else None
    if m is None:
        return False
    x = int(m.group(1), 16)
    if x >= SECP256K1_P:
        return False
    c = (pow(x, 3, SECP256K1_P) + 7) % SECP256K1_P
    y = pow(c, (SECP256K1_P + 1) // 4, SECP256K1_P)
    return y * y % SECP256K1_P == c


class Refused(Exception):
    pass


class Invalid(Exception):
    """A malformed input, refused before any state is read."""


@dataclass
class Policy:
    """Commercial defaults. Every one is a proposal in the specification, so
    each is configurable (docs/SERVICE.md)."""
    hold_seconds: int = 15 * 60
    excess_minimum_over_fee: int = 546
    refund_fee: int = 300  # sats, refunds sent net of fee


class ChainView:
    """What the ledger reads from the chain. Outpoints are (txid, vout).

    - refresh(): start a new evaluation pass; a view may cache until the next.
    - tip: the best chain's height.
    - outputs_to(script): every output paying `script` that is mined on the
      best chain or in the mempool, as {"outpoint", "value", "conf"}.
    - conf(txid), position(txid), in_mempool(txid).
    - spender(outpoint): the txid of the mined spend on the best chain, or None.
    - exclusive(a, b): True if transactions `a` and `b` (dicts with "txid",
      "inputs", "outputs") can never both be mined on one chain.
    - send(tx): transmit; raises SendUncertain if the answer was lost and
      SendFailed if it surely did not reach the network.
    """


class SendUncertain(Exception):
    pass


class SendFailed(Exception):
    pass


SCHEMA = """
create table if not exists names (
  name text primary key,
  price integer not null,
  hold_order text unique,
  hold_expires_at real,
  hold_seen_height integer,
  hold_latched integer,
  fulfillment_order text unique,
  check (hold_order is null or fulfillment_order is null)
);
create table if not exists orders (
  seq integer primary key autoincrement,
  oid text not null unique,
  token_hash text not null unique,
  name text not null references names(name),
  recipient_spk text not null,
  status text not null,
  price integer,
  dest_script text unique,
  dest_address text,
  price_reserve integer not null default 0,
  late_evaluated integer not null default 0,
  eligible integer not null default 1,
  reasons text not null default '[]',
  losses text not null default '{}',
  incident text,
  refund_spk text,
  refund_address text,
  subs_outcome text,
  created_at real not null,
  recipient_problem text
);
create table if not exists payment_outputs (
  txid text not null, vout integer not null, oid text not null, value integer not null,
  primary key (txid, vout)
);
create table if not exists groups (
  seq integer primary key autoincrement,
  gid text not null unique,
  oid text not null references orders(oid),
  kind text not null check (kind in ('excess', 'cancellation')),
  closed_by text,
  needs_rebuild integer not null default 0,
  paused integer not null default 0
);
create table if not exists attempts (
  seq integer primary key autoincrement,
  txid text not null unique,
  gid text not null references groups(gid),
  inputs text not null,
  outputs text not null,
  raw text,
  to_buyer integer not null,
  fee integer not null,
  charged integer not null,
  exported integer not null default 0,
  attempted integer not null default 0,
  acknowledged integer not null default 0,
  journaled integer not null default 0
);
create table if not exists alerts (
  n integer primary key autoincrement, oid text, kind text not null, detail text, at real
);
create table if not exists authorizations (
  n integer primary key autoincrement, gid text not null, amount integer not null,
  available integer not null
);
create table if not exists journal_backlog (
  kind text not null, key text not null, primary key (kind, key)
);
create table if not exists pending (handle text primary key, script_pubkey text not null);
create table if not exists committed (handle text primary key, root text not null);
"""


def _j(v):
    return json.dumps(v, sort_keys=True)


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


class Ledger:
    def __init__(self, db_path, chain, journal, policy=None, clock=time.time):
        self.db = sqlite3.connect(str(db_path), isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("pragma journal_mode = wal")
        self.db.execute("pragma synchronous = full")
        self.db.execute("pragma foreign_keys = on")
        self.db.executescript(SCHEMA)
        cols = {r["name"] for r in self.db.execute("pragma table_info(orders)")}
        if "recipient_problem" not in cols:  # a database from before the audit
            self.db.execute("alter table orders add column recipient_problem text")
        self.chain = chain
        self.journal = journal
        self.policy = policy or Policy()
        self.clock = clock
        self._depth = 0
        self.audit_recipients()

    def close(self):
        self.db.close()

    # Transactions and the journal

    @contextmanager
    def tx(self):
        """One serialized database transaction. Nested uses join the outer
        one."""
        if self._depth:
            self._depth += 1
            try:
                yield
            finally:
                self._depth -= 1
            return
        self.db.execute("begin immediate")
        self._depth = 1
        try:
            yield
        except BaseException:
            self.db.execute("rollback")
            raise
        else:
            self.db.execute("commit")
        finally:
            self._depth = 0

    def _dirty(self, kind, key):
        self.db.execute("insert or ignore into journal_backlog values (?, ?)", (kind, key))

    def _snapshot(self, kind, key):
        if kind == "order":
            row = self._order(key)
            return {k: row[k] for k in row.keys() if k != "token_hash"}
        if kind == "name":
            return dict(self._name(key))
        if kind == "group":
            g = dict(self._group(key))
            g["attempts"] = [dict(a) for a in self._attempts(key)]
            return g
        raise ValueError(kind)

    def flush_journal(self):
        """Write every backlogged entity's current state to the off-host
        journal. Stops at the first failure; the rest stays backlogged."""
        if not self.journal.available():
            return False
        for row in self.db.execute("select kind, key from journal_backlog").fetchall():
            snap = self._snapshot(row["kind"], row["key"])
            try:
                self.journal.append(row["kind"], key=row["key"], state=snap)
            except JournalDown:
                return False
            with self.tx():
                self.db.execute("delete from journal_backlog where kind = ? and key = ?",
                                (row["kind"], row["key"]))
                if row["kind"] == "group":
                    for a in snap["attempts"]:
                        self.db.execute("update attempts set journaled = 1 where txid = ?",
                                        (a["txid"],))
        return True

    def _alert(self, oid, kind, detail):
        self.db.execute("insert into alerts(oid, kind, detail, at) values (?, ?, ?, ?)",
                        (oid, kind, _j(detail), self.clock()))

    # Rows

    def _order(self, oid):
        row = self.db.execute("select * from orders where oid = ?", (oid,)).fetchone()
        if row is None:
            raise Refused("no such order")
        return row

    def _name(self, name):
        row = self.db.execute("select * from names where name = ?", (name,)).fetchone()
        if row is None:
            raise Refused("not for sale")
        return row

    def _group(self, gid):
        row = self.db.execute("select * from groups where gid = ?", (gid,)).fetchone()
        if row is None:
            raise Refused("no such refund")
        return row

    def _attempts(self, gid):
        return self.db.execute("select * from attempts where gid = ? order by seq",
                               (gid,)).fetchall()

    def _groups_of(self, oid):
        return self.db.execute("select * from groups where oid = ? order by seq",
                               (oid,)).fetchall()

    def _set_order(self, oid, **cols):
        sets = ", ".join(f"{k} = ?" for k in cols)
        self.db.execute(f"update orders set {sets} where oid = ?", (*cols.values(), oid))
        self._dirty("order", oid)

    def _set_name(self, name, **cols):
        sets = ", ".join(f"{k} = ?" for k in cols)
        self.db.execute(f"update names set {sets} where name = ?", (*cols.values(), name))
        self._dirty("name", name)

    def _set_group(self, gid, **cols):
        sets = ", ".join(f"{k} = ?" for k in cols)
        self.db.execute(f"update groups set {sets} where gid = ?", (*cols.values(), gid))
        self._dirty("group", gid)

    def order_by_token(self, token):
        row = self.db.execute("select oid from orders where token_hash = ?",
                              (token_hash(token),)).fetchone()
        if row is None:
            raise Refused("no such order")
        return row["oid"]

    # Balances, derived from chain position

    def outputs(self, oid):
        o = self._order(oid)
        if not o["dest_script"]:
            return []
        return self.chain.outputs_to(o["dest_script"])

    def sum_at(self, oid, depth):
        return sum(x["value"] for x in self.outputs(oid) if x["conf"] >= depth)

    def _attempt(self, txid):
        row = self.db.execute("select * from attempts where txid = ?", (txid,)).fetchone()
        if row is None:
            raise Refused("no such attempt")
        return row

    def refunded_total(self, oid):
        return sum(self._attempt(g["closed_by"])["charged"]
                   for g in self._groups_of(oid) if g["closed_by"])

    def _reservation(self, gid):
        return max(a["charged"] for a in self._attempts(gid))

    def reserved(self, oid):
        return sum(self._reservation(g["gid"]) for g in self._groups_of(oid)
                   if not g["closed_by"])

    def available(self, oid):
        o = self._order(oid)
        return (self.sum_at(oid, SETTLED) - self.refunded_total(oid)
                - self.reserved(oid) - o["price_reserve"])

    def deficits(self, oid):
        o = self._order(oid)
        batchable = self.sum_at(oid, BATCHABLE)
        settled = self.sum_at(oid, SETTLED)
        reserve = o["price_reserve"]
        shortfall = reserve - batchable if reserve > 0 else 0
        exposure = self.refunded_total(oid) + self.reserved(oid) - max(0, settled - reserve)
        return {
            "issuance": shortfall if o["status"] == "converted" else 0,
            "post_issuance_deficit": shortfall if o["status"] in ISSUED else 0,
            "refunds": exposure,
        }

    # Owner

    def list_name(self, name, price):
        if not canonical_handle(name):
            raise Invalid("invalid handle")
        if not isinstance(price, int) or price <= 0:
            raise Refused("invalid price")
        with self.tx():
            if self.db.execute("select 1 from names where name = ?", (name,)).fetchone():
                self._set_name(name, price=price)
            else:
                self.db.execute("insert into names(name, price) values (?, ?)", (name, price))
                self._dirty("name", name)
        self.flush_journal()

    def set_price(self, name, price):
        with self.tx():
            self._name(name)
            self._set_name(name, price=price)
        self.observe()

    # Buyer

    def request(self, handle, recipient_spk, oid=None):
        """A public recipient request: the handle and the buyer's script, and
        nothing else. Returns (oid, order link token). The recipient is
        locked to the order: nothing changes it afterwards.

        An unsigned request claims nothing. A script is refused only while a
        paid order for another handle claims it (`claimed_elsewhere`), or if
        it is one of the store's destination scripts, without saying which.
        The same handle and script again is a retry: a new order and link."""
        if not canonical_handle(handle):
            raise Invalid("invalid handle")
        if not valid_p2tr(recipient_spk):
            raise Invalid("script_pubkey must be a 34-byte P2TR script with a valid key")
        token = secrets.token_urlsafe(24)
        with self.tx():
            self._name(handle)
            ours = self.db.execute("select 1 from orders where dest_script = ?",
                                   (recipient_spk,)).fetchone()
            if ours or self.claimed_elsewhere(handle, recipient_spk):
                raise Refused("script already used")
            if oid is None:
                n = self.db.execute("select coalesce(max(seq), 0) + 1 from orders").fetchone()[0]
                oid = f"o{n}"
            self.db.execute(
                "insert into orders(oid, token_hash, name, recipient_spk, status, created_at) "
                "values (?, ?, ?, ?, 'requested', ?)",
                (oid, token_hash(token), handle, recipient_spk, self.clock()))
            self._dirty("order", oid)
        self.flush_journal()
        return oid, token

    def quote(self, oid):
        """Fix the price and take the name's temporary hold, with a fresh
        destination script from the payment wallet."""
        self.observe()
        o = self._order(oid)
        if o["status"] != "requested":
            raise Refused("already quoted")
        self._recipient_quotable(o)
        n = self._name(o["name"])
        if n["hold_order"] is not None or n["fulfillment_order"] is not None:
            raise Refused("taken for now")
        address, script = self.chain.new_destination(oid)
        with self.tx():
            self._recipient_quotable(self._order(oid))
            n = self._name(o["name"])
            if n["hold_order"] is not None or n["fulfillment_order"] is not None:
                raise Refused("taken for now")
            self._set_order(oid, status="quoted", price=n["price"], dest_script=script,
                            dest_address=address)
            self._set_name(o["name"], hold_order=oid,
                           hold_expires_at=self.clock() + self.policy.hold_seconds,
                           hold_seen_height=None, hold_latched=None)
        self.observe()
        o = self._order(oid)
        n = self._name(o["name"])
        return {"price_sats": o["price"], "address": o["dest_address"],
                "expires_at": n["hold_expires_at"] if n["hold_order"] == oid else None}

    def set_refund_address(self, oid, address, script):
        """The buyer's refund destination, given through the order link."""
        with self.tx():
            o = self._order(oid)
            if o["dest_script"] and script == o["dest_script"]:
                raise Refused("a refund never goes to the order's own address")
            if self.db.execute("select 1 from attempts a join groups g on a.gid = g.gid "
                               "where g.oid = ?", (oid,)).fetchone():
                raise Refused("a refund has been built; its destination is fixed")
            self._set_order(oid, refund_address=address, refund_spk=script)
        self.flush_journal()

    # Owner and controller

    def cancel(self, oid):
        self.observe()
        with self.tx():
            o = self._order(oid)
            if o["status"] in ISSUED:
                raise Refused("not cancellable once issuing")
            n = self._name(o["name"])
            if n["fulfillment_order"] == oid:
                self._set_name(o["name"], fulfillment_order=None)
            if n["hold_order"] == oid:
                self._set_name(o["name"], hold_order=None, hold_expires_at=None,
                               hold_seen_height=None, hold_latched=None)
            self._set_order(oid, status="cancelled", price_reserve=0)
        self.observe()

    def batch_entry_ok(self, oid):
        o = self._order(oid)
        return (o["status"] == "converted" and bool(o["eligible"])
                and "issuance" not in json.loads(o["reasons"])
                and self.sum_at(oid, BATCHABLE) >= o["price_reserve"]
                and self.recipient_block(oid) is None)

    def issuing_recheck_ok(self, oid):
        o = self._order(oid)
        return (o["status"] == "issuing" and bool(o["eligible"])
                and self.sum_at(oid, BATCHABLE) >= o["price_reserve"]
                and self.recipient_block(oid) is None)

    # Recipients (PAYMENT-SPEC.md, "Recipient requests")

    def claimed_elsewhere(self, handle, script):
        """A paid order (converted onwards) for another handle claims the
        script. Derived from status: a cancelled order claims nothing, and a
        fulfilled one claims it for good."""
        q = ("select 1 from orders where recipient_spk = ? and name != ? and status in "
             "(%s)" % ",".join("?" * len(FULFILLABLE)))
        return self.db.execute(q, (script, handle, *FULFILLABLE)).fetchone() is not None

    def _conflicting(self, o):
        """Other paid orders on this order's script for other handles. An
        order already issuing yields only to another issuing one."""
        statuses = ISSUED if o["status"] in ISSUED else FULFILLABLE
        q = ("select oid from orders where recipient_spk = ? and name != ? and status in "
             "(%s) order by seq" % ",".join("?" * len(statuses)))
        return [r["oid"] for r in self.db.execute(q, (o["recipient_spk"], o["name"], *statuses))]

    def recipient_block(self, oid):
        """Why this order's recipient may not be issued to, or None."""
        o = self._order(oid)
        if o["recipient_problem"]:
            return o["recipient_problem"]
        if o["status"] in FULFILLABLE and self._conflicting(o):
            return "script conflict"
        return None

    def _recipient_quotable(self, o):
        if o["recipient_problem"]:
            raise Refused("recipient not accepted")
        if self.claimed_elsewhere(o["name"], o["recipient_spk"]):
            raise Refused("script already used")

    def _recipient_problem(self, o, destinations):
        if not canonical_handle(o["name"]):
            return "invalid handle"
        if not valid_p2tr(o["recipient_spk"]):
            return "invalid script"
        if o["recipient_spk"] in destinations:
            return "store destination script"
        return None

    def audit_recipients(self):
        """At every start: check each stored order's recipient against the
        current rules. A failing order is flagged and the owner alerted
        once; nothing else in its record changes."""
        with self.tx():
            destinations = {r["dest_script"] for r in self.db.execute(
                "select dest_script from orders where dest_script is not null")}
            for o in self.db.execute("select * from orders order by seq").fetchall():
                problem = self._recipient_problem(o, destinations)
                if problem and problem != o["recipient_problem"]:
                    self.db.execute("update orders set recipient_problem = ? where oid = ?",
                                    (problem, o["oid"]))
                    self._alert(o["oid"], "recipient_invalid", problem)
            self._alert_conflicts()

    def _alert_conflicts(self):
        """Alert the owner once per order caught in a script conflict."""
        q = ("select * from orders where status in (%s) order by seq"
             % ",".join("?" * len(FULFILLABLE)))
        for o in self.db.execute(q, FULFILLABLE).fetchall():
            if self._conflicting(o) and not self.db.execute(
                    "select 1 from alerts where oid = ? and kind = 'recipient_conflict'",
                    (o["oid"],)).fetchone():
                self._alert(o["oid"], "recipient_conflict",
                            {"status": o["status"], "conflicts": self._conflicting(o)})

    def invalidate_eligibility(self, oid):
        with self.tx():
            self._order(oid)
            self._set_order(oid, eligible=0)
        self.observe()

    def mark_issuing(self, oid):
        self.observe()
        with self.tx():
            o = self._order(oid)
            if o["status"] != "converted":
                raise Refused("not converted")
            if not self.batch_entry_ok(oid):
                raise Refused("batch entry refused")
            self._set_order(oid, status="issuing")
        self.observe()

    def mark_issuing_all(self, oids):
        """Every member passes batch entry and becomes `issuing` in one
        serialized transaction, or nothing changes. Returns the members whose
        marks reached the off-host journal."""
        self.observe()
        with self.tx():
            for oid in oids:
                if not self.batch_entry_ok(oid):
                    raise Refused(f"{oid} fails batch entry")
                self._set_order(oid, status="issuing")
        self.observe()
        pending = {r["key"] for r in self.db.execute(
            "select key from journal_backlog where kind = 'order'")}
        return [oid for oid in oids if oid not in pending]

    def _transition(self, oid, frm, to, why, observe_first=False):
        if observe_first:
            self.observe()
        with self.tx():
            o = self._order(oid)
            if o["status"] != frm:
                raise Refused(why)
            self._set_order(oid, status=to)
        self.observe()

    def unissue(self, oid):
        """Paid again: only after safe supersession is proven, or once the
        batch is journaled as rebuilt because it was never sent."""
        self._transition(oid, "issuing", "converted", "not issuing")

    def restore_issuing(self, oid):
        self._transition(oid, "converted", "issuing", "not converted")

    def unready(self, oid):
        self._transition(oid, "ready", "issuing", "not ready")

    def mark_ready(self, oid):
        self._transition(oid, "issuing", "ready", "not issuing", observe_first=True)

    def mark_fulfilled(self, oid):
        """Only after the handle's delivery is confirmed by a verified lookup."""
        self._transition(oid, "ready", "fulfilled", "not ready", observe_first=True)

    def open_incident(self, oid, kind, bid):
        with self.tx():
            o = self._order(oid)
            inc = json.loads(o["incident"]) if o["incident"] else None
            if inc is None or inc["resolution"] is not None:
                inc = {"bid": bid, "kinds": [], "resolution": None}
            if kind not in inc["kinds"]:
                inc["kinds"].append(kind)
                self._alert(oid, "incident", kind)
            self._set_order(oid, incident=_j(inc))
        self.observe()

    def resolve_incident(self, oid, resolution):
        with self.tx():
            o = self._order(oid)
            inc = json.loads(o["incident"]) if o["incident"] else None
            if inc is None or inc["resolution"] is not None:
                raise Refused("no open incident")
            if not resolution:
                raise Refused("a resolution must be recorded")
            inc["resolution"] = resolution
            self._set_order(oid, incident=_j(inc))
        self.observe()

    def record_loss(self, oid, reason):
        self.observe()
        with self.tx():
            o = self._order(oid)
            if reason not in REASONS:
                raise Refused("unknown reason")
            value = self.deficits(oid)[reason]
            if value <= 0:
                raise Refused("no deficit to record")
            losses = json.loads(o["losses"])
            losses[reason] = value
            reasons = set(json.loads(o["reasons"])) - {reason}
            self._set_order(oid, losses=_j(losses), reasons=_j(sorted(reasons)))
        self.observe()

    # Refunds

    def open_group(self, gid, oid, kind, tx, to_buyer, fee, charged=None):
        """Reserve for a new obligation group and record its first attempt,
        under the authorization rule, in one transaction."""
        self.observe()
        with self.tx():
            o = self._order(oid)
            if self.db.execute("select 1 from groups where gid = ?", (gid,)).fetchone():
                raise Refused("group exists")
            if kind not in ("excess", "cancellation"):
                raise Refused("unknown refund kind")
            if kind == "cancellation" and o["status"] not in REFUNDABLE_IN_FULL:
                raise Refused("order is not cancelled or refund due")
            if "refunds" in json.loads(o["reasons"]):
                raise Refused("refunds are reconciling")
            charged = to_buyer + fee if charged is None else charged
            avail = self.available(oid)
            if kind == "excess" and avail < fee + self.policy.excess_minimum_over_fee:
                raise Refused("excess below the refund minimum")
            if charged > avail:
                raise Refused("not enough settled funds")
            self.db.execute("insert into authorizations(gid, amount, available) values (?, ?, ?)",
                            (gid, charged, avail))
            self.db.execute("insert into groups(gid, oid, kind) values (?, ?, ?)", (gid, oid, kind))
            self._insert_attempt(gid, tx, to_buyer, fee, charged)
            self._dirty("group", gid)
        self.observe()

    def _insert_attempt(self, gid, tx, to_buyer, fee, charged):
        self.db.execute(
            "insert into attempts(txid, gid, inputs, outputs, raw, to_buyer, fee, charged) "
            "values (?, ?, ?, ?, ?, ?, ?, ?)",
            (tx["txid"], gid, _j([list(i) for i in tx["inputs"]]),
             _j([list(x) for x in tx["outputs"]]), tx.get("raw"), to_buyer, fee, charged))

    @staticmethod
    def attempt_tx(row):
        return {"txid": row["txid"], "inputs": [tuple(i) for i in json.loads(row["inputs"])],
                "outputs": [tuple(x) for x in json.loads(row["outputs"])], "raw": row["raw"]}

    def add_attempt(self, gid, tx, to_buyer, fee, charged=None):
        """A fee bump within the family, or an exclusive replacement family.
        Only the increase over the group's reservation needs capacity."""
        self.observe()
        pause = None
        with self.tx():
            g = self._group(gid)
            if g["closed_by"]:
                raise Refused("group closed")
            charged = to_buyer + fee if charged is None else charged
            attempts = self._attempts(gid)
            first = self.attempt_tx(attempts[0])
            in_family = set(first["inputs"]) <= set(tuple(i) for i in tx["inputs"])
            if not in_family and not self._conflict_settled(gid):
                raise Refused("a replacement family needs a settled conflicting spend")
            if not all(self.chain.exclusive(self.attempt_tx(a), tx) for a in attempts):
                if not g["paused"]:
                    self._alert(g["oid"], "refund_paused", gid)
                self._set_group(gid, paused=1)
                pause = "not mutually exclusive with every attempt; paused"
            else:
                increase = max(0, charged - self._reservation(gid))
                avail = self.available(g["oid"])
                if increase > avail:
                    raise Refused("not enough settled funds for the increase")
                self.db.execute("insert into authorizations(gid, amount, available) "
                                "values (?, ?, ?)", (gid, increase, avail))
                self._insert_attempt(gid, tx, to_buyer, fee, charged)
                self._set_group(gid, paused=0)
        if pause:
            # The pause is recorded and kept, then the attempt is refused.
            raise Refused(pause)
        self.observe()

    def _require_journaled(self, txid):
        a = self._attempt(txid)
        if not a["journaled"]:
            raise Refused("journal entry not acknowledged off-host")
        return a

    def export_psbt(self, gid, txid):
        with self.tx():
            self._require_journaled(txid)
            self.db.execute("update attempts set exported = 1 where txid = ?", (txid,))
            self._dirty("group", gid)
        self.observe()

    def release(self, gid):
        raise Refused("a reservation is released only by settled evidence")

    def broadcast(self, gid, txid):
        """Record the attempt as broadcast, then call the node, then record
        the answer. A lost answer leaves the attempt unacknowledged."""
        with self.tx():
            a = self._require_journaled(txid)
            if a["gid"] != gid:
                raise Refused("attempt is not in this group")
            self.db.execute("update attempts set attempted = 1 where txid = ?", (txid,))
            self._dirty("group", gid)
        try:
            self.chain.send(self.attempt_tx(a))
            sent = True
        except (SendUncertain, SendFailed):
            sent = False
        if sent:
            with self.tx():
                self.db.execute("update attempts set acknowledged = 1 where txid = ?", (txid,))
                self._dirty("group", gid)
        self.observe()
        return sent

    def reconcile_attempts(self):
        """After a restart: look every attempt up before anything else.
        Returns the txids to rebroadcast as the same transaction."""
        self.chain.refresh()
        rebroadcast = []
        with self.tx():
            for a in self.db.execute("select * from attempts order by seq").fetchall():
                known = (self.chain.position(a["txid"]) is not None
                         or self.chain.in_mempool(a["txid"]))
                if known:
                    if not a["acknowledged"]:
                        self.db.execute("update attempts set acknowledged = 1 where txid = ?",
                                        (a["txid"],))
                        self._dirty("group", a["gid"])
                elif a["attempted"]:
                    rebroadcast.append(a["txid"])
        return rebroadcast

    def rebroadcast(self, gid, txid):
        """The same signed transaction again, under the same precondition as
        the first broadcast, checked immediately before the call."""
        with self.tx():
            a = self._require_journaled(txid)
            self.db.execute("update attempts set attempted = 1 where txid = ?", (txid,))
            self._dirty("group", gid)
        try:
            self.chain.send(self.attempt_tx(a))
        except (SendUncertain, SendFailed):
            pass
        self.observe()

    # Evaluation

    def observe(self):
        self.chain.refresh()
        with self.tx():
            self.record_payment_outputs()
            for o in self.db.execute("select oid from orders order by seq").fetchall():
                self._step_order(o["oid"])
            for g in self.db.execute("select gid from groups order by seq").fetchall():
                self._step_group(g["gid"])
            for o in self.db.execute("select oid from orders order by seq").fetchall():
                self._reasons(o["oid"])
            # A conversion can create a script conflict; tell the owner once.
            self._alert_conflicts()
        self.flush_journal()

    def record_payment_outputs(self):
        """Keep every payment output ever seen, so the order's history
        survives the output leaving the chain. Balances still come only from
        the chain position at evaluation."""
        for o in self.db.execute("select oid, dest_script from orders "
                                 "where dest_script is not null").fetchall():
            for x in self.chain.outputs_to(o["dest_script"]):
                self.db.execute("insert or ignore into payment_outputs values (?, ?, ?, ?)",
                                (x["outpoint"][0], x["outpoint"][1], o["oid"], x["value"]))

    def _step_order(self, oid):
        o = self._order(oid)
        n = self._name(o["name"])
        tip = self.chain.tip
        now = self.clock()
        if o["status"] == "quoted" and n["hold_order"] == oid:
            seen = n["hold_seen_height"]
            if seen is None and self.outputs(oid) and now < n["hold_expires_at"]:
                seen = tip
                self._set_name(o["name"], hold_seen_height=seen)
            confirmed = self.sum_at(oid, CONFIRMED)
            if seen is None:
                active = now < n["hold_expires_at"]
            elif tip <= seen + EXTENSION_BLOCKS:
                active = True
            else:
                latched = n["hold_latched"]
                if latched is None:
                    latched = int(confirmed >= o["price"])
                if latched and confirmed < o["price"]:
                    latched = 0
                if latched != n["hold_latched"]:
                    self._set_name(o["name"], hold_latched=latched)
                active = bool(latched)
            if active and self.sum_at(oid, BATCHABLE) >= o["price"]:
                self._set_name(o["name"], hold_order=None, hold_expires_at=None,
                               hold_seen_height=None, hold_latched=None, fulfillment_order=oid)
                self._set_order(oid, status="converted", price_reserve=o["price"])
            elif not active:
                self._set_name(o["name"], hold_order=None, hold_expires_at=None,
                               hold_seen_height=None, hold_latched=None)
                self._set_order(oid, status="refund_due" if confirmed > 0 else "unpaid")
        elif (o["status"] == "unpaid" and not o["late_evaluated"]
              and self.sum_at(oid, CONFIRMED) > 0):
            # A late payment, evaluated once.
            self._set_order(oid, late_evaluated=1)
            if (n["hold_order"] is None and n["fulfillment_order"] is None
                    and n["price"] <= o["price"]):
                self._set_order(oid, price=n["price"], status="quoted")
                self._set_name(o["name"], hold_order=oid,
                               hold_expires_at=now + self.policy.hold_seconds,
                               hold_seen_height=tip, hold_latched=None)
                self._step_order(oid)
            else:
                self._set_order(oid, status="refund_due")

    def _conflict_settled(self, gid):
        attempts = self._attempts(gid)
        ids = {a["txid"] for a in attempts}
        for a in attempts:
            for op in json.loads(a["inputs"]):
                sp = self.chain.spender(tuple(op))
                if sp is not None and sp not in ids and self.chain.conf(sp) >= SETTLED:
                    return True
        return False

    def _step_group(self, gid):
        g = self._group(gid)
        settled = [a["txid"] for a in self._attempts(gid) if self.chain.conf(a["txid"]) >= SETTLED]
        closed = g["closed_by"]
        if closed is None and settled:
            self._set_group(gid, closed_by=settled[0])
        elif closed is not None and self.chain.conf(closed) < SETTLED:
            self._set_group(gid, closed_by=settled[0] if settled else None)
        if self._conflict_settled(gid) and not g["needs_rebuild"]:
            self._set_group(gid, needs_rebuild=1)

    def _reasons(self, oid):
        o = self._order(oid)
        reasons = set(json.loads(o["reasons"]))
        losses = json.loads(o["losses"])
        before = set(reasons)
        for reason, value in self.deficits(oid).items():
            over = value - losses.get(reason, 0)
            if over > 0:
                if reason not in reasons:
                    self._alert(oid, reason, over)
                reasons.add(reason)
            else:
                reasons.discard(reason)
        if reasons != before:
            self._set_order(oid, reasons=_j(sorted(reasons)))

    # Views

    def order_view(self, oid):
        """What the order link shows: never another order's data."""
        o = self._order(oid)
        n = self._name(o["name"])
        groups = []
        for g in self._groups_of(oid):
            groups.append({"kind": g["kind"], "closed": bool(g["closed_by"]),
                           "attempts": [{"txid": a["txid"], "to_buyer": a["to_buyer"],
                                         "fee": a["fee"], "broadcast": bool(a["attempted"])}
                                        for a in self._attempts(g["gid"])]})
        return {
            "handle": o["name"], "recipient_script_pubkey": o["recipient_spk"],
            "status": o["status"], "price_sats": o["price"], "address": o["dest_address"],
            "hold_expires_at": n["hold_expires_at"] if n["hold_order"] == oid else None,
            "confirmed_sats": self.sum_at(oid, CONFIRMED),
            "batchable_sats": self.sum_at(oid, BATCHABLE),
            "settled_sats": self.sum_at(oid, SETTLED),
            "reconciling": json.loads(o["reasons"]),
            "refund_address": o["refund_address"], "refunds": groups,
            "incident": json.loads(o["incident"]) if o["incident"] else None,
        }

    def operator_view(self, oid):
        o = self._order(oid)
        out = {k: o[k] for k in o.keys() if k not in ("token_hash", "seq")}
        out["reasons"] = json.loads(o["reasons"])
        out["losses"] = json.loads(o["losses"])
        out["incident"] = json.loads(o["incident"]) if o["incident"] else None
        out["available"] = self.available(oid)
        out["reserved"] = self.reserved(oid)
        out["refunded_total"] = self.refunded_total(oid)
        out["sums"] = {"confirmed": self.sum_at(oid, CONFIRMED),
                       "batchable": self.sum_at(oid, BATCHABLE),
                       "settled": self.sum_at(oid, SETTLED)}
        out["groups"] = [dict(g, attempts=[dict(a) for a in self._attempts(g["gid"])])
                         for g in map(dict, self._groups_of(oid))]
        return out

    def acknowledged_status(self, oid):
        """The order's status in its latest acknowledged journal entry."""
        status = None
        for e in self.journal.entries():
            if e["kind"] == "order" and e["key"] == oid:
                status = e["state"]["status"]
        return status

    def journal_order(self, oid):
        """Journal the order's current state again. True once acknowledged."""
        with self.tx():
            self._order(oid)
            self._dirty("order", oid)
        self.flush_journal()
        return self.db.execute("select 1 from journal_backlog where kind = 'order' and key = ?",
                               (oid,)).fetchone() is None

    def orders(self, status=None):
        q = "select oid from orders" + (" where status = ?" if status else "") + " order by seq"
        return [r["oid"] for r in self.db.execute(q, (status,) if status else ())]

    def alerts(self):
        return [dict(r) for r in self.db.execute("select * from alerts order by n")]

    # The frozen batch, as served to subs (public handle and script only)

    def set_pending(self, oids):
        with self.tx():
            for oid in oids:
                if self.recipient_block(oid):
                    raise Refused(f"{oid}: recipient blocked")
            self.db.execute("delete from pending")
            for oid in oids:
                o = self._order(oid)
                self.db.execute("insert into pending values (?, ?)",
                                (o["name"], o["recipient_spk"]))

    def pending_for(self, space):
        """Never serves a handle whose recipient is blocked, even if it was
        frozen before the block (a row from before the audit)."""
        out = []
        for r in self.db.execute("select * from pending order by handle").fetchall():
            if not r["handle"].endswith(space):
                continue
            if not (canonical_handle(r["handle"]) and valid_p2tr(r["script_pubkey"])):
                continue
            orders = self.db.execute("select oid from orders where name = ? and recipient_spk = ?",
                                     (r["handle"], r["script_pubkey"])).fetchall()
            if any(self.recipient_block(o["oid"]) for o in orders):
                continue
            out.append({"handle": r["handle"], "script_pubkey": r["script_pubkey"]})
        return out

    def subs_ack(self, entries):
        """subs' staging outcome per handle. An `already_*_different_spk`
        outcome means the name can't go to this recipient; the owner is
        alerted (docs/SERVICE.md)."""
        with self.tx():
            for e in entries:
                handle, outcome = e.get("handle"), e.get("outcome")
                rows = self.db.execute("select oid from orders where name = ? and status in "
                                       "('converted', 'issuing')", (handle,)).fetchall()
                for r in rows:
                    self._set_order(r["oid"], subs_outcome=outcome)
                    if outcome and outcome.startswith("already_") and \
                            outcome.endswith("different_spk"):
                        self._alert(r["oid"], "subs_different_spk", outcome)
        self.flush_journal()

    def subs_committed(self, root, handles):
        with self.tx():
            for h in handles:
                self.db.execute("insert or replace into committed values (?, ?)", (h, root))
