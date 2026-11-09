"""The buyer's checkout pages (PAYMENT-SPEC.md, "Checkout and the attended
runner").

Plain HTML forms with no scripts, served beside the JSON API. They add no
rule: every step is the same ledger call as the JSON API, with the same
refusals. The private order page lives at `/o/<token>`, with the token of
the order link `/orders/<token>`.

- `GET /` lists the names for sale with their fixed prices and whether each
  is free now. Nothing about orders.
- `GET /buy/<handle>` takes a public recipient request, such as a Nacho
  export, pasted whole; `POST /buy/<handle>` checks it exactly as
  `POST /requests` does, and also that its handle is the page's name. A
  refused request is never echoed. An accepted one redirects (303) to the
  order page.
- `GET /o/<token>` shows that order only. `POST /o/<token>/invoice` asks for
  the quote; the invoice (price, address, BIP21 URI) appears only under the
  journal rule of `/quote`. `POST /o/<token>/refund-address` sets the refund
  address. `GET /o/<token>/certificate` serves the certificate the runner
  delivered, only while the order is ready or fulfilled.

Every response carries no-store, no-referrer and a content security policy
that allows no scripts and no framing. All text is escaped.
"""

import html
import json
import re
from urllib.parse import parse_qs, quote

from .ledger import Invalid, Refused, Unconfirmed

TOKEN_RE = r"([A-Za-z0-9_-]{16,64})"
HANDLE_PATH_RE = r"([a-z0-9@-]{3,127})"
SATS_PER_BTC = 100_000_000

CSP = ("default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; "
       "form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
HEADERS = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
}

STYLE = """
body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;
line-height:1.45;color:#1d1d1f}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:1.6rem}
table{border-collapse:collapse}td,th{padding:.25rem .8rem .25rem 0;text-align:left}
code,textarea{font-family:ui-monospace,monospace;font-size:.9rem;word-break:break-all}
textarea{width:100%;min-height:8rem}
.muted{color:#6e6e73}.box{border:1px solid #d2d2d7;border-radius:.5rem;padding:.8rem 1rem}
ol.progress li.done{color:#1d1d1f}ol.progress li{color:#86868b}
"""


class Response:
    """An HTML page, a redirect, or a download."""

    def __init__(self, code, body=b"", content_type="text/html; charset=utf-8", headers=None):
        self.code = code
        self.body = body.encode() if isinstance(body, str) else body
        self.content_type = content_type
        self.headers = dict(HEADERS)
        self.headers.update(headers or {})

    def with_code(self, code):
        self.code = code
        return self


def esc(v):
    return html.escape("" if v is None else str(v), quote=True)


def btc(sats):
    """Sats as a BIP21 amount: decimal BTC, no exponent, no trailing zeros."""
    whole, frac = divmod(int(sats), SATS_PER_BTC)
    return f"{whole}.{frac:08d}".rstrip("0").rstrip(".")


def page(code, title, body):
    return Response(code, f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(title)}</title><style>{STYLE}</style></head>
<body>{body}</body></html>""")


def redirect(location):
    return Response(303, "", headers={"Location": location})


def not_found():
    return page(404, "Not found", "<h1>Not found</h1>")


def refused(code, title, reason):
    """A refusal page. `reason` is a fixed message from the ledger or here,
    never anything the buyer sent."""
    return page(code, title, f'<h1>{esc(title)}</h1><p id="refusal">{esc(reason)}</p>'
                             '<p><a href="/">Back to the names</a></p>')


# Pages


def names_page(led):
    rows = led.db.execute("select name, price, hold_order, fulfillment_order from names "
                          "order by name").fetchall()
    items = []
    for r in rows:
        free = r["hold_order"] is None and r["fulfillment_order"] is None
        state = "available" if free else "taken for now"
        link = (f'<a href="/buy/{quote(r["name"], safe="@")}">{esc(r["name"])}</a>' if free
                else esc(r["name"]))
        items.append(f'<tr data-handle="{esc(r["name"])}" data-available="{str(free).lower()}">'
                     f'<td>{link}</td><td>{r["price"]:,} sats</td><td>{state}</td></tr>')
    body = ("<h1>Names for sale</h1>"
            "<p>Fixed prices, paid in bitcoin. You need a public request from your "
            "client, such as a Nacho request, for the name you choose.</p>"
            + ("<table><tr><th>Name</th><th>Price</th><th></th></tr>" + "".join(items)
               + "</table>" if items else "<p>Nothing is for sale right now.</p>"))
    return page(200, "Names for sale", body)


def buy_page(led, handle):
    row = led.db.execute("select name, price from names where name = ?", (handle,)).fetchone()
    if row is None:
        return not_found()
    body = f"""<h1>{esc(row["name"])}</h1>
<p>Price: <span id="price">{row["price"]:,}</span> sats, fixed.</p>
<div class="box"><form method="post" action="/buy/{quote(row["name"], safe="@")}">
<p><label for="request">Paste the public request your client made for
<b>{esc(row["name"])}</b>. It carries the name and the script the name will be issued
to, and nothing secret.</label></p>
<textarea id="request" name="request" required></textarea>
<p><button type="submit">Continue</button></p></form></div>
<p class="muted">Next you get a private order page. Keep its link: it is the only way
back to your order.</p>"""
    return page(200, row["name"], body)


STEPS = (
    ("requested", "Request received"),
    ("quoted", "Invoice issued; the name is held for you"),
    ("paid", "Payment detected"),
    ("converted", "Payment confirmed (3 blocks)"),
    ("issuing", "Being issued on chain"),
    ("ready", "Certificate verified and ready"),
    ("fulfilled", "Published and delivered"),
)
ORDER = {s: i for i, (s, _) in enumerate(STEPS)}


def _progress(v):
    status = v["status"]
    if status == "quoted" and v["detected_sats"] > 0:
        reached = ORDER["paid"]
    else:
        reached = ORDER.get(status, -1)
    items = "".join(f'<li class="{"done" if i <= reached else ""}">{esc(label)}</li>'
                    for i, (_, label) in enumerate(STEPS))
    return f'<ol class="progress">{items}</ol>'


def order_page(led, token, oid, note=None):
    led.observe()
    v = led.order_view(oid)
    base = f"/o/{token}"
    parts = [f'<h1>Order for {esc(v["handle"])}</h1>',
             f'<p>Status: <b id="status">{esc(v["status"])}</b>'
             + (f' (cancellation <span id="cancellation">{esc(v["cancellation"])}</span>)'
                if v["cancellation"] else "") + "</p>"]
    if note:
        parts.append(f'<p class="box" id="note">{esc(note)}</p>')
    parts.append(f'<p class="muted">Issued to script <code id="script">'
                 f'{esc(v["recipient_script_pubkey"])}</code></p>')
    if v["recipient_rejected"]:
        parts.append("<p>The store can't issue to this request's script. Contact the "
                      "store; no payment instructions are shown.</p>")
    elif v["status"] in ("cancelled", "refund_due") and v["cancellation"] == "final":
        parts.append("<p>This order was cancelled. Anything paid is refunded to the "
                     "address you give below.</p>")
    else:
        parts.append(_progress(v))
    if v["status"] == "requested" and not v["recipient_rejected"]:
        parts.append(f'<form method="post" action="{base}/invoice"><button type="submit">'
                     "Get the invoice</button></form>"
                     '<p class="muted">The invoice holds the name for you for a short '
                     "time.</p>")
    if v["address"]:
        parts.append(_invoice(led, v))
    elif v["address_pending"]:
        parts.append(f'<div id="address_pending"><p>The invoice is being recorded.</p>'
                     f'<form method="post" action="{base}/invoice"><button type="submit">'
                     "Try again</button></form></div>")
    if v["certificate_available"]:
        parts.append(f'<h2>Certificate</h2><p><a id="certificate" href="{base}/certificate">'
                     f"Download the certificate for {esc(v['handle'])}</a>. Verify it in "
                     "your client before relying on it.</p>")
    parts.append("<h2>Refund address</h2>")
    if v["refund_address"]:
        parts.append(f'<p>Refunds go to <code id="refund_address">'
                     f'{esc(v["refund_address"])}</code>.</p>')
    if not any(g["attempts"] for g in v["refunds"]):
        parts.append(f'<form method="post" action="{base}/refund-address">'
                     '<p class="muted">Used only if a refund is due.</p>'
                     '<input name="address" size="64" required> '
                     '<button type="submit">Set the refund address</button></form>')
    for g in v["refunds"]:
        for a in g["attempts"]:
            parts.append(f'<p class="refund" data-txid="{esc(a["txid"])}" '
                         f'data-closed="{str(g["closed"]).lower()}">Refund of '
                         f'{a["to_buyer"]} sats ({a["fee"]} sats fee): '
                         + ("settled" if g["closed"] else
                            "sent" if a["broadcast"] else "prepared") + "</p>")
    parts.append('<p class="muted">Keep this page\'s link private: anyone with it can see '
                 "this order.</p>")
    return page(200, f"Order for {v['handle']}", "".join(parts))


# The invoice. An active payment request (the amount to pay and the BIP21
# link) is shown only while paying can still buy the name: the order is
# quoted, holds the name, its hold hasn't run out, nothing has been
# confirmed yet, and no cancellation is pending. Otherwise the invoice is
# history: what was asked, with a plain statement not to pay it.

HISTORY = {
    "converted": "Paid in full. Don't pay again.",
    "issuing": "Paid in full. Don't pay again.",
    "ready": "Paid in full. Don't pay again.",
    "fulfilled": "Paid in full. Don't pay again.",
    "cancelled": "This order was cancelled. Don't pay this invoice.",
    "refund_due": "A refund is due on this order. Don't pay this invoice.",
    "unpaid": "This invoice expired unpaid. Don't pay it. To buy the name, start a "
              "new order from its page.",
}

# A payment detected earlier that this node no longer sees may have been
# dropped or replaced, or this node may simply have lost it: it can still
# confirm. The page never treats its absence as a reason to pay again.
MISSING = ("A payment to this invoice was detected earlier, and this store's node no "
           "longer sees it. It may have been dropped or replaced, or this node may have "
           "missed it, and it can still confirm. Don't send another payment because of "
           "this page. If it confirms after the hold ends, it is handled as a late "
           "payment.")
UNKNOWN = ("This order was restored after a store outage, and the store can't tell "
           "whether a payment was sent to this invoice before then. Don't pay it. A "
           "payment that was sent shows here once this store's node sees it. If none "
           "did, start a new order from the name's page once this one has ended.")
UNPAID_UNKNOWN = ("This invoice expired. It was restored after a store outage, and the "
                  "store can't tell whether a payment was sent to it; one may still "
                  "confirm, and is then handled as a late payment. Don't pay this "
                  "invoice.")
UNPAID_AFTER_DETECTED = ("This invoice expired without a confirmed payment. A payment "
                         "detected earlier may still confirm; if it does, it is handled as "
                         "a late payment. Don't pay this invoice.")


def active_request(led, v):
    """Only an order known never to have been paid is asked for payment. A
    payment's absence from the node now proves nothing."""
    return (v["status"] == "quoted" and v["cancellation"] is None
            and v["hold_expires_at"] is not None and led.clock() < v["hold_expires_at"]
            and v["detected_sats"] == 0 and v["payment_history"] == "none")


def _quoted_note(v):
    detected, price = v["detected_sats"], v["price_sats"]
    if detected == 0:
        return UNKNOWN if v["payment_history"] == "unknown" else MISSING
    if detected < price:
        return (f"Partial payment detected, awaiting confirmation: {detected} of the "
                f"{price} sats asked. This page doesn't ask for the rest. If the order "
                "isn't paid in full when the hold ends, what confirmed is refunded.")
    return "Payment detected, awaiting confirmation. Don't pay again."


def _invoice(led, v):
    unconfirmed = v["detected_sats"] - v["confirmed_sats"]
    received = (f'<p>Received: <span id="detected_sats">{v["detected_sats"]}</span> sats '
                f'detected (<span id="unconfirmed_sats">{unconfirmed}</span> unconfirmed), '
                f'<span id="confirmed_sats">{v["confirmed_sats"]}</span> confirmed, '
                f'<span id="batchable_sats">{v["batchable_sats"]}</span> at '
                f'3 blocks, <span id="settled_sats">{v["settled_sats"]}</span> at 6. '
                "Only confirmed payments count; the order converts once the full price "
                "has 3 blocks.</p>")
    if active_request(led, v):
        uri = f'bitcoin:{v["address"]}?amount={btc(v["price_sats"])}'
        return (f"""<h2>Invoice</h2><div class="box" id="payment_request">
<p>Pay exactly <b id="amount_btc">{esc(btc(v["price_sats"]))}</b> BTC
(<span id="price_sats">{v["price_sats"]}</span> sats) to</p>
<p><code id="address">{esc(v["address"])}</code></p>
<p><a id="bip21" href="{esc(uri)}">{esc(uri)}</a></p>
<p class="muted">Held for you until <span id="hold_expires_at">{int(v["hold_expires_at"])}</span>
(Unix time). Pay once: a payment you already sent shows here as soon as this
store's node sees it.</p></div>""" + received)
    note = HISTORY.get(v["status"], "This invoice is no longer payable. Don't pay it.")
    if v["status"] == "quoted":
        note = _quoted_note(v)
    elif v["status"] == "unpaid" and v["payment_history"] == "detected":
        note = UNPAID_AFTER_DETECTED
    elif v["status"] == "unpaid" and v["payment_history"] == "unknown":
        note = UNPAID_UNKNOWN
    if v["cancellation"] == "unconfirmed":
        note = "A cancellation of this order is being recorded. Don't pay this invoice."
    return (f"""<h2>Invoice (history)</h2><div class="box" id="invoice_history">
<p id="invoice_note">{esc(note)}</p>
<p class="muted">Asked: <span id="invoice_price_sats">{v["price_sats"]}</span> sats to
<code id="invoice_address">{esc(v["address"])}</code></p></div>""" + received)


# Routing


def _form(body_bytes):
    try:
        fields = parse_qs(body_bytes.decode("utf-8"), keep_blank_values=True,
                          strict_parsing=False, max_num_fields=4)
    except (UnicodeDecodeError, ValueError):
        return None
    if any(len(v) != 1 for v in fields.values()):
        return None
    return {k: v[0] for k, v in fields.items()}


def _check_request(text, page_handle, unique_members, fields, BadRequest):
    """The pasted request, checked as `POST /requests` checks a body before
    any state is read, and for the page's name. Returns the script, or
    raises BadRequest with a fixed message that names no member."""
    try:
        b = json.loads(text, object_pairs_hook=unique_members)
    except BadRequest:
        raise BadRequest("the request repeats a member")
    except ValueError:
        raise BadRequest("the pasted text is not a request")
    if not isinstance(b, dict):
        raise BadRequest("the pasted text is not a request")
    if set(b) != fields:
        raise BadRequest("a request has exactly the members handle and script_pubkey")
    if not all(isinstance(b[k], str) for k in fields):
        raise BadRequest("handle and script_pubkey must be strings")
    if b["handle"] != page_handle:
        raise BadRequest("the request is for another name than this page's")
    return b["script_pubkey"]


def route(service, method, path, read_body):
    """Returns a Response for a checkout path, or None for any other path."""
    from .app import MAX_BODY, REQUEST_FIELDS, BadRequest, _unique_members
    led = service.ledger
    if path == "/" and method == "GET":
        return names_page(led)
    m = re.fullmatch(rf"/buy/{HANDLE_PATH_RE}", path)
    if m:
        handle = m.group(1)
        if method == "GET":
            return buy_page(led, handle)
        if method != "POST":
            return not_found()
        if led.db.execute("select 1 from names where name = ?", (handle,)).fetchone() is None:
            return not_found()
        raw = read_body()
        form = _form(raw) if len(raw) <= MAX_BODY else None
        if form is None or set(form) != {"request"}:
            return refused(400, "Request refused", "the form was not as expected")
        try:
            script = _check_request(form["request"], handle, _unique_members,
                                    REQUEST_FIELDS, BadRequest)
            oid, token = led.request(handle, script)
        except (BadRequest, Invalid) as e:
            return refused(400, "Request refused", str(e))
        except Refused as e:
            return refused(404 if str(e) == "not for sale" else 409, "Request refused", str(e))
        return redirect(f"/o/{token}")
    m = re.fullmatch(rf"/o/{TOKEN_RE}(/[a-z-]+)?", path)
    if not m:
        return None
    token, action = m.group(1), m.group(2)
    try:
        oid = led.order_by_token(token)
    except Refused:
        return not_found()
    base = f"/o/{token}"
    if action is None and method == "GET":
        return order_page(led, token, oid)
    if action == "/invoice" and method == "POST":
        try:
            q = led.quote(oid)
        except Unconfirmed:
            return order_page(led, token, oid, "The invoice couldn't be recorded just now. "
                                                "Try again in a moment.").with_code(503)
        except Refused as e:
            return order_page(led, token, oid, f"No invoice: {e}.").with_code(409)
        if not q["acknowledged"]:
            return order_page(led, token, oid, "The invoice is being recorded. Try again in "
                                                "a moment; no address is shown until "
                                                "then.").with_code(503)
        return redirect(base)
    if action == "/refund-address" and method == "POST":
        raw = read_body()
        form = _form(raw) if len(raw) <= MAX_BODY else None
        if form is None or set(form) != {"address"}:
            return order_page(led, token, oid, "The form was not as expected.").with_code(400)
        try:
            address = form["address"].strip()
            led.set_refund_address(oid, address, service.view.refund_script(address))
        except (Refused, Invalid) as e:
            return order_page(led, token, oid, f"Refund address refused: {e}.").with_code(409)
        return redirect(base)
    if action == "/certificate" and method == "GET":
        cert = led.certificate(oid)
        if cert is None:
            return not_found()
        name = led.order_view(oid)["handle"]
        return Response(200, cert, "application/octet-stream",
                        {"Content-Disposition": f'attachment; filename="{name}.certificate"'})
    return not_found()
