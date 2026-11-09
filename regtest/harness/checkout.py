"""Scenario 10: the checkout pages and the attended runner on regtest
(PAYMENT-SPEC.md, "Checkout and the attended runner").

The store service runs as its own process, as in scenarios 7 and 8. The
buyer uses only the checkout pages, over HTTP, with a regtest wallet
standing in for the buyer's client: the request pasted on a name's page is
in the public request format a Nacho export has, made from that wallet's
script. Every operator step after listing the name is a command of the
attended runner (`python3 -m runner`), run as its own process with no
terminal, with its own controller database and journal. The harness only
lists names, mines blocks (time passing) and reads the chain.

10a. A purchase: the names page, the request pasted on the name's page, the
     invoice with its BIP21 URI, payment of that URI's amount, conversion at
     3 blocks, `prepare`, `issue` refused without its confirmation and then
     confirmed, finality, `certify` delivering the verified certificate to
     the order page, the buyer's download verified independently with
     libveritas, and `publish` with delivery confirmed by a verified lookup
     through the local relay.
10b. A cancellation and refund: a paid order cancelled by `cancel`, the
     buyer's refund address given on the order page, `refund` refused until
     the payment settles and then built, `broadcast-refund` refused without
     its confirmation and then confirmed, and the refund settled at 6
     blocks, seen on the order page and in the buyer's wallet.

Usage: python3 -m regtest.harness.checkout <run> checkout_purchase checkout_refund

Harness code. Results from it are regtest results.
"""

import http.client
import json
import re
import subprocess
import sys
import time
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlencode

from . import scenarios
from .procs import PORTS, relay_enabled, relay_url
from .service import ServiceRun
from .scenarios import PRICE, SPACE_A, VERIFIER

ROOT = Path(__file__).resolve().parents[2]
EXPECT = "expected (checkout and runner rules, not the model)"


class Buyer:
    """The buyer: the checkout pages over HTTP, without following redirects."""

    def __init__(self, port):
        self.port = port

    def http(self, method, path, form=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        body = urlencode(form).encode() if form is not None else None
        headers = {"Content-Type": "application/x-www-form-urlencoded"} if form is not None else {}
        conn.request(method, path, body=body, headers=headers)
        r = conn.getresponse()
        out = (r.status, {k.lower(): v for k, v in r.getheaders()}, r.read())
        conn.close()
        return out

    def page(self, path):
        status, headers, body = self.http("GET", path)
        return status, body.decode()

    @staticmethod
    def find(text, element_id):
        m = re.search(rf'id="{element_id}"[^>]*>([^<]*)<', text)
        return m.group(1) if m else None


class RunnerCli:
    """The attended runner as the operator runs it: one process per
    command, no terminal, so a send without --confirm is refused."""

    def __init__(self, run):
        self.run = run
        proc = run.registry.process
        self.config = run.stack.dir / "runner.json"
        self.config.write_text(json.dumps({
            "network": "regtest",
            "store": {"url": proc.url(), "operator_token_file": str(proc.operator_token_file),
                      "db": str(run.host / "store.db"), "journal_dir": str(proc.journal_dir)},
            "controller": {"dir": str(run.stack.dir / "runner"),
                           "journal_dir": str(run.offhost), "journal_name": "runner"},
            "verifier": str(VERIFIER),
            "regtest_run": run.stack.run,
        }, indent=1))
        self.log = run.stack.logs / "runner.log"

    def __call__(self, *args):
        argv = [sys.executable, "-m", "runner", str(self.config), *args]
        p = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True,
                           stdin=subprocess.DEVNULL, timeout=7200)
        with open(self.log, "a") as f:
            f.write(f"$ runner {' '.join(args)}\nexit {p.returncode}\n{p.stdout}{p.stderr}\n")
        try:
            out = json.loads(p.stdout)
        except ValueError:
            out = {"error": f"no JSON output; exit {p.returncode}: {p.stderr[-400:]}"}
        return p.returncode, out


def _oid_for(run, handle, status):
    """The operator finds the order by its handle among orders of a status."""
    for oid in run.registry.op("GET", f"/operator/orders?status={status}")["orders"]:
        if run.registry.order(oid)["name"] == handle:
            return oid
    return None


def _buy_through_pages(run, scen, buyer, handle):
    """Names page, request pasted on the name's page, invoice, payment of the
    BIP21 amount. Returns (order page path, oid, buyer script)."""
    r = run.report
    status, names = buyer.page("/")
    avail = dict(re.findall(r'data-handle="([^"]+)" data-available="(true|false)"', names))
    r.step(scen, "C1", f"the names page lists {handle} as available",
           {"status": status, "available": avail.get(handle)},
           {EXPECT: {"status": 200, "available": "true"}},
           match=status == 200 and avail.get(handle) == "true")
    spk = run.buyer_script()
    request = json.dumps({"handle": handle, "script_pubkey": spk})
    status, headers, _ = buyer.http("POST", f"/buy/{handle}", form={"request": request})
    path = headers.get("location", "")
    ok = status == 303 and re.fullmatch(r"/o/[A-Za-z0-9_-]{16,64}", path) is not None
    r.step(scen, "C2", f"the request for {handle} pasted on its page",
           {"status": status, "redirects_to_order_page": ok},
           {EXPECT: {"status": 303, "redirects_to_order_page": True}}, match=ok,
           note="a regtest wallet's script stands in for the buyer's client")
    oid = _oid_for(run, handle, "requested")
    run.registry.links[oid] = path.rsplit("/", 1)[1]
    status, headers, _ = buyer.http("POST", path + "/invoice")
    _, page = buyer.page(path)
    address = buyer.find(page, "address")
    bip21 = buyer.find(page, "bip21")
    want = run.registry.order(oid)["dest_address"]
    btc_amount = Decimal(PRICE) / Decimal(100_000_000)
    expected_uri = f"bitcoin:{want}?amount={format(btc_amount.normalize(), 'f')}"
    got = {"invoice_status": status, "status": buyer.find(page, "status"),
           "address_is_the_order's": address == want, "bip21": bip21,
           "price_sats": buyer.find(page, "price_sats")}
    exp = {"invoice_status": 303, "status": "quoted", "address_is_the_order's": True,
           "bip21": expected_uri, "price_sats": str(PRICE)}
    r.step(scen, "C4", "the invoice on the order page", got, {EXPECT: exp}, match=got == exp)
    m = re.fullmatch(r"bitcoin:([a-z0-9]+)\?amount=([0-9.]+)", bip21 or "")
    txid = run.stack.btc("buyer").call("sendtoaddress", m.group(1), float(Decimal(m.group(2))))
    r.step(scen, None, "the buyer pays the BIP21 URI's address and amount",
           {"txid": txid, "address": m.group(1), "amount_btc": m.group(2)}, required=False)
    run.mine(3)
    _, page = buyer.page(path)
    got = {"status": buyer.find(page, "status"), "batchable_sats": buyer.find(page, "batchable_sats"),
           "asks_for_payment": "bitcoin:" in page or "Pay exactly" in page}
    exp = {"status": "converted", "batchable_sats": str(PRICE), "asks_for_payment": False}
    r.step(scen, "C11", "the order page after 3 blocks: paid, and no longer asking for payment",
           got, {EXPECT: exp}, match=got == exp)
    return path, oid, spk


def _runner_step(run, scen, case, what, result, expect, check):
    code, out = result
    run.report.step(scen, case, what, {"exit": code, "output": out}, {EXPECT: expect},
                    match=bool(check(code, out)))
    return out


def checkout_purchase(run):
    scen = "10a. purchase through the checkout pages and the runner"
    r, reg = run.report, run.registry
    buyer, runner = Buyer(PORTS["registry"]), RunnerCli(run)
    handle = "one" + SPACE_A
    reg.list_name(handle, PRICE)
    r.step(scen, None, f"the operator lists {handle} at {PRICE} sats", {"listed": True},
           required=False, note="through the operator API; the runner has no listing command")
    path, oid, spk = _buy_through_pages(run, scen, buyer, handle)

    prep = _runner_step(run, scen, None, "runner prepare: freeze, stage, local commit, prove, "
                        "checkpoint", runner("prepare", SPACE_A),
                        {"exit": 0, "state": "checkpointed", "members": [oid]},
                        lambda c, o: c == 0 and o.get("state") == "checkpointed"
                        and o.get("members") == [oid])
    bid = prep.get("bid")
    _runner_step(run, scen, "A1", "runner issue without the confirmation", runner("issue", bid),
                 {"exit": 3, "refused": "nothing was sent"},
                 lambda c, o: c == 3 and "nothing was sent" in o.get("refused", ""))
    still = reg.order(oid)["status"]
    r.step(scen, "A1", "after the refused issue", {"order": still},
           {EXPECT: {"order": "converted"}}, match=still == "converted")
    issued = _runner_step(run, scen, "A4", "runner issue with the batch id confirmed",
                          runner("issue", bid, "--confirm", bid),
                          {"exit": 0, "state": "broadcast", "txid": "set"},
                          lambda c, o: c == 0 and o.get("state") == "broadcast" and o.get("txid"))
    in_mempool = issued.get("txid") in run.stack.btc().call("getrawmempool")
    _, page = buyer.page(path)
    got = {"page_status": buyer.find(page, "status"), "in_mempool": in_mempool}
    r.step(scen, None, "the commitment is in the mempool and the page shows issuing", got,
           {EXPECT: {"page_status": "issuing", "in_mempool": True}},
           match=got == {"page_status": "issuing", "in_mempool": True})

    run.mine(1)
    _runner_step(run, scen, None, "runner watch at d = 0", runner("watch", bid),
                 {"state": "mined"}, lambda c, o: c == 0 and o.get("state") == "mined")
    run.mine(149)
    _runner_step(run, scen, None, "runner watch at d = 149", runner("watch", bid),
                 {"state": "mined"}, lambda c, o: c == 0 and o.get("state") == "mined")
    run.mine(1)
    w = _runner_step(run, scen, None, "runner watch at d = 150", runner("watch", bid),
                     {"state": "final"}, lambda c, o: c == 0 and o.get("state") == "final")
    if w.get("certificate_status") == "awaiting_anchor":
        b_height = run.controller.tip() - 150  # d = tip - mined height = 150
        target = -(-(b_height + 144) // 36) * 36
        n = max(0, target - run.controller.tip())
        if n:
            run.mine(n)
        deadline = time.time() + 120
        while run.controller.root_anchors()[0]["block"]["height"] < target \
                and time.time() < deadline:
            time.sleep(0.5)
        r.step(scen, None, f"mined {n} blocks to the root anchor at {target}",
               {"newest_anchor": run.controller.root_anchors()[0]["block"]["height"]},
               required=False)
    cert = _runner_step(run, scen, "A3", "runner certify: verified with libveritas and "
                        "delivered to the order page", runner("certify", bid),
                        {"exit": 0, "verified": True, "delivered": True},
                        lambda c, o: c == 0 and o.get("members", {}).get(oid, {}).get("verified")
                        and o["members"][oid]["delivered"])
    _, page = buyer.page(path)
    status, headers, body = buyer.http("GET", path + "/certificate")
    got = {"page_status": buyer.find(page, "status"),
           "download_offered": 'id="certificate"' in page, "download_status": status,
           "content_type": headers.get("content-type"), "bytes": len(body)}
    r.step(scen, "C7", "the order page offers the certificate, and serves it", got,
           {EXPECT: {"page_status": "ready", "download_offered": True, "download_status": 200,
                     "content_type": "application/octet-stream"}},
           match=got["page_status"] == "ready" and got["download_offered"]
           and status == 200 and len(body) > 0)
    # The buyer verifies the download without trusting the store: root
    # anchors read from spaced directly, libveritas, and the buyer's own
    # script.
    vdir = run.stack.dir / "buyer-verification"
    vdir.mkdir(exist_ok=True)
    (vdir / f"{handle}.certificate").write_bytes(body)
    (vdir / "anchors.json").write_text(json.dumps(run.controller.root_anchors()))
    proc = subprocess.run([str(VERIFIER), str(vdir / f"{handle}.certificate"),
                           str(vdir / "anchors.json")], capture_output=True, text=True)
    (vdir / f"{handle}.libveritas.json").write_text(proc.stdout + proc.stderr)
    res = json.loads(proc.stdout) if proc.stdout.strip().startswith("{") else {}
    zone = next((z for z in res.get("zones", []) if z["handle"] == handle), None)
    got = {"verified": res.get("verified", False), "handle": zone is not None,
           "script_pubkey_is_the_buyer's": bool(zone and zone["script_pubkey"] == spk),
           "sovereign": bool(zone and zone["sovereignty"] == "sovereign")}
    exp = {"verified": True, "handle": True, "script_pubkey_is_the_buyer's": True,
           "sovereign": True}
    r.step(scen, None, "the buyer's download verified with libveritas against anchors read "
           "from spaced", got, {EXPECT: exp}, match=got == exp)

    if not relay_enabled():
        raise RuntimeError("checkout_purchase needs SUBSPACE_RELAY=1 and the subs build with "
                           "upstream/subs-fabric-seed.patch; see regtest/run-checkout.sh")
    from .publication import _subs_seed_line
    seeds = _subs_seed_line(run.stack)
    r.step(scen, None, "isolation: subs seeds its fabric client with the local relay only",
           {"subs_fabric_seeds": seeds, "relay": relay_url()}, required=False)
    if seeds != relay_url():
        raise RuntimeError(f"refusing to publish: subs fabric seeds {seeds!r}")
    pub = _runner_step(run, scen, None, "runner publish: delivery confirmed by a verified "
                       "lookup through the relay", runner("publish", bid),
                       {"exit": 0, "confirmed": True, "outstanding": []},
                       lambda c, o: c == 0 and o.get("delivery", {}).get(oid, {}).get("confirmed")
                       and o.get("outstanding") == [])
    _, page = buyer.page(path)
    status, _, again = buyer.http("GET", path + "/certificate")
    got = {"page_status": buyer.find(page, "status"), "download_status": status,
           "same_bytes": again == body}
    r.step(scen, None, "the order page after delivery", got,
           {EXPECT: {"page_status": "fulfilled", "download_status": 200, "same_bytes": True}},
           match=got == {"page_status": "fulfilled", "download_status": 200, "same_bytes": True})


def checkout_refund(run):
    scen = "10b. cancellation and refund through the checkout pages and the runner"
    r, reg = run.report, run.registry
    buyer, runner = Buyer(PORTS["registry"]), RunnerCli(run)
    handle = "two" + SPACE_A
    reg.list_name(handle, PRICE)
    path, oid, _ = _buy_through_pages(run, scen, buyer, handle)
    _runner_step(run, scen, None, "runner cancel", runner("cancel", oid),
                 {"exit": 0, "cancellation": "final"},
                 lambda c, o: c == 0 and o.get("cancellation") == "final")
    _, page = buyer.page(path)
    got = {"status": buyer.find(page, "status"), "cancellation": buyer.find(page, "cancellation"),
           "asks_for_payment": "bitcoin:" in page or "Pay exactly" in page}
    exp = {"status": "cancelled", "cancellation": "final", "asks_for_payment": False}
    r.step(scen, "C11", "the order page shows the cancellation and asks for no payment", got,
           {EXPECT: exp}, match=got == exp)
    wallet = run.stack.btc("buyer")
    refund_address = wallet.call("getnewaddress", "refund", "bech32m")
    status, _, _ = buyer.http("POST", path + "/refund-address", form={"address": refund_address})
    _, page = buyer.page(path)
    got = {"status": status, "shown": buyer.find(page, "refund_address")}
    r.step(scen, None, "the buyer gives the refund address on the order page", got,
           {EXPECT: {"status": 303, "shown": refund_address}},
           match=got == {"status": 303, "shown": refund_address})
    _runner_step(run, scen, "N2", "runner refund at 3 blocks: nothing refundable yet",
                 runner("refund", oid), {"exit": 1, "error": "nothing refundable"},
                 lambda c, o: c != 0 and "refundable" in o.get("error", ""))
    run.mine(3)
    built = _runner_step(run, scen, "N2", "runner refund once the payment settled",
                         runner("refund", oid), {"exit": 0, "to_buyer": PRICE - 300, "fee": 300},
                         lambda c, o: c == 0 and o.get("to_buyer") == PRICE - 300)
    gid, txid = built.get("gid"), built.get("txid")
    _runner_step(run, scen, "A2", "runner broadcast-refund without the confirmation",
                 runner("broadcast-refund", gid), {"exit": 3, "refused": "nothing was sent"},
                 lambda c, o: c == 3 and "nothing was sent" in o.get("refused", ""))
    in_mempool = txid in run.stack.btc().call("getrawmempool")
    r.step(scen, "A2", "nothing sent after the refused broadcast", {"in_mempool": in_mempool},
           {EXPECT: {"in_mempool": False}}, match=not in_mempool)
    _runner_step(run, scen, "A5", "runner broadcast-refund with the group id confirmed",
                 runner("broadcast-refund", gid, "--confirm", gid),
                 {"exit": 0, "acknowledged": True},
                 lambda c, o: c == 0 and o.get("acknowledged") is True)
    run.mine(6)
    _, page = buyer.page(path)
    closed = re.search(rf'data-txid="{re.escape(txid or "")}" data-closed="(true|false)"', page)
    tx = wallet.call("gettransaction", txid)
    received = sum(int(round(d["amount"] * 1e8)) for d in tx["details"]
                   if d["category"] == "receive" and d["address"] == refund_address)
    got = {"page_shows_settled": bool(closed and closed.group(1) == "true"),
           "received": received, "confirmations": tx["confirmations"]}
    exp = {"page_shows_settled": True, "received": PRICE - 300, "confirmations": 6}
    r.step(scen, None, "the refund at 6 blocks: settled on the page, received by the buyer",
           got, {EXPECT: exp}, match=got == exp)


def main(argv):
    scenarios.Run = ServiceRun
    scenarios.checkout_purchase = checkout_purchase
    scenarios.checkout_refund = checkout_refund
    return scenarios.main(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
