"""The store's HTTP API.

Three kinds of caller, each with its own boundary:
- buyers, with no account. A recipient request carries only the public
  handle and the buyer's `script_pubkey`, and returns a private order link.
  Any other member refuses the whole request (PAYMENT-SPEC.md, "Recipient
  requests"), and no request body is ever logged or echoed.
  Everything about an order, including its refund address, goes through that
  link and shows only that order. A payment address is shown only once
  the off-host journal has acknowledged the order carrying it; until then
  `/quote` answers 503 and gives none;
- the operator and the controller, with the operator's bearer token;
- `subs`, with the registry token, on `/health`, `/pending`, `/ack` and
  `/committed`. `/pending` serves only the frozen batch's handles and
  scripts.

All ledger calls are serialized by one lock. A background loop evaluates
the ledger against the chain every few seconds.
"""

import hmac
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .bitcoin import RefundBuilder
from .ledger import ISSUED, Invalid, Refused, Unconfirmed

TOKEN_RE = r"([A-Za-z0-9_-]{16,64})"
OID_RE = r"(o\d+)"


REQUEST_FIELDS = frozenset({"handle", "script_pubkey"})
MAX_BODY = 65536  # bytes; a larger body is refused unread


class BadRequest(Exception):
    pass


def _unique_members(pairs):
    """json.loads keeps the last of a repeated member; refuse instead."""
    out = {}
    for k, v in pairs:
        if k in out:
            raise BadRequest("repeated member")
        out[k] = v
    return out


def _token_ok(given, expected):
    return given is not None and hmac.compare_digest(given.encode(), expected.encode())


class Service:
    def __init__(self, ledger, view, operator_token, subs_token, hot_wallet_cap_sats,
                 poll_seconds=2.0):
        self.ledger = ledger
        self.view = view
        self.builder = RefundBuilder(view, hot_wallet_cap_sats)
        self.operator_token = operator_token
        self.subs_token = subs_token
        self.lock = threading.RLock()
        self.poll_seconds = poll_seconds
        self.server = None
        self._stop = threading.Event()
        self.startup = {}

    # Start-up and the background loop

    def start(self):
        """Before serving anything: reconcile every refund attempt against
        the chain, rebroadcast attempted ones that the node doesn't know as
        the same signed transaction, then evaluate."""
        with self.lock:
            rebroadcast = self.ledger.reconcile_attempts()
            for txid in rebroadcast:
                gid = self.ledger._attempt(txid)["gid"]
                try:
                    self.ledger.rebroadcast(gid, txid)
                except Refused:
                    pass
            self.ledger.observe()
            self.startup = {"rebroadcast": rebroadcast, "at": time.time()}

    def loop(self):
        while not self._stop.wait(self.poll_seconds):
            try:
                with self.lock:
                    self.ledger.observe()
            except Exception:  # noqa: BLE001 - keep evaluating; the next pass retries
                pass

    # Operations that combine several ledger steps

    def refund(self, oid, kind):
        """Build, sign and reserve one refund group's first attempt. Nothing
        is sent: broadcasting is a separate call, after the journal check."""
        led = self.ledger
        led.observe()
        o = led.operator_view(oid)
        if kind == "cancellation" and o["status"] not in ("cancelled", "refund_due"):
            raise Refused("order is not cancelled or refund due")
        fee = led.policy.refund_fee
        charged = led.available(oid)
        if kind == "excess" and charged < fee + led.policy.excess_minimum_over_fee:
            raise Refused("excess below the refund minimum")
        to_buyer = charged - fee
        if to_buyer <= 0:
            raise Refused("nothing refundable")
        tx, actual_fee = self.builder.build(led, oid, to_buyer, fee)
        n = led.db.execute("select coalesce(max(seq), 0) + 1 from groups").fetchone()[0]
        gid = f"g{n}"
        led.open_group(gid, oid, kind, tx, to_buyer, actual_fee, charged=to_buyer + fee)
        return {"gid": gid, "txid": tx["txid"], "to_buyer": to_buyer, "fee": actual_fee,
                "charged": to_buyer + fee}

    def broadcast(self, gid, txid=None):
        led = self.ledger
        attempts = led._attempts(gid)
        if not attempts:
            raise Refused("no such refund")
        txid = txid or attempts[-1]["txid"]
        sent = led.broadcast(gid, txid)
        return {"gid": gid, "txid": txid, "acknowledged": sent}

    # HTTP

    def serve(self, host, port):
        service = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                pass

            def _send(self, code, obj):
                out = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(out)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Referrer-Policy", "no-referrer")
                self.end_headers()
                self.wfile.write(out)

            def _bearer(self):
                h = self.headers.get("Authorization") or ""
                return h[len("Bearer "):] if h.startswith("Bearer ") else None

            def _body(self):
                n = int(self.headers.get("Content-Length") or 0)
                if n > MAX_BODY:
                    raise BadRequest("body too large")
                try:
                    body = json.loads(self.rfile.read(n) or b"{}",
                                      object_pairs_hook=_unique_members)
                except ValueError:
                    raise BadRequest("invalid JSON")
                if not isinstance(body, dict):
                    raise BadRequest("expected a JSON object")
                return body

            def _route(self, method):
                url = urlparse(self.path)
                path, query = url.path, parse_qs(url.query)
                token = self._bearer()
                if path in ("/health", "/pending", "/ack", "/committed"):
                    if not _token_ok(token, service.subs_token):
                        return 401, {"error": "unauthorized"}
                    return service.route_subs(method, path, query, self._body)
                if path.startswith("/operator/"):
                    if not _token_ok(token, service.operator_token):
                        return 401, {"error": "unauthorized"}
                    return service.route_operator(method, path, query, self._body)
                return service.route_public(method, path, self._body)

            def _handle(self, method):
                try:
                    with service.lock:
                        code, obj = self._route(method)
                except Unconfirmed as e:
                    code, obj = 503, {"error": str(e), "acknowledged": False}
                except Refused as e:
                    missing = str(e) in ("no such order", "not for sale", "no such refund")
                    code, obj = (404 if missing else 409), {"error": str(e)}
                except (BadRequest, Invalid) as e:
                    code, obj = 400, {"error": str(e)}
                except Exception as e:  # noqa: BLE001 - never leak a trace
                    code, obj = 500, {"error": type(e).__name__}
                self._send(code, obj)

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

        self.server = ThreadingHTTPServer((host, port), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        threading.Thread(target=self.loop, daemon=True).start()

    def shutdown(self):
        self._stop.set()
        if self.server:
            self.server.shutdown()
            self.server.server_close()

    # Routes

    def route_public(self, method, path, body):
        led = self.ledger
        m = re.fullmatch(r"/names/([^/]+)", path)
        if m and method == "GET":
            row = led.db.execute("select * from names where name = ?", (m.group(1),)).fetchone()
            if row is None:
                return 404, {"error": "not for sale"}
            free = row["hold_order"] is None and row["fulfillment_order"] is None
            return 200, {"handle": row["name"], "price_sats": row["price"],
                         "available": free}
        if path == "/requests" and method == "POST":
            b = body()
            # Exactly these two members, both strings. The message never
            # names or echoes what else was sent.
            if set(b) != REQUEST_FIELDS:
                raise BadRequest("a request has exactly the members handle and script_pubkey")
            if not all(isinstance(b[k], str) for k in REQUEST_FIELDS):
                raise BadRequest("handle and script_pubkey must be strings")
            oid, token = led.request(b["handle"], b["script_pubkey"])
            return 201, {"order_link": f"/orders/{token}", "token": token}
        m = re.fullmatch(rf"/orders/{TOKEN_RE}(/[a-z-]+)?", path)
        if m:
            oid = led.order_by_token(m.group(1))
            action = m.group(2)
            if action is None and method == "GET":
                led.observe()
                return 200, led.order_view(oid)
            if action == "/quote" and method == "POST":
                q = led.quote(oid)
                if not q["acknowledged"]:
                    return 503, {"error": "the quote is not yet acknowledged off-host; "
                                          "no address is given. Ask again.",
                                 "acknowledged": False}
                return 200, q
            if action == "/refund-address" and method == "POST":
                address = body().get("address") or ""
                led.set_refund_address(oid, address, self.view.refund_script(address))
                return 200, {"refund_address": address}
        return 404, {"error": "not found"}

    def route_operator(self, method, path, query, body):
        led = self.ledger
        if path == "/operator/names" and method == "POST":
            b = body()
            led.list_name(b.get("handle"), b.get("price"))
            return 200, {"ok": True}
        if path == "/operator/observe" and method == "POST":
            led.observe()
            return 200, {"ok": True}
        if path == "/operator/orders" and method == "GET":
            return 200, {"orders": led.orders(query.get("status", [None])[0])}
        if path == "/operator/alerts" and method == "GET":
            return 200, {"alerts": led.alerts()}
        if path == "/operator/status" and method == "GET":
            backlog = led.db.execute("select count(*) from journal_backlog").fetchone()[0]
            return 200, {"startup": self.startup, "journal_backlog": backlog,
                         "tip": self.view.tip}
        if path == "/operator/issuing" and method == "POST":
            return 200, {"acknowledged": led.mark_issuing_all(body().get("oids", []))}
        if path == "/operator/pending" and method == "POST":
            led.set_pending(body().get("oids", []))
            return 200, {"ok": True}
        m = re.fullmatch(rf"/operator/orders/{OID_RE}(/[a-z-]+)?", path)
        if m:
            oid, action = m.group(1), m.group(2)
            if action is None and method == "GET":
                return 200, dict(led.operator_view(oid),
                                 journaled_status=led.acknowledged_status(oid))
            if method != "POST":
                return 404, {"error": "not found"}
            if action == "/batch-entry":
                return 200, {"batch_entry": led.batch_entry_ok(oid),
                             "issuing_recheck": led.issuing_recheck_ok(oid)}
            if action == "/journal":
                return 200, {"acknowledged": led.journal_order(oid)}
            if action == "/cancel":
                if led.cancel(oid):
                    return 200, {"status": "cancelled", "cancellation": "final",
                                 "acknowledged": True}
                # Recorded here only: a host loss before the journal
                # acknowledges it undoes it. Cancelling again confirms it.
                return 202, {"cancellation": "unconfirmed", "acknowledged": False,
                             "detail": "recorded locally, not yet acknowledged off-host; "
                                       "not final, and a host loss before the "
                                       "acknowledgment undoes it"}
            if action == "/transition":
                to = body().get("action")
                calls = {"unissue": led.unissue, "restore_issuing": led.restore_issuing,
                         "unready": led.unready, "mark_ready": led.mark_ready,
                         "mark_fulfilled": led.mark_fulfilled}
                if to not in calls:
                    raise BadRequest("unknown transition")
                calls[to](oid)
                return 200, {"status": led.operator_view(oid)["status"]}
            if action == "/refunds":
                return 200, self.refund(oid, body().get("kind"))
            if action == "/losses":
                led.record_loss(oid, body().get("reason"))
                return 200, {"ok": True}
        m = re.fullmatch(r"/operator/refunds/(g\d+)/broadcast", path)
        if m and method == "POST":
            return 200, self.broadcast(m.group(1), body().get("txid"))
        return 404, {"error": "not found"}

    def route_subs(self, method, path, query, body):
        led = self.ledger
        if path == "/health":
            return 200, {"ok": True}
        if path == "/pending" and method == "GET":
            return 200, {"handles": led.pending_for(query.get("space", [""])[0])}
        if path == "/ack" and method == "POST":
            led.subs_ack(body().get("handles", []))
            return 200, {"ok": True}
        if path == "/committed" and method == "POST":
            b = body()
            led.subs_committed(b.get("root"), b.get("handles", []))
            return 200, {"ok": True}
        return 404, {"error": "not found"}


__all__ = ["Service", "ISSUED"]
