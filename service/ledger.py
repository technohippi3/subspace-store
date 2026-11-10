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
evaluation commits, then writes the off-host journal backlog as one entry,
acknowledged whole or not at all. A refund attempt counts as journaled only
once its group's entry is acknowledged, and nothing is exported or broadcast
before that. The same holds for what the buyer and the operator are told:
an order's payment address is given out, and its cancellation reported
final, only once the order's entry carrying it is acknowledged
(`journaled_status`).

After a host loss the database is rebuilt from the journal alone
(`restore_from_journal`, PAYMENT-SPEC.md "Host loss and restore"). A start
never runs an empty store over a journal that has entries.
"""

import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

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


class Unconfirmed(Refused):
    """Refused because the off-host journal can't acknowledge it now."""


class RestoreRequired(Exception):
    """No store database, but the off-host journal has entries."""


class RestoreRefused(Exception):
    """The journal can't be restored as it is, or the target isn't free."""


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
  recipient_problem text,
  journaled_status text,
  payment_history text not null default 'none'
    check (payment_history in ('none', 'detected', 'unknown'))
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
create table if not exists certificates (
  oid text primary key references orders(oid), message blob not null, delivered_at real not null
);
"""


def _j(v):
    return json.dumps(v, sort_keys=True)


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


# What the journal records, in the order a restore writes them back.
RECORD_KINDS = ("name", "order", "group", "alert", "authorization")


def _has_store(path):
    """True if the database at `path` holds any name or order. Read-only:
    it never creates or changes the file."""
    if not path.exists():
        return False
    # Without a WAL file the main file is complete, and an immutable open
    # creates nothing. With one, as after a crash, it must be read too.
    wal = Path(str(path) + "-wal").exists()
    try:
        db = sqlite3.connect(path.resolve().as_uri() + ("?mode=ro" if wal else "?mode=ro&immutable=1"),
                             uri=True)
        try:
            return any(db.execute(f"select 1 from {t} limit 1").fetchone()
                       for t in ("names", "orders"))
        finally:
            db.close()
    except sqlite3.Error:
        return False


class Ledger:
    def __init__(self, db_path, chain, journal, policy=None, clock=time.time):
        if journal.entries() and not _has_store(Path(db_path)):
            raise RestoreRequired(
                f"no store database at {db_path}, but the off-host journal has entries: "
                "restore it first (python3 -m service restore <config>)")
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
        if "journaled_status" not in cols:
            # A database from before the column: take each order's status
            # from its latest acknowledged entry.
            self.db.execute("alter table orders add column journaled_status text")
            for oid, status in self._journaled_statuses().items():
                self.db.execute("update orders set journaled_status = ? where oid = ?",
                                (status, oid))
        if "payment_history" not in cols:
            self._migrate_payment_history()
        self.policy = policy or Policy()
        self.clock = clock
        self._depth = 0
        self.audit_recipients()

    def close(self):
        self.db.close()

    def _migrate_payment_history(self):
        """A database from before the marker. Its payment outputs aren't a
        complete history: a database restored from the journal has none,
        and one may have missed a payment it never observed. So the same
        rule as a restore: a recorded output means detected, any other order
        given an address is unknown, and only one never given an address is
        none. The column and its values arrive in one transaction, so an
        interrupted migration leaves the database as it was and runs again."""
        self.db.execute("begin immediate")
        try:
            self.db.execute("alter table orders add column payment_history text not null "
                            "default 'none' check (payment_history in "
                            "('none', 'detected', 'unknown'))")
            self._classify_payment_history()
        except BaseException:
            self.db.execute("rollback")
            raise
        self.db.execute("commit")

    def _classify_payment_history(self):
        self.db.execute("update orders set payment_history = 'detected' where oid in "
                        "(select oid from payment_outputs)")
        self.db.execute("update orders set payment_history = 'unknown' where "
                        "dest_script is not null and payment_history != 'detected'")

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
            # With the link's hash, never the link: a restored link still
            # opens its order, and the journal can't give one away. What the
            # journal acknowledged is a fact about the journal, not the order.
            state = dict(self._order(key))
            del state["journaled_status"]
            return state
        if kind == "alert":
            return dict(self.db.execute("select * from alerts where n = ?", (int(key),)).fetchone())
        if kind == "authorization":
            return dict(self.db.execute("select * from authorizations where n = ?",
                                        (int(key),)).fetchone())
        if kind == "name":
            return dict(self._name(key))
        if kind == "group":
            g = dict(self._group(key))
            g["attempts"] = [dict(a) for a in self._attempts(key)]
            return g
        raise ValueError(kind)

    def flush_journal(self):
        """Write every backlogged record's current state to the off-host
        journal as one entry, acknowledged whole or not at all. Records not
        in the backlog are unchanged since their last acknowledgment, so the
        acknowledged state is always one the store was in."""
        if not self.journal.available():
            return False
        rows = self.db.execute("select kind, key from journal_backlog order by rowid").fetchall()
        if not rows:
            return True
        records = [{"kind": r["kind"], "key": r["key"], "state": self._snapshot(r["kind"], r["key"])}
                   for r in rows]
        try:
            self.journal.append("state", records=records)
        except JournalDown:
            return False
        with self.tx():
            for rec in records:
                self.db.execute("delete from journal_backlog where kind = ? and key = ?",
                                (rec["kind"], rec["key"]))
                if rec["kind"] == "group":
                    for a in rec["state"]["attempts"]:
                        self.db.execute("update attempts set journaled = 1 where txid = ?",
                                        (a["txid"],))
                if rec["kind"] == "order":
                    self.db.execute("update orders set journaled_status = ? where oid = ?",
                                    (rec["state"]["status"], rec["key"]))
        return True

    def _alert(self, oid, kind, detail):
        cur = self.db.execute("insert into alerts(oid, kind, detail, at) values (?, ?, ?, ?)",
                              (oid, kind, _j(detail), self.clock()))
        self._dirty("alert", str(cur.lastrowid))

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
        destination script from the payment wallet.

        The address is given out only once the order carrying it is
        acknowledged off-host (PAYMENT-SPEC.md, "Payment instructions"). With
        the journal known to be down the quote is refused before anything is
        taken. If the acknowledgment doesn't arrive, the quote is recorded but
        returned with no address and `acknowledged` false; asking again
        returns the same quote while its hold lasts, after the same recipient
        checks as a first quote."""
        self.observe()
        o = self._order(oid)
        if o["status"] == "quoted" and self._name(o["name"])["hold_order"] == oid:
            self._recipient_quotable(o)
            return self._quote(oid)
        if o["status"] != "requested":
            raise Refused("already quoted")
        self._recipient_quotable(o)
        n = self._name(o["name"])
        if n["hold_order"] is not None or n["fulfillment_order"] is not None:
            raise Refused("taken for now")
        if not self.journal.available():
            raise Unconfirmed("the off-host journal is unavailable; no quote was made")
        address, script, skipped = self._fresh_destination(oid)
        with self.tx():
            self._recipient_quotable(self._order(oid))
            n = self._name(o["name"])
            if n["hold_order"] is not None or n["fulfillment_order"] is not None:
                raise Refused("taken for now")
            if skipped:
                # The payment wallet is behind the journal: the owner is told.
                self._alert(oid, "destination_held", {"skipped": skipped})
            self._set_order(oid, status="quoted", price=n["price"], dest_script=script,
                            dest_address=address)
            self._set_name(o["name"], hold_order=oid,
                           hold_expires_at=self.clock() + self.policy.hold_seconds,
                           hold_seen_height=None, hold_latched=None)
        self.observe()
        return self._quote(oid)

    def _fresh_destination(self, oid):
        """A destination no order holds, for its payment or as its refund
        address (PAYMENT-SPEC.md, "Refunds"). A payment wallet restored from
        an earlier backup has seen only the addresses that were paid, so it
        can give out again an address a restored, unpaid quote still holds;
        and a buyer can give a refund address before the quote that the
        wallet then gives out. Each request advances the wallet, so it is
        asked again, at most once more than the number of addresses orders
        hold. Returns the address, its script and how many held ones were
        skipped."""
        held = self.db.execute(
            "select (select count(*) from orders where dest_script is not null)"
            " + (select count(*) from orders where refund_spk is not null)").fetchone()[0]
        for skipped in range(held + 1):
            address, script = self.chain.new_destination(oid)
            if not self.db.execute("select 1 from orders where dest_script = ? "
                                   "or refund_spk = ?", (script, script)).fetchone():
                return address, script, skipped
        raise Refused("the payment wallet gave out only addresses that orders hold; no quote "
                      "was made")

    def instructions_given(self, o):
        """Whether the order's payment address may be shown: its latest
        acknowledged entry already carries it, which every status after
        `requested` does."""
        return o["journaled_status"] not in (None, "requested")

    def _quote(self, oid):
        o = self._order(oid)
        n = self._name(o["name"])
        given = self.instructions_given(o)
        return {"price_sats": o["price"], "address": o["dest_address"] if given else None,
                "expires_at": n["hold_expires_at"] if n["hold_order"] == oid else None,
                "acknowledged": given}

    def set_refund_address(self, oid, address, script):
        """The buyer's refund destination, given through the order link.
        Never a payment address of any order, whatever its status: a refund
        paying it would count as that order's payment (PAYMENT-SPEC.md,
        "Refunds")."""
        with self.tx():
            self._order(oid)
            if self.db.execute("select 1 from orders where dest_script = ?",
                               (script,)).fetchone():
                raise Refused("a refund never goes to one of the store's payment addresses")
            if self.db.execute("select 1 from attempts a join groups g on a.gid = g.gid "
                               "where g.oid = ?", (oid,)).fetchone():
                raise Refused("a refund has been built; its destination is fixed")
            self._set_order(oid, refund_address=address, refund_spk=script)
        self.flush_journal()

    # Owner and controller

    def cancel(self, oid):
        """Returns True once the cancellation is final: the order's latest
        acknowledged entry has it cancelled. Until then it is recorded here
        only, and a host loss undoes it."""
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
        return self._order(oid)["journaled_status"] == "cancelled"

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

    # Certificate delivery to the buyer's order page. The runner delivers a
    # certificate message only after verifying it; the store keeps it but
    # doesn't verify it. It isn't journaled: after a restore the runner
    # delivers it again from subs.

    CERTIFIABLE = ("ready", "fulfilled")

    def deliver_certificate(self, oid, message):
        if not isinstance(message, bytes) or not message:
            raise Invalid("an empty certificate")
        with self.tx():
            if self._order(oid)["status"] not in self.CERTIFIABLE:
                raise Refused("a certificate is delivered only for a ready order")
            self.db.execute("insert or replace into certificates(oid, message, delivered_at) "
                            "values (?, ?, ?)", (oid, message, self.clock()))

    def certificate(self, oid):
        """The delivered certificate, only while the order is ready or
        fulfilled."""
        if self._order(oid)["status"] not in self.CERTIFIABLE:
            return None
        row = self.db.execute("select message from certificates where oid = ?",
                              (oid,)).fetchone()
        return bytes(row["message"]) if row else None

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
            self._authorize(gid, charged, avail)
            self.db.execute("insert into groups(gid, oid, kind) values (?, ?, ?)", (gid, oid, kind))
            self._insert_attempt(gid, tx, to_buyer, fee, charged)
            self._dirty("group", gid)
        self.observe()

    def _authorize(self, gid, amount, available):
        cur = self.db.execute("insert into authorizations(gid, amount, available) "
                              "values (?, ?, ?)", (gid, amount, available))
        self._dirty("authorization", str(cur.lastrowid))

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
                self._authorize(gid, increase, avail)
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
        for o in self.db.execute("select oid, dest_script, payment_history from orders "
                                 "where dest_script is not null").fetchall():
            found = self.chain.outputs_to(o["dest_script"])
            for x in found:
                self.db.execute("insert or ignore into payment_outputs values (?, ?, ?, ?)",
                                (x["outpoint"][0], x["outpoint"][1], o["oid"], x["value"]))
            if found and o["payment_history"] != "detected":
                # Journaled with the order, so a restore knows a payment was
                # detected even once no node sees it.
                self._set_order(o["oid"], payment_history="detected")

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
        given = self.instructions_given(o)
        rejected = bool(o["recipient_problem"])
        status, cancellation = o["status"], None
        if status == "cancelled":
            # A cancellation the journal hasn't acknowledged isn't shown as
            # one: the buyer sees the last acknowledged status, which is
            # what a host loss would bring back.
            if o["journaled_status"] == "cancelled":
                cancellation = "final"
            else:
                status, cancellation = o["journaled_status"], "unconfirmed"
        return {
            "handle": o["name"], "recipient_script_pubkey": o["recipient_spk"],
            "status": status, "cancellation": cancellation, "price_sats": o["price"],
            # Never an address the journal hasn't acknowledged: a host loss
            # would forget it while the buyer could still pay it. Never one
            # for a recipient the store won't issue to.
            "address": o["dest_address"] if given and not rejected else None,
            "address_pending": bool(o["dest_address"]) and not given and not rejected,
            "recipient_rejected": rejected,
            "hold_expires_at": n["hold_expires_at"] if n["hold_order"] == oid else None,
            # Everything this node sees paying the order now, mempool
            # included. Shown, never counted: only CONFIRMED and deeper
            # count toward anything.
            "detected_sats": self.sum_at(oid, 0),
            # "none": no payment was ever detected; "detected": one was,
            # even if no node sees it now; "unknown": restored, and the
            # journal can't tell (PAYMENT-SPEC.md, "Checkout").
            "payment_history": o["payment_history"],
            "confirmed_sats": self.sum_at(oid, CONFIRMED),
            "batchable_sats": self.sum_at(oid, BATCHABLE),
            "settled_sats": self.sum_at(oid, SETTLED),
            "reconciling": json.loads(o["reasons"]),
            "refund_address": o["refund_address"], "refunds": groups,
            "incident": json.loads(o["incident"]) if o["incident"] else None,
            "certificate_available": self.certificate(oid) is not None,
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
        return self._order(oid)["journaled_status"]

    def _journaled_statuses(self):
        statuses = {}
        for e in self.journal.entries():
            for rec in e.get("records", ()):
                if rec.get("kind") == "order":
                    statuses[str(rec["key"])] = rec["state"].get("status")
        return statuses

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


# Restore from the off-host journal alone (PAYMENT-SPEC.md, "Host loss and
# restore")

def acknowledged_records(journal):
    """The latest acknowledged state of every record, by kind and key."""
    latest = {k: {} for k in RECORD_KINDS}
    try:
        entries = journal.entries()
    except ValueError as e:
        raise RestoreRefused(f"the journal has an unreadable line: {e}")
    for e in entries:
        if e.get("kind") != "state":
            raise RestoreRefused(f"journal entry {e.get('seq')} has unknown kind {e.get('kind')!r}")
        for rec in e.get("records", ()):
            kind = rec.get("kind")
            if kind not in latest:
                raise RestoreRefused(f"journal entry {e.get('seq')} has a record of unknown "
                                     f"kind {kind!r}, key {rec.get('key')!r}")
            latest[kind][str(rec["key"])] = rec["state"]
    return latest


def _check_restorable(latest):
    names, orders, groups = latest["name"], latest["order"], latest["group"]
    for oid, o in orders.items():
        if not o.get("token_hash"):
            raise RestoreRefused(f"order {oid} has no order link hash in the journal")
        if o.get("name") not in names:
            raise RestoreRefused(f"order {oid} names {o.get('name')!r}, which has no journal entry")
    for gid, g in groups.items():
        if g.get("oid") not in orders:
            raise RestoreRefused(f"refund group {gid} belongs to order {g.get('oid')!r}, "
                                 "which has no journal entry")
    for n, a in latest["alert"].items():
        if a.get("oid") is not None and a["oid"] not in orders:
            raise RestoreRefused(f"alert {n} names order {a['oid']!r}, which has no journal entry")
    for n, a in latest["authorization"].items():
        if a.get("gid") not in groups:
            raise RestoreRefused(f"authorization {n} names refund group {a.get('gid')!r}, "
                                 "which has no journal entry")


def _insert(db, table, what, state):
    cols = {r[1] for r in db.execute(f"pragma table_info({table})")}
    unknown = set(state) - cols
    if unknown:
        raise RestoreRefused(f"{what} has fields the store doesn't have: {sorted(unknown)}")
    keys = sorted(state)
    db.execute(f"insert into {table} ({', '.join(keys)}) values ({', '.join('?' * len(keys))})",
               [state[k] for k in keys])


def _database_files(path):
    return [Path(str(path) + suffix) for suffix in ("", "-wal", "-shm", "-journal")]


def restore_from_journal(db_path, journal):
    """Rebuild the store's database from the off-host journal alone, into a
    path where no database exists. Builds beside the target and moves the
    result into place only once complete. Returns the record counts."""
    target = Path(db_path)
    if any(f.exists() for f in _database_files(target)):
        raise RestoreRefused(f"a database already exists at {target}; a restore never overwrites")
    latest = acknowledged_records(journal)
    if not any(latest.values()):
        # A wrong or unmounted journal directory looks like this: say so
        # rather than create an empty store.
        raise RestoreRefused("the journal has no records; nothing to restore")
    _check_restorable(latest)
    work = target.with_name(target.name + ".restoring")
    for f in _database_files(work):
        f.unlink(missing_ok=True)
    try:
        db = sqlite3.connect(str(work), isolation_level=None)
        try:
            db.execute("pragma foreign_keys = on")
            db.executescript(SCHEMA)
            db.execute("begin")
            for key, state in latest["name"].items():
                _insert(db, "names", f"name {key}", state)
            for key, state in sorted(latest["order"].items(), key=lambda kv: kv[1].get("seq", 0)):
                # Restored from its acknowledged entry, so that is its
                # journaled status.
                _insert(db, "orders", f"order {key}",
                        dict(state, journaled_status=state.get("status")))
            # A payment detected after an order's last acknowledged entry,
            # or before the journal held the marker, left no trace here. Only
            # an order never given an address is known never to have been
            # paid; any other the journal doesn't mark detected is unknown.
            db.execute("update orders set payment_history = 'unknown' where "
                       "dest_script is not null and payment_history != 'detected'")
            for key, state in sorted(latest["group"].items(), key=lambda kv: kv[1].get("seq", 0)):
                state = dict(state)
                attempts = state.pop("attempts", [])
                _insert(db, "groups", f"refund group {key}", state)
                for a in attempts:
                    # In the journal, so journaled, whatever the copy said
                    # when it was taken.
                    _insert(db, "attempts", f"attempt {a.get('txid')} of {key}",
                            dict(a, journaled=1))
            for kind, table in (("alert", "alerts"), ("authorization", "authorizations")):
                for key, state in sorted(latest[kind].items(), key=lambda kv: int(kv[0])):
                    _insert(db, table, f"{kind} {key}", state)
            db.execute("commit")
        except sqlite3.Error as e:
            raise RestoreRefused(f"the journal doesn't restore: {e}")
        finally:
            db.close()
        os.replace(work, target)
    except BaseException:
        for f in _database_files(work):
            f.unlink(missing_ok=True)
        raise
    return {kind: len(latest[kind]) for kind in RECORD_KINDS}
