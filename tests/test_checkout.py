"""The buyer's checkout pages over a simulated chain (PAYMENT-SPEC.md,
"Checkout and the attended runner").

The `test_C*` tests are the checkout cases C1 to C12. They exercise the
service's own pages and code paths over the model's simulated chain, so
they are service API results: neither model results nor regtest evidence.
The regtest demonstration is scenario 10 (`regtest/run-checkout.sh`).
"""

import http.client
import json
import sqlite3
import re
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlencode

from model.chain import Chain, Tx
from service.app import Service
from service.journal import Journal, JournalDown
from service.ledger import Ledger, Policy, restore_from_journal
from tests.service_twin import ModelChainView, recipient

SPK = "5120" + "ab" * 32
SPK2 = "5120" + "ee" * 32
PLACEHOLDER = "placeholder-not-a-key-7f3e"
OPERATOR, SUBS = "operator-token-" + "x" * 24, "subs-token-" + "y" * 24
CERT = b"\x00certificate message bytes, made up for the test\xff"
ROOT = Path(__file__).resolve().parent.parent
# A later batch's certificate message from kept regtest evidence, verified
# there with libveritas: it carries a proof, so it is far over MAX_BODY.
LATER_BATCH_CERT = (ROOT / "regtest/evidence/combined-20261107T113909Z-345992/017-b7/"
                    "five@test10000.message.bin")


class Page:
    def __init__(self, status, headers, body):
        self.status, self.headers, self.body = status, headers, body

    @property
    def text(self):
        return self.body.decode()

    def find(self, element_id):
        m = re.search(rf'id="{element_id}"[^>]*>([^<]*)<', self.text)
        return m.group(1) if m else None


class Checkout(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.chain = Chain()
        self.view = ModelChainView(self.chain)
        self.n = 0
        self.view.new_destination = self._destination
        self.view.refund_script = lambda address: recipient("refund/" + address)
        self.now = [0.0]
        self.journal = Journal(self.dir / "offhost")
        self._open()
        self.addCleanup(lambda: self.service.ledger.close())
        self.addCleanup(lambda: self.service.shutdown())

    def _open(self):
        ledger = Ledger(self.dir / "store.db", self.view, self.journal, Policy(),
                        clock=lambda: self.now[0])
        self.service = Service(ledger, self.view, OPERATOR, SUBS, 1_000_000, poll_seconds=3600)
        self.service.start()
        self.service.serve("127.0.0.1", 0)
        self.port = self.service.server.server_address[1]
        self.led = self.service.ledger

    def stop(self):
        self.service.shutdown()
        self.led.close()

    def lose_host_and_restore(self):
        """The host and its database are gone; restore from the off-host
        journal alone and serve again."""
        self.stop()
        for f in self.dir.glob("store.db*"):
            f.unlink()
        self.journal.set_available(True)
        restore_from_journal(self.dir / "store.db", self.journal)
        self._open()

    def _destination(self, oid):
        self.n += 1
        return f"dest-{self.n}", recipient(f"dest-{self.n}")

    # HTTP, without following redirects

    def http(self, method, path, form=None, json_body=None, token=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers, body = {}, None
        if form is not None:
            body = urlencode(form).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        elif json_body is not None:
            body = json.dumps(json_body).encode()
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = "Bearer " + token
        conn.request(method, path, body=body, headers=headers)
        r = conn.getresponse()
        page = Page(r.status, {k.lower(): v for k, v in r.getheaders()}, r.read())
        conn.close()
        return page

    def op(self, method, path, body=None):
        p = self.http(method, path, json_body=body if body is not None else {}, token=OPERATOR)
        return p.status, json.loads(p.body)

    def list(self, *handles, price=10_000):
        for h in handles:
            self.assertEqual(self.op("POST", "/operator/names", {"handle": h, "price": price})[0], 200)

    def pay(self, script, value, n=3):
        self.n += 1
        self.chain.add(Tx(f"pay{self.n}", ((f"coin{self.n}", 0),), ((script, value),)))
        for _ in range(n):
            self.chain.mine()

    def buy(self, handle, script=SPK):
        """Paste a request on the name's page; return the order page path."""
        p = self.http("POST", f"/buy/{handle}",
                      form={"request": json.dumps({"handle": handle, "script_pubkey": script})})
        self.assertEqual(p.status, 303)
        return p.headers["location"]

    def counts(self):
        db = self.led.db
        return (db.execute("select count(*) from orders").fetchone()[0],
                [tuple(r) for r in db.execute("select name, hold_order from names order by name")],
                db.execute("select count(*) from alerts").fetchone()[0])

    def ready_order(self, handle="one@space"):
        self.list(handle)
        path = self.buy(handle)
        self.assertEqual(self.http("POST", path + "/invoice").status, 303)
        oid = self.led.order_by_token(path.rsplit("/", 1)[1])
        self.pay(self.led.operator_view(oid)["dest_script"], 10_000)
        self.op("POST", "/operator/observe")
        self.assertEqual(self.led.operator_view(oid)["status"], "converted")
        return oid, path

    def deliver(self, oid, message=CERT):
        import base64
        return self.op("POST", f"/operator/orders/{oid}/certificate",
                       {"message_b64": base64.b64encode(message).decode()})

    # Cases

    def test_C1_the_names_page_lists_prices_and_availability_and_no_orders(self):
        self.list("one@space")
        self.list("two@space", price=25_000)
        path = self.buy("two@space")
        self.assertEqual(self.http("POST", path + "/invoice").status, 303)
        p = self.http("GET", "/")
        self.assertEqual(p.status, 200)
        rows = dict(re.findall(r'data-handle="([^"]+)" data-available="(true|false)"', p.text))
        self.assertEqual(rows, {"one@space": "true", "two@space": "false"})
        self.assertIn("10,000 sats", p.text)
        self.assertIn("25,000 sats", p.text)
        self.assertIn('href="/buy/one@space"', p.text)
        self.assertNotIn('href="/buy/two@space"', p.text)
        token = path.rsplit("/", 1)[1]
        for secret in (token, "o1", SPK, "dest-1"):
            self.assertNotIn(secret, p.text)

    def test_C2_a_pasted_request_creates_an_order_and_redirects_to_its_page(self):
        self.list("one@space")
        before = self.counts()
        p = self.http("POST", "/buy/one@space",
                      form={"request": json.dumps({"handle": "one@space", "script_pubkey": SPK})})
        self.assertEqual(p.status, 303)
        m = re.fullmatch(r"/o/([A-Za-z0-9_-]{16,64})", p.headers["location"])
        self.assertIsNotNone(m)
        oid = self.led.order_by_token(m.group(1))
        o = self.led.operator_view(oid)
        self.assertEqual((o["name"], o["recipient_spk"], o["status"]),
                         ("one@space", SPK, "requested"))
        self.assertEqual(self.counts()[0], before[0] + 1)
        page = self.http("GET", p.headers["location"])
        self.assertEqual((page.status, page.find("status")), (200, "requested"))
        self.assertEqual(page.find("script"), SPK)

    def test_C3_a_refused_request_creates_nothing_and_is_never_echoed(self):
        self.list("one@space", "two@space")
        before = self.counts()
        bad = [
            json.dumps({"handle": "one@space", "script_pubkey": SPK,
                        "dev_private_key": PLACEHOLDER}),
            json.dumps({"handle": "one@space"}),
            '{"handle": "one@space", "handle": "one@space", "script_pubkey": "%s"}' % SPK,
            json.dumps({"handle": "ONE@space", "script_pubkey": SPK}),
            json.dumps({"handle": "one@space", "script_pubkey": "5120" + "00" * 32}),
            json.dumps({"handle": "one@space", "script_pubkey": "0014" + "ab" * 20}),
            json.dumps({"handle": "two@space", "script_pubkey": SPK}),
            "not json at all " + PLACEHOLDER,
            json.dumps([PLACEHOLDER]),
        ]
        for text in bad:
            with self.subTest(text=text[:40]):
                p = self.http("POST", "/buy/one@space", form={"request": text})
                self.assertEqual(p.status, 400)
                self.assertNotIn(PLACEHOLDER, p.text)
                self.assertNotIn("ab" * 32, p.text)
                self.assertNotIn("dev_private_key", p.text)
                self.assertNotIn("two@space", p.text)
                self.assertEqual(self.counts(), before)
        # A form with anything but the one field is refused too.
        p = self.http("POST", "/buy/one@space",
                      form={"request": json.dumps({"handle": "one@space", "script_pubkey": SPK}),
                            "dev_private_key": PLACEHOLDER})
        self.assertEqual(p.status, 400)
        self.assertNotIn(PLACEHOLDER, p.text)
        self.assertEqual(self.counts(), before)
        stored = json.dumps([list(r) for r in self.led.db.execute("select * from orders")])
        self.assertNotIn(PLACEHOLDER, stored)
        journal = "".join(f.read_text() for f in (self.dir / "offhost").glob("*") if f.is_file())
        self.assertNotIn(PLACEHOLDER, journal)

    def test_C4_the_invoice_shows_price_address_and_a_bip21_uri(self):
        self.list("one@space")
        path = self.buy("one@space")
        p = self.http("GET", path)
        self.assertIsNone(p.find("address"))
        self.assertIn(f'action="{path}/invoice"', p.text)
        self.assertEqual(self.http("POST", path + "/invoice").status, 303)
        p = self.http("GET", path)
        oid = self.led.order_by_token(path.rsplit("/", 1)[1])
        address = self.led.operator_view(oid)["dest_address"]
        self.assertEqual((p.find("status"), p.find("address")), ("quoted", address))
        self.assertEqual((p.find("price_sats"), p.find("amount_btc")), ("10000", "0.0001"))
        self.assertEqual(p.find("bip21"), f"bitcoin:{address}?amount=0.0001")
        # Paid and converted: the page follows.
        self.pay(self.led.operator_view(oid)["dest_script"], 10_000)
        p = self.http("GET", path)
        self.assertEqual((p.find("status"), p.find("batchable_sats")), ("converted", "10000"))

    def test_C5_no_address_until_the_quote_is_acknowledged(self):
        self.list("one@space")
        path = self.buy("one@space")
        journal = self.led.journal
        append = journal.append

        def lost(*args, **kwargs):
            raise JournalDown("acknowledgment lost")

        journal.append = lost
        p = self.http("POST", path + "/invoice")
        self.assertEqual(p.status, 503)
        self.assertIsNone(p.find("address"))
        self.assertIn("Try again", p.text)
        oid = self.led.order_by_token(path.rsplit("/", 1)[1])
        recorded = self.led.operator_view(oid)["dest_address"]
        self.assertNotIn(recorded, p.text)
        p = self.http("GET", path)
        self.assertIsNone(p.find("address"))
        self.assertIn('id="address_pending"', p.text)
        self.assertNotIn(recorded, p.text)
        journal.append = append
        self.assertEqual(self.http("POST", path + "/invoice").status, 303)
        self.assertEqual(self.http("GET", path).find("address"), recorded)
        # With the journal known to be down, nothing is taken.
        self.list("two@space")
        path2 = self.buy("two@space", SPK2)
        journal.set_available(False)
        p = self.http("POST", path2 + "/invoice")
        self.assertEqual(p.status, 503)
        self.assertIsNone(p.find("address"))
        oid2 = self.led.order_by_token(path2.rsplit("/", 1)[1])
        self.assertEqual(self.led.operator_view(oid2)["status"], "requested")

    def test_C6_an_order_page_shows_its_own_order_only(self):
        self.list("one@space", "two@space")
        p1, p2 = self.buy("one@space"), self.buy("two@space", SPK2)
        a, b = self.http("GET", p1), self.http("GET", p2)
        self.assertIn("one@space", a.text)
        self.assertNotIn("two@space", a.text)
        self.assertNotIn(SPK2, a.text)
        self.assertNotIn(p2.rsplit("/", 1)[1], a.text)
        self.assertIn("two@space", b.text)
        for path in ("/o/" + "A" * 32, "/o/o1", "/o/short", "/o/" + "A" * 32 + "/certificate",
                     "/o/" + "A" * 32 + "/invoice"):
            for method in ("GET", "POST"):
                p = self.http(method, path, form={} if method == "POST" else None)
                self.assertEqual(p.status, 404, (method, path))
                self.assertNotIn("one@space", p.text)
                self.assertNotIn("two@space", p.text)

    def test_C7_a_certificate_is_delivered_and_served_only_for_a_ready_order(self):
        oid, path = self.ready_order()
        code, out = self.deliver(oid)
        self.assertEqual(code, 409)
        self.assertIsNone(self.led.db.execute("select 1 from certificates").fetchone())
        self.assertEqual(self.http("GET", path + "/certificate").status, 404)
        self.assertNotIn('id="certificate"', self.http("GET", path).text)
        self.assertEqual(self.op("POST", "/operator/issuing", {"oids": [oid]})[0], 200)
        self.assertEqual(self.deliver(oid)[0], 409)
        self.op("POST", f"/operator/orders/{oid}/transition", {"action": "mark_ready"})
        self.assertEqual(self.deliver(oid), (200, {"delivered": True, "bytes": len(CERT)}))
        page = self.http("GET", path)
        self.assertIn(f'href="{path}/certificate"', page.text)
        cert = self.http("GET", path + "/certificate")
        self.assertEqual((cert.status, cert.body), (200, CERT))
        self.assertEqual(cert.headers["content-type"], "application/octet-stream")
        self.assertIn('filename="one@space.certificate"', cert.headers["content-disposition"])
        # Fulfilled keeps it.
        self.op("POST", f"/operator/orders/{oid}/transition", {"action": "mark_fulfilled"})
        self.assertEqual(self.http("GET", path + "/certificate").body, CERT)
        # Bad base64 and an empty certificate are refused.
        self.assertEqual(self.op("POST", f"/operator/orders/{oid}/certificate",
                                 {"message_b64": "%%%"})[0], 400)
        self.assertEqual(self.deliver(oid, b"")[0], 400)
        self.assertEqual(self.http("GET", path + "/certificate").body, CERT)

    def test_C8_the_download_is_withdrawn_while_the_order_is_not_ready(self):
        oid, path = self.ready_order()
        self.op("POST", "/operator/issuing", {"oids": [oid]})
        self.op("POST", f"/operator/orders/{oid}/transition", {"action": "mark_ready"})
        self.assertEqual(self.deliver(oid)[0], 200)
        self.op("POST", f"/operator/orders/{oid}/transition", {"action": "unready"})
        self.assertEqual(self.led.operator_view(oid)["status"], "issuing")
        self.assertEqual(self.http("GET", path + "/certificate").status, 404)
        self.assertNotIn('id="certificate"', self.http("GET", path).text)
        self.op("POST", f"/operator/orders/{oid}/transition", {"action": "mark_ready"})
        self.assertEqual(self.http("GET", path + "/certificate").body, CERT)

    def test_C10_a_later_batch_certificate_is_delivered_whole(self):
        from service.app import MAX_BODY, MAX_CERTIFICATE
        self.assertEqual(len(LATER_BATCH_CERT.read_bytes()), 226_511)
        cert = LATER_BATCH_CERT.read_bytes()
        self.assertGreater(len(cert), MAX_BODY)
        oid, path = self.ready_order()
        self.op("POST", "/operator/issuing", {"oids": [oid]})
        self.op("POST", f"/operator/orders/{oid}/transition", {"action": "mark_ready"})
        self.assertEqual(self.deliver(oid, cert), (200, {"delivered": True, "bytes": len(cert)}))
        got = self.http("GET", path + "/certificate")
        self.assertEqual((got.status, got.body), (200, cert))
        # Over the certificate's own bound: refused, the delivered one kept.
        self.assertEqual(self.deliver(oid, b"x" * (MAX_CERTIFICATE + 1)),
                         (400, {"error": "certificate too large"}))
        # A body declared over the delivery's bound is refused unread.
        from service.app import MAX_CERTIFICATE_BODY
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("POST", f"/operator/orders/{oid}/certificate", body=b"{}",
                     headers={"Content-Length": str(MAX_CERTIFICATE_BODY + 1),
                              "Content-Type": "application/json",
                              "Authorization": "Bearer " + OPERATOR})
        r = conn.getresponse()
        self.assertEqual((r.status, json.loads(r.read())), (400, {"error": "body too large"}))
        conn.close()
        self.assertEqual(self.http("GET", path + "/certificate").body, cert)
        # The larger bound is the authenticated certificate delivery's alone.
        import base64
        big = {"message_b64": base64.b64encode(cert).decode()}
        p = self.http("POST", f"/operator/orders/{oid}/certificate", json_body=big)
        self.assertEqual(p.status, 401)
        p = self.http("POST", "/operator/names", json_body={"handle": "x" * 70_000, "price": 1},
                      token=OPERATOR)
        self.assertEqual((p.status, json.loads(p.body)), (400, {"error": "body too large"}))
        before = self.counts()
        p = self.http("POST", "/requests",
                      json_body={"handle": "one@space", "script_pubkey": SPK, "pad": "x" * MAX_BODY})
        self.assertEqual((p.status, json.loads(p.body)), (400, {"error": "body too large"}))
        p = self.http("POST", "/buy/one@space", form={"request": "x" * MAX_BODY})
        self.assertEqual(p.status, 400)
        self.assertEqual(self.counts(), before)

    def active(self, page):
        return "Pay exactly" in page.text or 'id="bip21"' in page.text or "bitcoin:" in page.text

    def test_C11_only_a_payable_order_shows_a_payment_request(self):
        led = self.led
        # Quoted, holding its name, nothing confirmed: the active request.
        self.list("one@space", "two@space", "three@space", "four@space")
        p1 = self.buy("one@space")
        self.http("POST", p1 + "/invoice")
        page = self.http("GET", p1)
        self.assertTrue(self.active(page))
        self.assertIn('id="payment_request"', page.text)
        o1 = led.order_by_token(p1.rsplit("/", 1)[1])
        address = led.operator_view(o1)["dest_address"]

        def history(path, status, note):
            page = self.http("GET", path)
            self.assertEqual(page.find("status"), status)
            self.assertFalse(self.active(page), status)
            self.assertIn('id="invoice_history"', page.text)
            self.assertIn(note, page.find("invoice_note"))
            return page

        # A payment at one confirmation, below the three that convert the
        # order: not asked again.
        self.pay(led.operator_view(o1)["dest_script"], 10_000, n=1)
        history(p1, "quoted", "Payment detected, awaiting confirmation")
        # Converted, issuing, ready, fulfilled: paid, never asked again.
        self.chain.mine()
        self.chain.mine()
        page = history(p1, "converted", "Paid in full")
        self.assertEqual(page.find("invoice_address"), address)
        self.op("POST", "/operator/issuing", {"oids": [o1]})
        history(p1, "issuing", "Paid in full")
        self.op("POST", f"/operator/orders/{o1}/transition", {"action": "mark_ready"})
        history(p1, "ready", "Paid in full")
        self.op("POST", f"/operator/orders/{o1}/transition", {"action": "mark_fulfilled"})
        history(p1, "fulfilled", "Paid in full")

        # Cancelled, final.
        p2 = self.buy("two@space", SPK2)
        self.http("POST", p2 + "/invoice")
        o2 = led.order_by_token(p2.rsplit("/", 1)[1])
        self.pay(led.operator_view(o2)["dest_script"], 10_000)
        self.assertEqual(self.op("POST", f"/operator/orders/{o2}/cancel")[0], 200)
        history(p2, "cancelled", "cancelled")

        # A cancellation not yet acknowledged: the page keeps the last
        # acknowledged status, and still doesn't ask for payment.
        spk3, spk4 = recipient("buyer-3"), recipient("buyer-4")
        p3 = self.buy("three@space", spk3)
        self.http("POST", p3 + "/invoice")
        o3 = led.order_by_token(p3.rsplit("/", 1)[1])
        self.pay(led.operator_view(o3)["dest_script"], 10_000)
        self.op("POST", "/operator/observe")
        append = led.journal.append

        def lost(*args, **kwargs):
            raise JournalDown("acknowledgment lost")

        led.journal.append = lost
        self.assertEqual(self.op("POST", f"/operator/orders/{o3}/cancel")[0], 202)
        page = self.http("GET", p3)
        self.assertEqual((page.find("status"), page.find("cancellation")),
                         ("converted", "unconfirmed"))
        self.assertFalse(self.active(page))
        self.assertIn("being recorded", page.find("invoice_note"))
        led.journal.append = append

        # The hold runs out with nothing paid: unpaid, history only. The
        # page itself evaluates first, so an expiry not yet observed counts.
        p4 = self.buy("four@space", spk4)
        self.http("POST", p4 + "/invoice")
        self.assertTrue(self.active(self.http("GET", p4)))
        self.now[0] = 10_000.0
        history(p4, "unpaid", "expired unpaid")

        # The hold runs out with too little paid: refund due.
        self.list("five@space")
        p5 = self.buy("five@space", recipient("buyer-5"))
        self.now[0] = 20_000.0
        self.http("POST", p5 + "/invoice")
        o5 = led.order_by_token(p5.rsplit("/", 1)[1])
        self.pay(led.operator_view(o5)["dest_script"], 4_000, n=1)
        history(p5, "quoted", "Partial payment detected")
        self.now[0] = 30_000.0
        for _ in range(7):
            self.chain.mine()
        history(p5, "refund_due", "refund is due")

    def test_C12_an_unconfirmed_payment_is_shown_and_never_counted(self):
        led = self.led
        self.list("one@space", "two@space", "three@space", "four@space")

        def order(handle, i):
            path = self.buy(handle, recipient(f"c12-buyer-{i}"))
            self.http("POST", path + "/invoice")
            self.assertTrue(self.active(self.http("GET", path)))
            oid = led.order_by_token(path.rsplit("/", 1)[1])
            return path, oid, led.operator_view(oid)["dest_script"]

        def state(oid):
            o = led.operator_view(oid)
            n = led.db.execute("select * from names where name = ?", (o["name"],)).fetchone()
            return o["status"], o["price_reserve"], tuple(n), o["sums"]

        def shown(path, status, note, detected, confirmed):
            # The page changes nothing the ledger's own evaluation doesn't:
            # evaluate first, then compare after the page is read.
            self.op("POST", "/operator/observe")
            oid = led.order_by_token(path.rsplit("/", 1)[1])
            before = state(oid)
            page = self.http("GET", path)
            self.assertEqual(state(oid), before)
            self.assertEqual(page.find("status"), status)
            self.assertFalse(self.active(page), note)
            self.assertNotIn("bitcoin:", page.text)
            self.assertIn(note, page.find("invoice_note"))
            self.assertEqual((page.find("detected_sats"), page.find("confirmed_sats")),
                             (str(detected), str(confirmed)))
            return page

        def send(txid, coin, script, value):
            self.chain.add(Tx(txid, ((coin, 0),), ((script, value),)))

        # 1. The full price enters the mempool: detected, awaiting
        # confirmation, not settled, not converted.
        p1, o1, s1 = order("one@space", 1)
        send("c12-pay-1", "c12-coin-1", s1, 10_000)
        page = shown(p1, "quoted", "Payment detected, awaiting confirmation", 10_000, 0)
        self.assertEqual(page.find("unconfirmed_sats"), "10000")
        self.assertEqual(state(o1)[3], {"confirmed": 0, "batchable": 0, "settled": 0})
        token = p1.rsplit("/", 1)[1]
        link = json.loads(self.http("GET", f"/orders/{token}").body)
        self.assertEqual((link["detected_sats"], link["confirmed_sats"], link["status"]),
                         (10_000, 0, "quoted"))
        # It confirms: still awaiting the 3 blocks that convert it.
        self.chain.mine(["c12-pay-1"])
        shown(p1, "quoted", "Payment detected, awaiting confirmation", 10_000, 10_000)
        self.chain.mine_empty(2)
        page = self.http("GET", p1)
        self.assertEqual(page.find("status"), "converted")
        self.assertIn("Paid in full", page.find("invoice_note"))

        # 2. Too little in the mempool: described as partial, and the rest
        # isn't asked for.
        p2, o2, s2 = order("two@space", 2)
        send("c12-pay-2", "c12-coin-2", s2, 4_000)
        page = shown(p2, "quoted", "Partial payment detected, awaiting confirmation",
                     4_000, 0)
        self.assertIn("4000 of the 10000 sats", page.find("invoice_note"))

        # 3. A payment that disappears: no prompt to pay again, and nothing
        # says another payment is safe. After the hold, still a warning.
        p3, o3, s3 = order("three@space", 3)
        send("c12-pay-3", "c12-coin-3", s3, 10_000)
        shown(p3, "quoted", "Payment detected", 10_000, 0)
        self.chain.drop("c12-pay-3")
        page = shown(p3, "quoted", "no longer sees it", 0, 0)
        self.assertIn("Don&#x27;t send another payment", page.text)
        self.now[0] = 100_000.0
        self.chain.drop("c12-pay-2")
        self.chain.mine_empty(7)
        shown(p3, "unpaid", "A payment detected earlier may still confirm", 0, 0)

        # 4. A payment replaced: by a smaller one to the same address, then
        # by one that doesn't pay it at all.
        p4, o4, s4 = order("four@space", 4)
        send("c12-pay-4", "c12-coin-4", s4, 10_000)
        shown(p4, "quoted", "Payment detected", 10_000, 0)
        self.chain.drop("c12-pay-4")
        send("c12-pay-4b", "c12-coin-4", s4, 6_000)
        page = shown(p4, "quoted", "Partial payment detected", 6_000, 0)
        self.assertIn("6000 of the 10000 sats", page.find("invoice_note"))
        self.chain.drop("c12-pay-4b")
        send("c12-pay-4c", "c12-coin-4", recipient("c12-elsewhere"), 9_900)
        shown(p4, "quoted", "no longer sees it", 0, 0)

    def test_C12_a_restore_never_brings_the_payment_request_back(self):
        """C12, after a host loss: the payment history a journal-only
        restore can't establish is unknown, never "none"."""
        led = self.led
        self.list("one@space", "two@space", "three@space", "four@space")

        def order(handle, i):
            path = self.buy(handle, recipient(f"c12r-buyer-{i}"))
            self.http("POST", path + "/invoice")
            self.assertTrue(self.active(self.http("GET", path)))
            return path, self.led.operator_view(
                self.led.order_by_token(path.rsplit("/", 1)[1]))["dest_script"]

        def shown(path, note, history):
            page = self.http("GET", path)
            self.assertEqual(page.find("status"), "quoted")
            self.assertFalse(self.active(page), note)
            self.assertNotIn("bitcoin:", page.text)
            self.assertIn(note, page.find("invoice_note"))
            link = json.loads(self.http("GET", "/orders/" + path.rsplit("/", 1)[1]).body)
            self.assertEqual(link["payment_history"], history)
            return page

        p1, s1 = order("one@space", 1)
        p2, s2 = order("two@space", 2)
        # An invoice nobody pays, and an order never given one.
        p3, _ = order("three@space", 3)
        p4 = self.buy("four@space", recipient("c12r-buyer-4"))
        # 1. Detected with the journal healthy, then gone: the marker was
        # journaled, so the restored page still says it can confirm.
        self.chain.add(Tx("c12r-pay-1", (("c12r-coin-1", 0),), ((s1, 10_000),)))
        shown(p1, "Payment detected, awaiting confirmation", "detected")
        self.assertEqual(self.led.acknowledged_status(
            self.led.order_by_token(p1.rsplit("/", 1)[1])), "quoted")
        self.assertEqual(self.led.db.execute(
            "select count(*) from journal_backlog").fetchone()[0], 0)
        # 2. Detected during a journal outage that lasts until the host is
        # lost, then gone: nothing about it was acknowledged.
        self.journal.set_available(False)
        self.chain.add(Tx("c12r-pay-2", (("c12r-coin-2", 0),), ((s2, 10_000),)))
        shown(p2, "Payment detected, awaiting confirmation", "detected")
        self.chain.drop("c12r-pay-1")
        self.chain.drop("c12r-pay-2")
        shown(p1, "no longer sees it", "detected")

        self.lose_host_and_restore()
        shown(p1, "no longer sees it", "detected")
        shown(p2, "tell whether a payment was sent", "unknown")
        # The restore can't tell an unpaid invoice from a paid one either.
        shown(p3, "tell whether a payment was sent", "unknown")
        # An order never given an address can't have been paid.
        page = self.http("GET", p4)
        self.assertEqual(page.find("status"), "requested")
        self.assertIn("Get the invoice", page.text)
        # The lost payment comes back: detected again, and then known.
        self.chain.add(Tx("c12r-pay-2", (("c12r-coin-2", 0),), ((s2, 10_000),)))
        shown(p2, "Payment detected, awaiting confirmation", "detected")
        # The hold ends: the page still warns rather than inviting a payment.
        self.now[0] = 100_000.0
        self.chain.mine_empty(7)
        page = self.http("GET", p3)
        self.assertEqual(page.find("status"), "unpaid")
        self.assertIn("tell whether a payment was sent", page.find("invoice_note"))

    def older_database(self):
        """Leave the database as the code before the payment history left
        it, with the service stopped."""
        self.stop()
        db = sqlite3.connect(self.dir / "store.db")
        db.execute("alter table orders drop column payment_history")
        db.commit()
        db.close()

    def histories(self, *paths):
        return [json.loads(self.http("GET", "/orders/" + p.rsplit("/", 1)[1]).body)
                ["payment_history"] for p in paths]

    def test_C12_an_older_database_upgrades_conservatively_and_atomically(self):
        """C12, upgrading a database from before the payment history: a
        recorded payment is detected, an invoice without one is unknown,
        and only an order never given an address is none. An interrupted
        upgrade leaves the database as it was."""
        self.list("one@space", "two@space", "three@space")
        p1 = self.buy("one@space", recipient("c12o-buyer-1"))
        self.http("POST", p1 + "/invoice")
        p2 = self.buy("two@space", recipient("c12o-buyer-2"))
        self.http("POST", p2 + "/invoice")
        p3 = self.buy("three@space", recipient("c12o-buyer-3"))
        s1 = self.led.operator_view(self.led.order_by_token(p1.rsplit("/", 1)[1]))["dest_script"]
        self.chain.add(Tx("c12o-pay-1", (("c12o-coin-1", 0),), ((s1, 10_000),)))
        self.op("POST", "/operator/observe")
        self.chain.drop("c12o-pay-1")
        self.older_database()

        # Interrupted between adding the column and classifying the orders:
        # nothing is left behind, and the next start upgrades again.
        def interrupted(ledger):
            raise KeyboardInterrupt("interrupted mid-upgrade")

        original = Ledger._classify_payment_history
        Ledger._classify_payment_history = interrupted
        try:
            with self.assertRaises(KeyboardInterrupt):
                Ledger(self.dir / "store.db", self.view, self.journal, Policy(),
                       clock=lambda: self.now[0])
        finally:
            Ledger._classify_payment_history = original
        db = sqlite3.connect(self.dir / "store.db")
        cols = {r[1] for r in db.execute("pragma table_info(orders)")}
        db.close()
        self.assertNotIn("payment_history", cols)

        self._open()
        self.assertEqual(self.histories(p1, p2, p3), ["detected", "unknown", "none"])
        self.assertIn("no longer sees it", self.http("GET", p1).find("invoice_note"))
        page = self.http("GET", p2)
        self.assertFalse(self.active(page))
        self.assertIn("tell whether a payment was sent", page.find("invoice_note"))
        self.assertIn("Get the invoice", self.http("GET", p3).text)

    def test_C12_an_older_restored_database_or_journal_without_the_marker(self):
        """C12, from before the payment history: a database the older code
        restored from its journal holds no payment outputs, and an older
        journal holds no history. Either way every issued invoice is
        unknown."""
        self.list("one@space", "two@space")
        p1 = self.buy("one@space", recipient("c12j-buyer-1"))
        self.http("POST", p1 + "/invoice")
        p2 = self.buy("two@space", recipient("c12j-buyer-2"))
        s1 = self.led.operator_view(self.led.order_by_token(p1.rsplit("/", 1)[1]))["dest_script"]
        self.chain.add(Tx("c12j-pay-1", (("c12j-coin-1", 0),), ((s1, 10_000),)))
        self.op("POST", "/operator/observe")
        self.chain.drop("c12j-pay-1")

        # The older code's journal, without the history in any entry.
        path = self.journal.path
        entries = [json.loads(line) for line in path.read_text().splitlines() if line]
        for e in entries:
            for rec in e.get("records", ()):
                if rec.get("kind") == "order":
                    rec["state"].pop("payment_history", None)
        path.write_text("".join(json.dumps(e) + "\n" for e in entries))

        # The older code's restore: no payment outputs and no history
        # column. The new code then opens it.
        self.lose_host_and_restore()
        self.older_database()
        db = sqlite3.connect(self.dir / "store.db")
        self.assertEqual(db.execute("select count(*) from payment_outputs").fetchone()[0], 0)
        db.close()
        self._open()
        self.assertEqual(self.histories(p1, p2), ["unknown", "none"])
        page = self.http("GET", p1)
        self.assertFalse(self.active(page))
        self.assertIn("tell whether a payment was sent", page.find("invoice_note"))

        # The new code's restore from the same older journal.
        self.lose_host_and_restore()
        self.assertEqual(self.histories(p1, p2), ["unknown", "none"])
        self.assertFalse(self.active(self.http("GET", p1)))
        self.assertIn("Get the invoice", self.http("GET", p2).text)

    def test_C9_pages_are_private_scriptless_unframeable_and_escaped(self):
        self.list("one@space")
        path = self.buy("one@space")
        self.http("POST", path + "/invoice")
        self.http("POST", path + "/refund-address",
                  form={"address": 'bcrt1q"><script>alert(1)</script>'})
        pages = [self.http("GET", "/"), self.http("GET", "/buy/one@space"),
                 self.http("GET", path), self.http("GET", "/o/" + "A" * 32),
                 self.http("POST", "/buy/one@space", form={"request": "<b>x</b>"}),
                 self.http("POST", path + "/refund-address",
                           form={"address": "<script>alert(2)</script>"})]
        for p in pages:
            with self.subTest(status=p.status):
                self.assertEqual(p.headers["cache-control"], "no-store")
                self.assertEqual(p.headers["referrer-policy"], "no-referrer")
                csp = p.headers["content-security-policy"]
                self.assertIn("script-src 'none'", csp)
                self.assertIn("frame-ancestors 'none'", csp)
                self.assertNotIn("<script", p.text)
                self.assertNotIn("<b>x</b>", p.text)
        # The refund address the buyer gave is shown escaped, never as markup.
        shown = self.http("GET", path).text
        self.assertIn("&lt;script&gt;alert(2)&lt;/script&gt;", shown)


if __name__ == "__main__":
    unittest.main()
