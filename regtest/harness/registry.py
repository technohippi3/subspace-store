"""A minimal fixed-price registry for the regtest harness.

It covers the path the first purchase takes and the refusals the scenarios
check, nothing more: a public recipient request, a fixed-price quote with a
temporary hold, payment observed on the regtest node, conversion at three
confirmations, batch entry, `issuing`, readiness and cancellation. Refunds,
late payments, hold extensions and eligibility proofs are not here; the
reference model covers those rules, and the regtest report says which cases
were not exercised.

State lives in SQLite on the host. Every order change is appended to the
store's off-host journal, and the `issuing` transition only counts as
acknowledged once that append is confirmed.

subs reaches the registry through `/health`, `/pending`, `/ack` and
`/committed`, with a bearer token made for the run. `/pending` returns
exactly the members of the frozen batch and nothing else.
"""

import json
import re
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .journal import JournalDown

BATCHABLE = 3
SETTLED = 6
HOLD_SECONDS = 15 * 60  # proposal in PAYMENT-SPEC.md
ISSUED = ("issuing", "ready", "fulfilled")

HANDLE_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?@[a-z0-9-]{1,63}$")
SPK_RE = re.compile(r"^[0-9a-f]{4,160}$")


class Refused(Exception):
    pass


SCHEMA = """
create table if not exists names (
  name text primary key, price integer not null,
  hold_order text, fulfillment_order text
);
create table if not exists orders (
  oid text primary key, name text not null, recipient_spk text not null,
  price integer, pay_address text, pay_spk text, status text not null,
  quote_expires_at real, reasons text not null default '[]',
  price_reserve integer not null default 0, acked text
);
create unique index if not exists one_hold on names(hold_order);
create unique index if not exists one_fulfillment on names(fulfillment_order);
create table if not exists pending (handle text primary key, script_pubkey text not null);
create table if not exists committed (handle text primary key, root text not null);
"""


class Registry:
    def __init__(self, db_path, journal, btc_store, btc_node, token, clock=time.time):
        self.db = sqlite3.connect(db_path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.lock = threading.RLock()
        self.journal = journal
        self.btc_store = btc_store  # the store's bitcoind wallet, watching payment addresses
        self.btc_node = btc_node
        self.token = token
        self.clock = clock
        self.n = self._count_orders()
        self.server = None

    def _count_orders(self):
        return self.db.execute("select count(*) from orders").fetchone()[0]

    # Journal

    def _journal_order(self, oid):
        row = dict(self.order(oid))
        self.journal.append("order", order=row)

    def journal_ok(self, oid):
        """Write the order's current state to the off-host journal. False if
        the journal is down: the change stays local and unacknowledged."""
        try:
            self._journal_order(oid)
            return True
        except JournalDown:
            return False

    def acknowledged_status(self, oid):
        status = None
        for e in self.journal.entries():
            if e["kind"] == "order" and e["order"]["oid"] == oid:
                status = e["order"]["status"]
        return status

    # Owner

    def list_name(self, name, price):
        with self.lock:
            self.db.execute("insert or replace into names(name, price) values (?, ?)", (name, price))
            self.journal.append("name", name=name, price=price)

    # Buyer

    def request(self, handle, recipient_spk):
        """A public recipient request: the handle and the buyer's script."""
        if not HANDLE_RE.match(handle):
            raise Refused("invalid handle")
        if not SPK_RE.match(recipient_spk) or len(recipient_spk) % 2:
            raise Refused("invalid script_pubkey")
        with self.lock:
            if self.db.execute("select 1 from names where name = ?", (handle,)).fetchone() is None:
                raise Refused("not for sale")
            self.n += 1
            oid = f"o{self.n}"
            self.db.execute("insert into orders(oid, name, recipient_spk, status) values (?, ?, ?, 'requested')",
                            (oid, handle, recipient_spk))
            self._journal_order(oid)
            return oid

    def quote(self, oid):
        with self.lock:
            self.observe()
            o = self.order(oid)
            if o["status"] != "requested":
                raise Refused("already quoted")
            n = self.db.execute("select * from names where name = ?", (o["name"],)).fetchone()
            if n["hold_order"] or n["fulfillment_order"]:
                raise Refused("taken for now")
            address = self.btc_store.call("getnewaddress", oid, "bech32m")
            spk = self.btc_store.call("getaddressinfo", address)["scriptPubKey"]
            expires = self.clock() + HOLD_SECONDS
            self.db.execute("begin immediate")
            self.db.execute("update names set hold_order = ? where name = ?", (oid, o["name"]))
            self.db.execute("""update orders set status = 'quoted', price = ?, pay_address = ?,
                               pay_spk = ?, quote_expires_at = ? where oid = ?""",
                            (n["price"], address, spk, expires, oid))
            self.db.execute("commit")
            self._journal_order(oid)
            return {"oid": oid, "price_sats": n["price"], "address": address,
                    "expires_at": expires}

    # Payments

    def outputs(self, o):
        """Outputs paying the order's script, with their confirmations, read
        from the store's regtest node. Each `txid:vout` counts once."""
        if not o["pay_address"]:
            return []
        seen = {}
        for u in self.btc_store.call("listunspent", 0, 9999999, [o["pay_address"]], True):
            seen[(u["txid"], u["vout"])] = (int(round(u["amount"] * 1e8)), u["confirmations"])
        return [{"outpoint": k, "value": v, "conf": c} for k, (v, c) in seen.items()]

    def sum_at(self, o, depth):
        return sum(x["value"] for x in self.outputs(o) if x["conf"] >= depth)

    def observe(self):
        """Advance holds and conversions against the current chain."""
        with self.lock:
            for o in self.db.execute("select * from orders").fetchall():
                self._step(o)

    def _step(self, o):
        oid, status = o["oid"], o["status"]
        if status == "quoted":
            batchable = self.sum_at(o, BATCHABLE)
            hold_active = self.clock() <= o["quote_expires_at"]
            if hold_active and batchable >= o["price"]:
                self.db.execute("begin immediate")
                self.db.execute("""update names set hold_order = null, fulfillment_order = ?
                                   where name = ?""", (oid, o["name"]))
                self.db.execute("""update orders set status = 'converted', price_reserve = ?
                                   where oid = ?""", (o["price"], oid))
                self.db.execute("commit")
                self._journal_order(oid)
            elif not hold_active:
                # Hold ended without conversion. Refund rules are not in the
                # harness; the order is left as expired.
                self.db.execute("update names set hold_order = null where hold_order = ?", (oid,))
                self.db.execute("update orders set status = 'expired' where oid = ?", (oid,))
                self._journal_order(oid)
        elif status in ("converted",) + ISSUED:
            short = o["price_reserve"] - self.sum_at(o, BATCHABLE)
            reasons = set(json.loads(o["reasons"]))
            reason = "issuance" if status == "converted" else "post_issuance_deficit"
            changed = False
            if short > 0 and reason not in reasons:
                reasons.add(reason)
                changed = True
            elif short <= 0 and reason in reasons:
                reasons.discard(reason)
                changed = True
            if changed:
                self.db.execute("update orders set reasons = ? where oid = ?",
                                (json.dumps(sorted(reasons)), oid))
                self._journal_order(oid)

    # Batch entry and issuance

    def order(self, oid):
        row = self.db.execute("select * from orders where oid = ?", (oid,)).fetchone()
        if row is None:
            raise Refused("no such order")
        return row

    def batch_entry_ok(self, oid):
        o = self.order(oid)
        return (o["status"] == "converted"
                and "issuance" not in json.loads(o["reasons"])
                and self.sum_at(o, BATCHABLE) >= o["price_reserve"])

    def issuing_recheck_ok(self, oid):
        o = self.order(oid)
        return o["status"] == "issuing" and self.sum_at(o, BATCHABLE) >= o["price_reserve"]

    def converted_orders(self):
        self.observe()
        return [r["oid"] for r in self.db.execute(
            "select oid from orders where status = 'converted' order by oid")]

    def mark_issuing(self, oids):
        """One serialized transaction: every member passes batch entry and
        becomes `issuing`, or nothing changes. Returns the members whose marks
        reached the off-host journal."""
        with self.lock:
            self.observe()
            self.db.execute("begin immediate")
            try:
                for oid in oids:
                    if not self.batch_entry_ok(oid):
                        raise Refused(f"{oid} fails batch entry")
                    self.db.execute("update orders set status = 'issuing' where oid = ?", (oid,))
                self.db.execute("commit")
            except Exception:
                self.db.execute("rollback")
                raise
            return [oid for oid in oids if self.journal_ok(oid)]

    def set_status(self, oid, status, expect):
        with self.lock:
            o = self.order(oid)
            if o["status"] not in expect:
                raise Refused(f"{oid} is {o['status']}, not {expect}")
            self.db.execute("update orders set status = ? where oid = ?", (status, oid))
            self.journal_ok(oid)

    def unissue(self, oid):
        self.set_status(oid, "converted", ("issuing",))

    def mark_ready(self, oid):
        self.set_status(oid, "ready", ("issuing",))

    def mark_fulfilled(self, oid):
        """Only after the handle's delivery is confirmed by a verified lookup
        (publication.py)."""
        self.set_status(oid, "fulfilled", ("ready",))

    def unready(self, oid):
        self.set_status(oid, "issuing", ("ready",))

    def restore_issuing(self, oid):
        self.set_status(oid, "issuing", ("converted",))

    def cancel(self, oid):
        with self.lock:
            self.observe()
            o = self.order(oid)
            if o["status"] in ISSUED:
                raise Refused("not cancellable once issuing")
            self.db.execute("begin immediate")
            self.db.execute("update names set hold_order = null where hold_order = ?", (oid,))
            self.db.execute("update names set fulfillment_order = null where fulfillment_order = ?", (oid,))
            self.db.execute("update orders set status = 'cancelled', price_reserve = 0 where oid = ?", (oid,))
            self.db.execute("commit")
            self._journal_order(oid)

    # The frozen batch, as served to subs

    def set_pending(self, members):
        with self.lock:
            self.db.execute("delete from pending")
            for oid in members:
                o = self.order(oid)
                self.db.execute("insert into pending values (?, ?)", (o["name"], o["recipient_spk"]))

    def pending_for(self, space):
        return [{"handle": r["handle"], "script_pubkey": r["script_pubkey"]}
                for r in self.db.execute("select * from pending order by handle")
                if r["handle"].endswith(space)]

    def ack(self, entries):
        with self.lock:
            for e in entries:
                self.db.execute("update orders set acked = ? where name = ?", (e["outcome"], e["handle"]))

    def committed(self, root, handles):
        with self.lock:
            for h in handles:
                self.db.execute("insert or replace into committed values (?, ?)", (h, root))

    # Restore

    def restore_from_journal(self):
        """Rebuild names and orders from the store's off-host journal alone."""
        with self.lock:
            self.db.executescript("delete from names; delete from orders; delete from pending;")
            orders = {}
            for e in self.journal.entries():
                if e["kind"] == "name":
                    self.db.execute("insert or replace into names(name, price) values (?, ?)",
                                    (e["name"], e["price"]))
                elif e["kind"] == "order":
                    orders[e["order"]["oid"]] = e["order"]
            for row in orders.values():
                cols = ", ".join(row)
                marks = ", ".join("?" for _ in row)
                self.db.execute(f"insert into orders({cols}) values ({marks})", tuple(row.values()))
                if row["status"] == "quoted":
                    self.db.execute("update names set hold_order = ? where name = ?", (row["oid"], row["name"]))
                elif row["status"] in ("converted",) + ISSUED:
                    self.db.execute("update names set fulfillment_order = ? where name = ?",
                                    (row["oid"], row["name"]))
            self.n = self._count_orders()

    # HTTP

    def serve(self, port):
        registry = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                pass

            def _send(self, code, obj):
                out = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

            def _authed(self):
                return self.headers.get("Authorization") == f"Bearer {registry.token}"

            def _body(self):
                n = int(self.headers.get("Content-Length") or 0)
                return json.loads(self.rfile.read(n) or b"{}")

            def do_GET(self):
                url = urlparse(self.path)
                if url.path in ("/health", "/pending") and not self._authed():
                    return self._send(401, {"error": "unauthorized"})
                if url.path == "/health":
                    return self._send(200, {"ok": True})
                if url.path == "/pending":
                    space = parse_qs(url.query).get("space", [""])[0]
                    return self._send(200, {"handles": registry.pending_for(space)})
                m = re.match(r"^/orders/(o\d+)$", url.path)
                if m:
                    try:
                        registry.observe()
                        o = dict(registry.order(m.group(1)))
                        return self._send(200, {k: o[k] for k in ("oid", "name", "status", "price",
                                                                   "pay_address", "reasons")})
                    except Refused as e:
                        return self._send(404, {"error": str(e)})
                return self._send(404, {"error": "not found"})

            def do_POST(self):
                url = urlparse(self.path)
                if url.path in ("/ack", "/committed"):
                    if not self._authed():
                        return self._send(401, {"error": "unauthorized"})
                    body = self._body()
                    if url.path == "/ack":
                        registry.ack(body.get("handles", []))
                    else:
                        registry.committed(body.get("root"), body.get("handles", []))
                    return self._send(200, {"ok": True})
                try:
                    if url.path == "/requests":
                        body = self._body()
                        oid = registry.request(body.get("handle", ""), body.get("script_pubkey", ""))
                        return self._send(201, {"oid": oid})
                    m = re.match(r"^/orders/(o\d+)/quote$", url.path)
                    if m:
                        return self._send(200, registry.quote(m.group(1)))
                except Refused as e:
                    return self._send(409, {"error": str(e)})
                return self._send(404, {"error": "not found"})

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def shutdown(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.server = None
