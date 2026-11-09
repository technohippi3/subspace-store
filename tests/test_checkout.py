"""The buyer's checkout pages over a simulated chain (PAYMENT-SPEC.md,
"Checkout and the attended runner").

The `test_C*` tests are the checkout cases C1 to C11. They exercise the
service's own pages and code paths over the model's simulated chain, so
they are service API results: neither model results nor regtest evidence.
The regtest demonstration is scenario 10 (`regtest/run-checkout.sh`).
"""

import http.client
import json
import re
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlencode

from model.chain import Chain, Tx
from service.app import Service
from service.journal import Journal, JournalDown
from service.ledger import Ledger, Policy
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
        ledger = Ledger(self.dir / "store.db", self.view, Journal(self.dir / "offhost"),
                        Policy(), clock=lambda: self.now[0])
        self.service = Service(ledger, self.view, OPERATOR, SUBS, 1_000_000, poll_seconds=3600)
        self.service.start()
        self.service.serve("127.0.0.1", 0)
        self.port = self.service.server.server_address[1]
        self.addCleanup(self.service.ledger.close)
        self.addCleanup(self.service.shutdown)
        self.led = self.service.ledger

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

        # A payment seen, below 3 blocks: not asked again.
        self.pay(led.operator_view(o1)["dest_script"], 10_000, n=1)
        history(p1, "quoted", "waiting for confirmations")
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
        history(p5, "quoted", "waiting for confirmations")
        self.now[0] = 30_000.0
        for _ in range(7):
            self.chain.mine()
        history(p5, "refund_due", "refund is due")

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
