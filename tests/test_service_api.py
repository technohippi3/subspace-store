"""The service's HTTP API over a simulated chain: no-account checkout, the
boundaries between buyers, the operator and subs, and a process restart.

The chain is the model's simulated chain, so this tests the service's own
code paths, not Bitcoin Core: refund building and real transactions are on
regtest (regtest/harness/service.py). It is neither model nor regtest
evidence about the store's rules.

The `test_V*` tests are the recipient-request cases V1 to V16 of
PAYMENT-SPEC.md, and the `test_H*` tests are its service restore cases H1
to H6. The model has neither recipient requests nor the service's database,
so these are service API results, not model results.
"""

import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from model.chain import Chain, Tx
from service.app import Service
from service.journal import Journal
from service.ledger import (Ledger, Policy, RestoreRefused, RestoreRequired,
                            restore_from_journal, valid_p2tr)
from tests.service_twin import ModelChainView, recipient

SPK = "5120" + "ab" * 32
SPK2 = "5120" + "ee" * 32
# A harmless placeholder: never a real key, in tests or anywhere else.
PLACEHOLDER = "placeholder-not-a-key-7f3e"
# Restores the test's journal, and exits like a killed process after the
# first record is written.
KILLED_RESTORE = """
import os, sys
from pathlib import Path
import service.ledger as ledger
from service.journal import Journal
insert = ledger._insert
def die_after_first(*args):
    insert(*args)
    os._exit(9)
ledger._insert = die_after_first
ledger.restore_from_journal(Path(sys.argv[1]) / "restored.db", Journal(Path(sys.argv[1]) / "offhost"))
"""
OPERATOR, SUBS = "operator-token-" + "x" * 24, "subs-token-" + "y" * 24


class Client:
    def __init__(self, port):
        self.base = f"http://127.0.0.1:{port}"

    def call(self, method, path, body=None, token=None, raw=None):
        data = raw if raw is not None else None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())


class Api(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.chain = Chain()
        self.view = ModelChainView(self.chain)
        self.n = 0
        self.view.new_destination = self._destination
        self.now = [0.0]
        self.service = None
        self.start()

    def _destination(self, oid):
        self.n += 1
        return f"dest-{self.n}", recipient(f"dest-{self.n}")

    def start(self):
        ledger = Ledger(self.dir / "store.db", self.view, Journal(self.dir / "offhost"),
                        Policy(), clock=lambda: self.now[0])
        self.service = Service(ledger, self.view, OPERATOR, SUBS, 1_000_000, poll_seconds=3600)
        self.service.start()
        self.service.serve("127.0.0.1", 0)
        self.c = Client(self.service.server.server_address[1])

    def stop(self):
        self.service.shutdown()
        self.service.ledger.close()

    def tearDown(self):
        self.stop()

    def op(self, method, path, body=None):
        return self.c.call(method, path, body, OPERATOR)

    def pay(self, script, value, n=3):
        self.n += 1
        self.chain.add(Tx(f"pay{self.n}", ((f"coin{self.n}", 0),), ((script, value),)))
        for _ in range(n):
            self.chain.mine()

    def test_no_account_checkout_through_the_order_link(self):
        self.assertEqual(self.op("POST", "/operator/names", {"handle": "one@space", "price": 10_000})[0], 200)
        code, r = self.c.call("POST", "/requests", {"handle": "one@space", "script_pubkey": SPK})
        self.assertEqual(code, 201)
        link = r["order_link"]
        # The token isn't stored in the clear.
        row = self.service.ledger.db.execute("select * from orders").fetchone()
        self.assertNotIn(r["token"], json.dumps(dict(row)))
        code, q = self.c.call("POST", link + "/quote")
        self.assertEqual((code, q["price_sats"]), (200, 10_000))
        # A second buyer gets "taken for now".
        _, r2 = self.c.call("POST", "/requests", {"handle": "one@space", "script_pubkey": SPK2})
        self.assertEqual(self.c.call("POST", r2["order_link"] + "/quote"),
                         (409, {"error": "taken for now"}))
        script = self.service.ledger.operator_view("o1")["dest_script"]
        self.pay(script, 10_000)
        code, view = self.c.call("GET", link)
        self.assertEqual((code, view["status"]), (200, "converted"))
        self.assertEqual(view["handle"], "one@space")
        # An unknown or guessed link shows nothing.
        self.assertEqual(self.c.call("GET", "/orders/" + "A" * 32)[0], 404)
        self.assertEqual(self.c.call("GET", "/orders/o1")[0], 404)

        # A process restart: the same link, the same state.
        self.stop()
        self.start()
        code, view = self.c.call("GET", link)
        self.assertEqual((code, view["status"], view["batchable_sats"]), (200, "converted", 10_000))
        self.assertFalse(self.c.call("GET", "/names/one@space")[1]["available"])

    # Recipient requests (PAYMENT-SPEC.md, V1 to V7, V10, V11)

    def list(self, *handles):
        for h in handles:
            self.assertEqual(self.op("POST", "/operator/names", {"handle": h, "price": 10_000})[0], 200)

    def req(self, handle, script, **extra):
        return self.c.call("POST", "/requests", {"handle": handle, "script_pubkey": script, **extra})

    def state(self):
        """Everything a request could create or change: orders, holds,
        alerts, journal entries and the journal backlog."""
        led = self.service.ledger
        db = led.db
        return (db.execute("select count(*) from orders").fetchone()[0],
                db.execute("select count(*) from alerts").fetchone()[0],
                [tuple(r) for r in db.execute("select name, hold_order, fulfillment_order from names order by name")],
                len(led.journal.entries()),
                db.execute("select count(*) from journal_backlog").fetchone()[0])

    def assertNothingCreated(self, before, code, out, expected_code):
        self.assertEqual(code, expected_code, out)
        self.assertNotIn("token", out)
        self.assertNotIn("order_link", out)
        self.assertEqual(self.state(), before)

    def test_V1_a_canonical_request_creates_an_order_and_claims_nothing(self):
        self.list("one@xn--gg8h")
        code, r = self.req("one@xn--gg8h", SPK)
        self.assertEqual(code, 201)
        self.assertEqual(r["order_link"], "/orders/" + r["token"])
        self.assertEqual(self.c.call("GET", r["order_link"])[1]["handle"], "one@xn--gg8h")
        self.assertFalse(self.service.ledger.claimed_elsewhere("two@xn--gg8h", SPK))

    def test_V2_a_secret_bearing_field_refuses_the_whole_request(self):
        self.list("one@space")
        before = self.state()
        code, out = self.req("one@space", SPK, dev_private_key=PLACEHOLDER)
        self.assertNothingCreated(before, code, out, 400)
        self.assertNotIn(PLACEHOLDER, json.dumps(out))
        self.assertNotIn("dev_private_key", json.dumps(out))
        self.service.ledger.db.execute("pragma wal_checkpoint(full)")
        for f in self.dir.rglob("*"):
            if f.is_file():
                self.assertNotIn(PLACEHOLDER.encode(), f.read_bytes(), f)

    def test_V3_any_other_shape_is_malformed(self):
        self.list("one@space", "two@space")
        before = self.state()
        bodies = [
            {"handle": "one@space", "script_pubkey": SPK, "note": "x"},
            {"handle": "one@space", "script_pubkey": SPK, "signature": ""},
            {"handle": "one@space"},
            {"script_pubkey": SPK},
            {},
            {"handle": 123, "script_pubkey": SPK},
            {"handle": "one@space", "script_pubkey": [SPK]},
            {"handle": None, "script_pubkey": SPK},
        ]
        for body in bodies:
            with self.subTest(body=body):
                code, out = self.c.call("POST", "/requests", body)
                self.assertNothingCreated(before, code, out, 400)
        repeated = ('{"handle": "one@space", "handle": "two@space", "script_pubkey": "%s"}' % SPK).encode()
        for raw in (repeated, b"[]", b"not json"):
            with self.subTest(raw=raw):
                code, out = self.c.call("POST", "/requests", raw=raw)
                self.assertNothingCreated(before, code, out, 400)

    def test_V4_a_non_canonical_handle_is_refused_never_corrected(self):
        self.list("one@space")
        before = self.state()
        for handle in ("One@space", "ONE@SPACE", " one@space", "one@space ", "one@space\n",
                       "-one@space", "one-@space", "one@-space", "one@space-", "@one@space",
                       "one@@space", "one@space@x", "onespace", "öne@space", "one@spаce", ""):
            with self.subTest(handle=handle):
                code, out = self.req(handle, SPK)
                self.assertNothingCreated(before, code, out, 400)

    def test_V5_an_unlisted_canonical_handle_is_not_for_sale(self):
        self.list("one@space")
        before = self.state()
        code, out = self.req("two@space", SPK)
        self.assertNothingCreated(before, code, out, 404)
        self.assertEqual(out, {"error": "not for sale"})

    def test_V6_only_a_34_byte_p2tr_script_is_accepted(self):
        self.list("one@space")
        before = self.state()
        for script in ("0014" + "ab" * 20,           # P2WPKH
                       "0020" + "ab" * 32,           # P2WSH, also 34 bytes
                       "6a04deadbeef",               # OP_RETURN
                       "5120" + "ab" * 31,           # 33 bytes
                       "5120" + "ab" * 33,           # 35 bytes
                       "5220" + "ab" * 32,           # witness version 2
                       "5120" + "AB" * 32,           # uppercase hex
                       SPK + "\n", " " + SPK, ""):
            with self.subTest(script=script):
                code, out = self.req("one@space", script)
                self.assertNothingCreated(before, code, out, 400)

    def test_V7_a_p2tr_key_off_the_curve_is_refused(self):
        # BIP340 test vectors: vector 0's key is valid, vector 5's isn't on
        # the curve, and vector 14's exceeds the field size.
        self.assertTrue(valid_p2tr("5120f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"))
        off_curve = ["5120eefdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34",
                     "5120fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc30",
                     "5120" + "ff" * 32, "5120" + "cd" * 32]
        self.list("one@space")
        before = self.state()
        for script in off_curve:
            with self.subTest(script=script):
                self.assertFalse(valid_p2tr(script))
                code, out = self.req("one@space", script)
                self.assertNothingCreated(before, code, out, 400)

    # Claims, conflicts and stored orders (V8, V9, V12 to V16)

    def order(self, handle, script, quote=True):
        _, r = self.req(handle, script)
        oid = self.service.ledger.order_by_token(r["token"])
        if quote:
            self.assertEqual(self.c.call("POST", r["order_link"] + "/quote")[0], 200)
        return oid, r["order_link"]

    def convert(self, oid):
        self.pay(self.service.ledger.operator_view(oid)["dest_script"], 10_000)
        self.op("POST", "/operator/observe")
        self.assertEqual(self.service.ledger.operator_view(oid)["status"], "converted")

    def entry(self, oid):
        return self.op("POST", f"/operator/orders/{oid}/batch-entry")[1]

    def alerts(self, kind):
        return sorted(a["oid"] for a in self.op("GET", "/operator/alerts")[1]["alerts"]
                      if a["kind"] == kind)

    def rows(self):
        db = self.service.ledger.db
        return [{k: r[k] for k in r.keys() if k != "recipient_problem"}
                for r in db.execute("select * from orders order by seq")]

    def rewrite_stored(self, *statements):
        """Leave rows as an older version could have, with the service
        stopped, and without the audit column."""
        self.stop()
        db = sqlite3.connect(self.dir / "store.db")
        for sql, args in statements:
            db.execute(sql, args)
        db.execute("alter table orders drop column recipient_problem")
        db.commit()
        db.close()
        self.start()

    def test_V8_a_paid_order_claims_its_script(self):
        self.list("one@space", "two@space", "three@space")
        early, early_link = self.order("three@space", SPK, quote=False)
        o1, _ = self.order("one@space", SPK)
        self.convert(o1)
        before = self.state()
        code, out = self.req("two@space", SPK)
        self.assertNothingCreated(before, code, out, 409)
        self.assertEqual(out, {"error": "script already used"})
        # An order made before the claim gets no payment instructions either.
        self.assertEqual(self.c.call("POST", early_link + "/quote"), (409, {"error": "script already used"}))
        self.assertEqual(self.service.ledger.operator_view(early)["status"], "requested")

    def test_V9_an_unpaid_request_or_quote_claims_nothing(self):
        # Someone who has seen the buyer's public script submits it first,
        # for another handle, and even quotes it. The buyer isn't blocked.
        self.list("one@space", "two@space", "three@space")
        self.order("two@space", SPK)                     # quoted, hold active, unpaid
        self.order("three@space", SPK, quote=False)      # requested only
        o1, _ = self.order("one@space", SPK)
        self.convert(o1)
        self.assertTrue(self.entry(o1)["batch_entry"])

    def test_V10_a_retry_gets_a_new_order_and_never_an_old_link(self):
        self.list("one@space")
        _, first = self.req("one@space", SPK)
        self.c.call("POST", first["order_link"] + "/quote")
        code, again = self.req("one@space", SPK)
        self.assertEqual(code, 201)
        self.assertNotEqual(again["token"], first["token"])
        self.assertNotIn(first["token"], json.dumps(again))
        self.assertEqual(self.c.call("GET", first["order_link"])[1]["status"], "quoted")
        self.assertEqual(self.c.call("GET", again["order_link"])[1]["status"], "requested")

    def test_V11_a_store_destination_script_is_never_a_recipient(self):
        self.list("one@space", "two@space")
        _, r = self.req("one@space", SPK)
        self.c.call("POST", r["order_link"] + "/quote")
        dest = self.service.ledger.operator_view("o1")["dest_script"]
        self.assertTrue(valid_p2tr(dest))
        before = self.state()
        code, out = self.req("two@space", dest)
        self.assertNothingCreated(before, code, out, 409)
        self.assertEqual(out, {"error": "script already used"})

    def test_V12_two_paid_orders_on_one_script_both_wait_for_the_owner(self):
        self.list("one@space", "two@space")
        o1, _ = self.order("one@space", SPK)
        o2, _ = self.order("two@space", SPK)
        self.convert(o1)
        self.assertEqual(self.op("POST", "/operator/pending", {"oids": [o1]})[0], 200)
        self.convert(o2)
        # Frozen before the conflict arose: subs is no longer served it.
        self.assertEqual(self.c.call("GET", "/pending?space=@space", token=SUBS), (200, {"handles": []}))
        self.assertEqual(self.entry(o1), {"batch_entry": False, "issuing_recheck": False})
        self.assertFalse(self.entry(o2)["batch_entry"])
        self.assertEqual(self.op("POST", "/operator/issuing", {"oids": [o1]})[0], 409)
        self.assertEqual(self.op("POST", "/operator/pending", {"oids": [o2]})[0], 409)
        self.assertEqual(self.alerts("recipient_conflict"), [o1, o2])
        self.op("POST", "/operator/observe")
        self.assertEqual(self.alerts("recipient_conflict"), [o1, o2])   # once each
        # Cancelling one releases the other.
        self.assertEqual(self.op("POST", f"/operator/orders/{o2}/cancel")[0], 200)
        self.assertTrue(self.entry(o1)["batch_entry"])

    def test_V13_an_order_already_issuing_keeps_its_script(self):
        self.list("one@space", "two@space")
        o1, _ = self.order("one@space", SPK)
        o2, _ = self.order("two@space", SPK)
        self.convert(o1)
        self.assertEqual(self.op("POST", "/operator/issuing", {"oids": [o1]})[0], 200)
        self.convert(o2)
        self.assertTrue(self.entry(o1)["issuing_recheck"])
        self.assertFalse(self.entry(o2)["batch_entry"])
        self.assertEqual(self.alerts("recipient_conflict"), [o2])

    def test_V14_a_claim_ends_with_cancellation_and_never_after_fulfillment(self):
        self.list("one@space", "two@space", "three@space", "four@space")
        s = recipient("v14")
        o1, _ = self.order("one@space", s)
        self.convert(o1)
        self.assertEqual(self.req("two@space", s)[0], 409)
        self.assertEqual(self.op("POST", f"/operator/orders/{o1}/cancel")[1]["status"], "cancelled")
        self.assertEqual(self.req("two@space", s)[0], 201)   # released
        o3, _ = self.order("three@space", SPK)
        self.convert(o3)
        self.assertEqual(self.op("POST", "/operator/issuing", {"oids": [o3]})[0], 200)
        for action in ("mark_ready", "mark_fulfilled"):
            self.assertEqual(self.op("POST", f"/operator/orders/{o3}/transition",
                                     {"action": action})[0], 200)
        self.stop()
        self.start()
        before = self.state()
        code, out = self.req("four@space", SPK)
        self.assertNothingCreated(before, code, out, 409)

    def test_V15_stored_orders_with_an_unsafe_recipient_are_blocked_at_startup(self):
        self.list("one@space", "two@space", "three@space", "four@space", "five@space")
        o1, _ = self.order("one@space", SPK)
        self.convert(o1)
        self.assertEqual(self.op("POST", "/operator/pending", {"oids": [o1]})[0], 200)
        o5, _ = self.order("five@space", recipient("v15-e"))
        self.convert(o5)
        self.assertEqual(self.op("POST", "/operator/issuing", {"oids": [o5]})[0], 200)
        self.assertTrue(self.entry(o5)["issuing_recheck"])
        o2, link2 = self.order("two@space", recipient("v15-b"), quote=False)
        o3, _ = self.order("three@space", recipient("v15-c"))
        dest = self.service.ledger.operator_view(o3)["dest_script"]
        self.op("POST", f"/operator/orders/{o3}/cancel")
        o4, link4 = self.order("four@space", recipient("v15-d"), quote=False)
        self.rewrite_stored(
            ("update orders set recipient_spk = '6a04deadbeef' where oid in (?, ?, ?)", (o1, o2, o5)),
            ("update pending set script_pubkey = '6a04deadbeef'", ()),
            ("update orders set recipient_spk = ? where oid = ?", (dest, o4)))
        stored = self.rows()
        self.assertEqual(self.alerts("recipient_invalid"), sorted([o1, o2, o4, o5]))
        # No payment instructions for an unquoted one.
        for link in (link2, link4):
            self.assertEqual(self.c.call("POST", link + "/quote"), (409, {"error": "recipient not accepted"}))
        # The converted one never reaches issuance or subs.
        self.assertEqual(self.entry(o1), {"batch_entry": False, "issuing_recheck": False})
        self.assertEqual(self.op("POST", "/operator/issuing", {"oids": [o1]})[0], 409)
        self.assertEqual(self.op("POST", "/operator/pending", {"oids": [o1]})[0], 409)
        self.assertEqual(self.c.call("GET", "/pending?space=@space", token=SUBS), (200, {"handles": []}))
        # The one already issuing fails its recheck before any transmission.
        self.assertEqual(self.service.ledger.operator_view(o5)["status"], "issuing")
        self.assertEqual(self.entry(o5), {"batch_entry": False, "issuing_recheck": False})
        # Records are kept as they were, and a second start alerts nothing new.
        self.assertEqual(self.rows(), stored)
        self.stop()
        self.start()
        self.assertEqual(self.alerts("recipient_invalid"), sorted([o1, o2, o4, o5]))
        self.assertEqual(self.rows(), stored)

    def test_V16_a_stored_conflict_is_alerted_and_blocks_both(self):
        self.list("one@space", "two@space")
        o1, _ = self.order("one@space", SPK)
        o2, _ = self.order("two@space", SPK2)
        self.convert(o1)
        self.convert(o2)
        self.rewrite_stored(("update orders set recipient_spk = ? where oid = ?", (SPK, o2)))
        stored = self.rows()
        self.assertEqual(self.alerts("recipient_conflict"), [o1, o2])
        self.assertFalse(self.entry(o1)["batch_entry"])
        self.assertFalse(self.entry(o2)["batch_entry"])
        self.assertEqual(self.rows(), stored)

    # Host loss and restore from the journal alone (H1 to H6)

    def lose_host(self):
        """The host and its database are gone; the off-host journal stays."""
        self.stop()
        for f in self.dir.glob("store.db*"):
            f.unlink()

    def restore(self):
        return restore_from_journal(self.dir / "store.db", Journal(self.dir / "offhost"))

    def table(self, name):
        return [dict(r) for r in self.service.ledger.db.execute(f"select * from {name} order by 1")]

    def durable(self):
        return {t: self.table(t) for t in ("names", "orders", "groups", "attempts", "alerts",
                                           "authorizations")}

    def paid(self, handle, script, settled=False):
        """An order paid in full; settled if asked. Returns (oid, link)."""
        oid, link = self.order(handle, script)
        self.pay(self.service.ledger.operator_view(oid)["dest_script"], 10_000,
                 n=6 if settled else 3)
        self.op("POST", "/operator/observe")
        return oid, link

    def refund_group(self, gid, oid, link, txid):
        """A cancellation and its hot-wallet refund group, through the
        ledger: the simulated chain has no wallet to sign with."""
        self.assertEqual(self.c.call("POST", link + "/refund-address", {"address": "bcrt1-" + oid})[0], 200)
        self.assertEqual(self.op("POST", f"/operator/orders/{oid}/cancel")[0], 200)
        led = self.service.ledger
        payment = led.outputs(oid)[0]["outpoint"]
        tx = {"txid": txid, "inputs": [tuple(payment)],
              "outputs": [(led.operator_view(oid)["refund_spk"], 9_700)],
              "raw": "02" + txid.encode().hex()}
        led.open_group(gid, oid, "cancellation", tx, 9_700, 300)
        return tx

    def recording_sends(self):
        sent, send = [], self.view.send

        def record(tx):
            sent.append(dict(tx))
            return send(tx)
        self.view.send = record
        return sent

    def test_H1_a_lost_database_is_restored_from_the_journal_alone(self):
        self.list("one@space", "two@space")
        o1, link1 = self.paid("one@space", SPK)
        self.assertEqual(self.c.call("POST", link1 + "/refund-address", {"address": "bcrt1-one"})[0], 200)
        o2, link2 = self.paid("two@space", SPK2, settled=True)
        self.refund_group("g1", o2, link2, "refund-h1")
        self.c.call("POST", "/ack", {"handles": [{"handle": "one@space",
                                                  "outcome": "already_staged_different_spk"}]}, SUBS)
        self.assertEqual(self.service.ledger.db.execute(
            "select count(*) from journal_backlog").fetchone()[0], 0)
        before = self.durable()
        self.assertTrue(before["alerts"] and before["authorizations"] and before["attempts"])
        self.assertTrue(all(a["journaled"] for a in before["attempts"]))
        views = {oid: self.service.ledger.operator_view(oid) for oid in (o1, o2)}
        self.lose_host()
        self.restore()
        self.start()
        self.assertEqual(self.durable(), before)
        for oid, link in ((o1, link1), (o2, link2)):
            self.assertEqual(self.c.call("GET", link)[1]["status"], views[oid]["status"])
            v = self.service.ledger.operator_view(oid)
            for k in ("sums", "available", "reserved", "refunded_total"):
                self.assertEqual(v[k], views[oid][k], (oid, k))

    def test_H2_a_host_loss_undoes_only_what_was_never_acknowledged(self):
        self.list("one@space", "two@space", "three@space")
        o3, link3 = self.paid("three@space", recipient("h2-c"), settled=True)
        self.assertEqual(self.c.call("POST", link3 + "/refund-address", {"address": "bcrt1-3"})[0], 200)
        self.assertEqual(self.op("POST", f"/operator/orders/{o3}/cancel")[0], 200)
        o1, _ = self.order("one@space", SPK)
        o2, _ = self.paid("two@space", SPK2)
        sent = self.recording_sends()
        journal = self.service.ledger.journal
        journal.set_available(False)
        # While the journal is down: a payment, a cancellation, a refund group.
        self.pay(self.service.ledger.operator_view(o1)["dest_script"], 10_000)
        self.op("POST", "/operator/observe")
        self.assertEqual(self.service.ledger.operator_view(o1)["status"], "converted")
        self.assertEqual(self.op("POST", f"/operator/orders/{o2}/cancel")[0], 200)
        led = self.service.ledger
        payment = led.outputs(o3)[0]["outpoint"]
        led.open_group("g1", o3, "cancellation",
                       {"txid": "refund-h2", "inputs": [tuple(payment)],
                        "outputs": [(led.operator_view(o3)["refund_spk"], 9_700)], "raw": "02ab"},
                       9_700, 300)
        self.assertEqual(self.op("POST", "/operator/refunds/g1/broadcast")[0], 409)
        self.lose_host()
        journal.set_available(True)
        self.restore()
        self.start()
        led = self.service.ledger
        self.assertEqual(led.operator_view(o1)["status"], "converted")
        self.assertEqual(led.operator_view(o2)["status"], "converted")
        self.assertEqual(led._name("two@space")["fulfillment_order"], o2)
        self.assertEqual(led.operator_view(o3)["status"], "cancelled")
        self.assertEqual(self.table("groups"), [])
        self.assertEqual(sent, [])

    def test_H3_no_empty_start_over_an_existing_journal(self):
        self.list("one@space")
        self.order("one@space", SPK)
        self.lose_host()
        with self.assertRaises(RestoreRequired):
            self.start()
        self.assertEqual(list(self.dir.glob("store.db*")), [])
        # A database with the schema but no names and no orders is empty too.
        empty = self.dir / "store.db"
        Ledger(empty, self.view, Journal(self.dir / "elsewhere"), Policy()).close()
        image = empty.read_bytes()
        with self.assertRaises(RestoreRequired):
            self.start()
        self.assertEqual(empty.read_bytes(), image)
        self.assertEqual(sorted(f.name for f in self.dir.glob("store.db*")), ["store.db"])
        empty.unlink()
        self.restore()
        self.start()

    def test_H4_a_restore_never_overwrites_a_database(self):
        self.list("one@space")
        self.order("one@space", SPK)
        self.stop()
        image = (self.dir / "store.db").read_bytes()
        with self.assertRaises(RestoreRefused):
            self.restore()
        self.assertEqual((self.dir / "store.db").read_bytes(), image)
        self.start()

    def test_H5_an_inconsistent_journal_is_refused(self):
        self.list("one@space")
        o1, _ = self.order("one@space", SPK)
        led = self.service.ledger
        name = led._snapshot("name", "one@space")
        order = led._snapshot("order", o1)
        group = {"gid": "g1", "oid": "o9", "kind": "excess", "closed_by": None, "seq": 1,
                 "needs_rebuild": 0, "paused": 0, "attempts": []}
        bad = {
            "empty journal": [],
            "unknown kind": [{"kind": "bogus", "key": "x", "state": {}}],
            "unknown field": [{"kind": "name", "key": "one@space", "state": dict(name, colour="red")}],
            "no link hash": [{"kind": "name", "key": "one@space", "state": name},
                             {"kind": "order", "key": o1,
                              "state": {k: v for k, v in order.items() if k != "token_hash"}}],
            "order without its name": [{"kind": "order", "key": o1, "state": order}],
            "group without its order": [{"kind": "name", "key": "one@space", "state": name},
                                        {"kind": "order", "key": o1, "state": order},
                                        {"kind": "group", "key": "g1", "state": group}],
        }
        for what, records in bad.items():
            with self.subTest(what):
                d = self.dir / what.replace(" ", "-")
                if records:
                    Journal(d / "offhost").append("state", records=records)
                with self.assertRaises(RestoreRefused) as e:
                    restore_from_journal(d / "store.db", Journal(d / "offhost"))
                key = (o1 if what == "order without its name" else
                       records[-1]["key"] if records else "no records")
                self.assertIn(key, str(e.exception))
                self.assertEqual([f.name for f in d.iterdir()], ["offhost"])
        # A restore killed partway leaves no database at the target, so no
        # start can take a partial store for a whole one.
        self.stop()
        killed = subprocess.run([sys.executable, "-c", KILLED_RESTORE, str(self.dir)],
                                cwd=Path(__file__).resolve().parent.parent)
        self.assertEqual(killed.returncode, 9)
        self.assertFalse((self.dir / "restored.db").exists())
        restore_from_journal(self.dir / "restored.db", Journal(self.dir / "offhost"))
        self.assertEqual(sorted(f.name for f in self.dir.glob("restored.db*")), ["restored.db"])
        self.start()

    def test_H6_a_restored_service_reconciles_refunds_before_serving(self):
        self.list("one@space", "two@space")
        o1, link1 = self.paid("one@space", SPK, settled=True)
        o2, link2 = self.paid("two@space", SPK2, settled=True)
        a = self.refund_group("g1", o1, link1, "refund-h6a")
        b = self.refund_group("g2", o2, link2, "refund-h6b")
        sent = self.recording_sends()
        led = self.service.ledger
        led.broadcast("g1", a["txid"])
        self.chain.add(Tx(a["txid"], tuple(a["inputs"]), tuple(a["outputs"])))
        self.chain.mine()
        self.view.send_mode = "lost"
        led.broadcast("g2", b["txid"])
        self.view.send_mode = "ok"
        self.op("POST", "/operator/observe")
        before = {oid: {k: led.operator_view(oid)[k] for k in ("reserved", "refunded_total", "available")}
                  for oid in (o1, o2)}
        del sent[:]
        self.lose_host()
        self.restore()
        self.start()
        self.assertEqual(self.service.startup["rebroadcast"], [b["txid"]])
        self.assertEqual([(t["txid"], t["raw"]) for t in sent], [(b["txid"], b["raw"])])
        led = self.service.ledger
        self.assertTrue(led._attempt(a["txid"])["acknowledged"])
        for oid in (o1, o2):
            self.assertEqual({k: led.operator_view(oid)[k] for k in before[oid]}, before[oid])


if __name__ == "__main__":
    unittest.main()
