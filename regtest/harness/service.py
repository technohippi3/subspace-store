"""Scenarios 7 and 8: the store service (`service/`) on regtest, run as its
own process and restarted with SIGKILL along the way.

The harness controller, the publication procedure and the model mirror are
the same as in the other scenarios. Only the registry changes: here the
controller and the scenarios reach the real service over HTTP, through
`ServiceRegistry`, and `subs` polls the service's `/pending` with the
registry token. Buyers act through the public request and the private
order link only.

7. A purchase through the service API: request, quote, payment, a restart
   before conversion, conversion, issuance, a restart while `issuing`,
   finality and certificate verification, a restart while ready,
   publication to the local relay and verified delivery, and a restart
   after fulfilment.
8. A cancellation refund: payment, the owner's cancellation, the buyer's
   refund address through the order link, a refund refused until the
   payment settles, a refund built and reserved while the off-host journal
   is down and refused for broadcast until the journal is back, restarts
   before and after the broadcast, and the group closing at settled depth.

Usage: python3 -m regtest.harness.service <run> service_purchase service_refund

Harness code. Results from it are regtest results.
"""

import json
import signal
import sys
import time
from pathlib import Path

from model.chain import Tx

from . import scenarios
from .controller import Controller
from .journal import Journal
from .procs import PORTS, relay_enabled, relay_url
from .registry import Refused
from .rpc import Http, HttpError
from .scenarios import FEE_RATE, SPACE_A, VERIFIER, attempt

ROOT = Path(__file__).resolve().parents[2]


class ServiceProcess:
    """The service as a separate process, under the stack's "registry" name,
    so stopping the stack stops it too."""

    def __init__(self, run):
        self.run = run
        self.dir = run.stack.dir / "service"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.config = self.dir / "config.json"
        self.operator_token_file = self.dir / "operator-token"
        self.journal_dir = run.offhost / "store-service"
        self.starts = 0

    def write_config(self):
        stack = self.run.stack
        self.config.write_text(json.dumps({
            "network": "regtest",
            "listen": {"host": "127.0.0.1", "port": PORTS["registry"]},
            "db": str(self.run.host / "store.db"),
            "journal_dir": str(self.journal_dir),
            "bitcoind": {"url": f"http://127.0.0.1:{PORTS['bitcoind']}",
                         "cookie": str(stack.btc_cookie()), "wallet": "store"},
            "tokens": {"operator": str(self.operator_token_file),
                       "subs": str(stack.dir / "registry-token")},
            "policy": {"hold_minutes": 15, "excess_minimum_over_fee": 546,
                       "refund_fee_sats": 300, "hot_wallet_cap_sats": 100_000},
            "poll_seconds": 1,
        }, indent=1))

    def start(self):
        self.write_config()
        self.starts += 1
        stack = self.run.stack
        p = stack._spawn("registry", [sys.executable, "-m", "service", str(self.config)])
        self.pid = p.pid
        token = None
        deadline = time.time() + 60
        while time.time() < deadline:
            if p.poll() is not None:
                raise RuntimeError(f"service exited with {p.returncode}; see logs/registry.log")
            if self.operator_token_file.exists():
                token = self.operator_token_file.read_text().strip()
                try:
                    status = Http(self.url(), timeout=5, token=token).get("/operator/status")
                    return status
                except Exception:  # noqa: BLE001 - not listening yet
                    pass
            time.sleep(0.3)
        raise TimeoutError("the service did not start")

    def kill(self):
        """A process crash: SIGKILL, no orderly shutdown."""
        import os
        pid = self.run.stack._pid("registry")
        if pid is not None:
            os.kill(pid, signal.SIGKILL)
            deadline = time.time() + 30
            while self.run.stack._alive(pid) and time.time() < deadline:
                time.sleep(0.1)
        (self.run.stack.pids / "registry.pid").unlink(missing_ok=True)

    def restart(self):
        before = self.run.stack._pid("registry")
        self.kill()
        status = self.start()
        return {"killed_pid": before, "new_pid": self.run.stack._pid("registry"),
                "startup": status["startup"], "journal_backlog": status["journal_backlog"]}

    def url(self):
        return f"http://127.0.0.1:{PORTS['registry']}"


class ServiceRegistry:
    """The harness registry's interface, served by the real service over
    HTTP. Buyer calls use the public request and the order link only."""

    def __init__(self, run):
        self.run = run
        self.process = ServiceProcess(run)
        self.links = {}  # oid -> order link token, as the buyer holds it
        # The coordinated snapshot records the store journal's position.
        self.journal = Journal(self.process.journal_dir, "store")
        self._db = None

    @property
    def db(self):
        """A read-only connection to the service's database, for the
        controller's coordinated snapshot (SQLite's online backup, which is
        consistent while the service keeps writing in WAL mode)."""
        if self._db is None:
            import sqlite3
            path = self.run.host / "store.db"
            self._db = sqlite3.connect(f"file:{path}?mode=ro", uri=True,
                                       check_same_thread=False)
            self._db.row_factory = sqlite3.Row
        return self._db

    # Plumbing

    def _op(self):
        token = self.process.operator_token_file.read_text().strip()
        return Http(self.process.url(), timeout=120, token=token)

    def _public(self):
        return Http(self.process.url(), timeout=120)

    def _call(self, http, method, path, body=None):
        try:
            return http.request(method, path, body)
        except HttpError as e:
            if e.status in (404, 409):
                try:
                    raise Refused(json.loads(e.body)["error"])
                except (ValueError, KeyError):
                    raise Refused(e.body)
            raise

    def op(self, method, path, body=None):
        return self._call(self._op(), method, path, body)

    def buyer(self, oid, method, action="", body=None):
        return self._call(self._public(), method, f"/orders/{self.links[oid]}{action}", body)

    def serve(self, port):
        assert port == PORTS["registry"]
        self.process.start()

    def shutdown(self):
        self.run.stack.stop_process("registry")

    # Owner and buyer

    def list_name(self, name, price):
        self.op("POST", "/operator/names", {"handle": name, "price": price})

    def request(self, handle, recipient_spk):
        before = set(self.op("GET", "/operator/orders")["orders"])
        out = self._call(self._public(), "POST", "/requests",
                         {"handle": handle, "script_pubkey": recipient_spk})
        new = sorted(set(self.op("GET", "/operator/orders")["orders"]) - before,
                     key=lambda o: int(o[1:]))
        oid = new[-1]
        self.links[oid] = out["token"]
        return oid

    def quote(self, oid):
        return self.buyer(oid, "POST", "/quote")

    def buyer_view(self, oid):
        return self.buyer(oid, "GET")

    def set_refund_address(self, oid, address):
        return self.buyer(oid, "POST", "/refund-address", {"address": address})

    # Store state

    def order(self, oid):
        o = self.op("GET", f"/operator/orders/{oid}")
        o["pay_address"] = o.get("dest_address")
        return o

    def observe(self):
        self.op("POST", "/operator/observe")

    def converted_orders(self):
        self.observe()
        return self.op("GET", "/operator/orders?status=converted")["orders"]

    def batch_entry_ok(self, oid):
        return self.op("POST", f"/operator/orders/{oid}/batch-entry")["batch_entry"]

    def issuing_recheck_ok(self, oid):
        return self.op("POST", f"/operator/orders/{oid}/batch-entry")["issuing_recheck"]

    def mark_issuing(self, oids):
        return self.op("POST", "/operator/issuing", {"oids": list(oids)})["acknowledged"]

    def acknowledged_status(self, oid):
        return self.order(oid)["journaled_status"]

    def journal_ok(self, oid):
        return self.op("POST", f"/operator/orders/{oid}/journal")["acknowledged"]

    def _transition(self, oid, action):
        self.op("POST", f"/operator/orders/{oid}/transition", {"action": action})

    def unissue(self, oid):
        self._transition(oid, "unissue")

    def restore_issuing(self, oid):
        self._transition(oid, "restore_issuing")

    def unready(self, oid):
        self._transition(oid, "unready")

    def mark_ready(self, oid):
        self._transition(oid, "mark_ready")

    def mark_fulfilled(self, oid):
        self._transition(oid, "mark_fulfilled")

    def cancel(self, oid):
        self.op("POST", f"/operator/orders/{oid}/cancel")

    def set_pending(self, oids):
        self.op("POST", "/operator/pending", {"oids": list(oids)})

    # Refunds

    def refund(self, oid, kind):
        return self.op("POST", f"/operator/orders/{oid}/refunds", {"kind": kind})

    def broadcast(self, gid, txid=None):
        return self.op("POST", f"/operator/refunds/{gid}/broadcast", {"txid": txid})


class ServiceRun(scenarios.Run):
    def _open_host(self):
        token_file = self.stack.dir / "registry-token"
        if not token_file.exists():
            import secrets
            token_file.write_text(secrets.token_hex(24))
            token_file.chmod(0o600)
        self.token = token_file.read_text().strip()
        self.store_journal = Journal(self.offhost, "store")
        self.controller_journal = Journal(self.offhost, "controller")
        self.registry = ServiceRegistry(self)
        self.controller = Controller(self.host / "controller.db", self.controller_journal,
                                     self.registry, self.stack, VERIFIER, self.stack.dir / "certs")


def _restart(run, scen, why):
    out = run.registry.process.restart()
    run.report.step(scen, None, f"service restart (SIGKILL) {why}", out, required=False,
                    note="the service's own durable state is all it restarts from")
    return out


def _compare_view(run, scen, what, oid, space, extra=None):
    """The buyer's order-link view against the model."""
    m = run.mirror(space)
    v = run.registry.buyer_view(oid)
    mo = m.sim.store.orders[oid]
    st = m.sim.store
    got = {"status": v["status"], "price_sats": v["price_sats"],
           "batchable_sats": v["batchable_sats"], "settled_sats": v["settled_sats"],
           "handle": v["handle"]}
    exp = {"status": mo.status, "price_sats": mo.price,
           "batchable_sats": st.sum_at(mo, 3), "settled_sats": st.sum_at(mo, 6),
           "handle": mo.name}
    if extra:
        got.update(extra[0])
        exp.update(extra[1])
    return run.report.step(scen, None, what, got, exp, match=got == exp)


def service_purchase(run):
    from .publication import Publisher, _publish_and_deliver, _subs_seed_line
    scen = "7. purchase through the store service"
    r, c, reg = run.report, run.controller, run.registry
    m = run.mirror(SPACE_A)
    oid, _ = run.buy(scen, SPACE_A, "one")
    other = reg.request("one" + SPACE_A, run.buyer_script())
    ok, why = attempt(reg.quote, other)
    mok, mwhy = m.quote(other, "one" + SPACE_A)
    r.step(scen, "Q1", "second quote for the held name", {"quoted": ok, "why": why},
           {"quoted": mok, "why": mwhy}, match=ok == mok)
    run.mine(1)
    m.mine(1)
    run.compare_orders(scen, None, "payment at 1 conf", [oid], SPACE_A)
    _restart(run, scen, "with the payment at 1 conf, before conversion")
    run.compare_orders(scen, None, "after the restart: still quoted, the hold kept", [oid], SPACE_A)
    run.mine(2)
    m.mine(2)
    run.compare_orders(scen, "P1", "payment at 3 conf converts the hold", [oid], SPACE_A)
    _compare_view(run, scen, "the order link shows the conversion", oid, SPACE_A)
    bid, mbid = run.prepare(scen, SPACE_A, [oid])
    c.issue(bid, FEE_RATE)
    m.step("check_and_issue", mbid, "ok")
    b = c.batch(bid)
    run.compare_orders(scen, "B3", "binding check passes; members issuing", b["members"], SPACE_A)
    run.compare_batch(scen, "B3", f"{bid} broadcast", bid, {"txid": b["txid"]})
    ok, why = attempt(reg.cancel, oid)
    mok, mwhy = m.cancel(oid)
    r.step(scen, "X3", "cancellation after issuing", {"cancelled": ok, "why": why},
           {"cancelled": mok, "why": mwhy}, match=ok == mok)
    _restart(run, scen, "while the member is issuing")
    run.compare_orders(scen, None, "after the restart: still issuing", [oid], SPACE_A)
    run.finalize(scen, bid, SPACE_A)
    run.certify(scen, bid, SPACE_A)
    _restart(run, scen, "while the member is ready")
    run.compare_orders(scen, None, "after the restart: still ready", [oid], SPACE_A)

    if not relay_enabled():
        raise RuntimeError("service_purchase needs SUBSPACE_RELAY=1 and the subs build with "
                           "upstream/subs-fabric-seed.patch; see regtest/run-service.sh")
    seeds = _subs_seed_line(run.stack)
    r.step(scen, None, "isolation: subs seeds its fabric client with the local relay only",
           {"subs_fabric_seeds": seeds, "relay": relay_url()}, required=False)
    if seeds != relay_url():
        raise RuntimeError(f"refusing to publish: subs fabric seeds {seeds!r}")
    p = Publisher(run)
    _publish_and_deliver(run, p, scen, bid)
    _restart(run, scen, "after fulfilment")
    run.compare_orders(scen, None, "after the restart: still fulfilled", [oid], SPACE_A)
    _compare_view(run, scen, "the order link shows the fulfilment", oid, SPACE_A)


def service_refund(run):
    scen = "8. cancellation refund through the store service"
    r, reg = run.report, run.registry
    m = run.mirror(SPACE_A)
    st = m.sim.store
    oid, _ = run.buy(scen, SPACE_A, "two")
    run.mine(3)
    m.mine(3)
    run.compare_orders(scen, "P1", "payment at 3 conf converts the hold", [oid], SPACE_A)
    ok, why = attempt(reg.cancel, oid)
    mok, mwhy = m.cancel(oid)
    r.step(scen, None, "the owner cancels before issuing", {"cancelled": ok, "why": why},
           {"cancelled": mok, "why": mwhy}, match=ok == mok)
    run.compare_orders(scen, None, "cancelled; the name is free again", [oid], SPACE_A)
    buyer = run.stack.btc("buyer")
    refund_address = buyer.call("getnewaddress", "refund", "bech32m")
    refund_spk = buyer.call("getaddressinfo", refund_address)["scriptPubKey"]
    reg.set_refund_address(oid, refund_address)
    pay_txid = f"t-{oid}"

    def model_group(gid, txid, to_buyer, fee):
        tx = Tx(txid, ((pay_txid, 0),), (("buyer-refund", to_buyer),))
        return m._try("store", "open_group", gid, oid, "cancellation", tx, to_buyer, fee)

    # N2: nothing is refundable until the payment settles.
    ok, why = attempt(reg.refund, oid, "cancellation")
    mok, mwhy = model_group("gm0", "am0", 10_000 - 300, 300)
    r.step(scen, "N2", "cancellation refund at 3 conf", {"built": ok, "why": why},
           {"built": mok, "why": mwhy}, match=ok == mok)
    run.mine(3)
    m.mine(3)
    # The off-host journal is down while the refund is built: the
    # reservation is made, the attempt isn't acknowledged, and nothing may
    # leave the store.
    journal = Journal(run.registry.process.journal_dir, "store")
    journal.set_down(True)
    m.set_offhost(False, "store")
    built = reg.refund(oid, "cancellation")
    gid, txid = built["gid"], built["txid"]
    mok, mwhy = model_group(gid, txid, built["to_buyer"], 300)
    o = reg.order(oid)
    mo = st.orders[oid]
    got = {"built": True, "to_buyer": built["to_buyer"], "charged": built["charged"],
           "reserved": o["reserved"], "available": o["available"]}
    exp = {"built": mok, "to_buyer": 9_700, "charged": 10_000, "reserved": st.reserved(mo),
           "available": st.available(mo)}
    r.step(scen, "N2", "cancellation refund once settled: 9,700 to the buyer, 300 fee, "
           "10,000 reserved", dict(got, fee=built["fee"], txid=txid), exp,
           match=got == exp)
    ok, why = attempt(reg.broadcast, gid, txid)
    mok, mwhy = m._try("store", "broadcast", gid, txid)
    r.step(scen, "J5", "broadcast while the journal entry is unacknowledged",
           {"sent": ok, "why": why}, {"sent": mok, "why": mwhy}, match=ok == mok)
    _restart(run, scen, "with the refund built, reserved and unsent")
    journal.set_down(False)
    m.set_offhost(True, "store")
    reg.observe()
    m.sim.do("store", "observe")
    in_mempool = txid in run.stack.btc().call("getrawmempool")
    r.step(scen, None, "nothing was sent before the journal acknowledged it",
           {"in_mempool": in_mempool}, {"in_mempool": False}, match=not in_mempool)
    ok, sent = attempt(reg.broadcast, gid, txid)
    mok, mwhy = m._try("store", "broadcast", gid, txid)
    r.step(scen, "J5", "broadcast once the journal entry is acknowledged",
           {"sent": ok, "answer": sent}, {"sent": mok, "why": mwhy if not mok else ""},
           match=ok == mok and ok and sent["acknowledged"])
    restart = _restart(run, scen, "with the refund in the mempool")
    r.step(scen, None, "after the restart: the attempt is found in the mempool, not resent",
           {"rebroadcast": restart["startup"]["rebroadcast"],
            "in_mempool": txid in run.stack.btc().call("getrawmempool")},
           {"rebroadcast": [], "in_mempool": True},
           match=restart["startup"]["rebroadcast"] == []
           and txid in run.stack.btc().call("getrawmempool"))
    run.mine(5)
    m.mine(5)
    o = reg.order(oid)
    g = o["groups"][0]
    mg = st.groups[gid]
    got = {"closed": bool(g["closed_by"]), "reserved": o["reserved"],
           "refunded_total": o["refunded_total"]}
    exp = {"closed": bool(mg.closed_by), "reserved": st.reserved(mo),
           "refunded_total": st.refunded_total(mo)}
    r.step(scen, None, "refund at 5 conf: the group stays open", got, exp, match=got == exp)
    run.mine(1)
    m.mine(1)
    o = reg.order(oid)
    g = o["groups"][0]
    got = {"closed": bool(g["closed_by"]), "reserved": o["reserved"],
           "refunded_total": o["refunded_total"], "available": o["available"]}
    exp = {"closed": bool(mg.closed_by), "reserved": st.reserved(mo),
           "refunded_total": st.refunded_total(mo), "available": st.available(mo)}
    r.step(scen, None, "refund at 6 conf closes the group: 10,000 refunded", got, exp,
           match=got == exp)
    tx = buyer.call("gettransaction", txid)
    received = sum(int(round(d["amount"] * 1e8)) for d in tx["details"]
                   if d["category"] == "receive" and d["address"] == refund_address)
    decoded = run.stack.btc().call("getrawtransaction", txid, True)
    r.step(scen, None, "the buyer's wallet received 9,700 at the address it gave",
           {"received": received, "confirmations": tx["confirmations"],
            "pays_refund_script": any(v["scriptPubKey"]["hex"] == refund_spk
                                      for v in decoded["vout"])},
           {"received": 9_700, "confirmations": 6, "pays_refund_script": True},
           match=received == 9_700 and tx["confirmations"] == 6)
    _compare_view(run, scen, "the order link shows the closed refund", oid, SPACE_A,
                  ({"refund_closed": run.registry.buyer_view(oid)["refunds"][0]["closed"]},
                   {"refund_closed": bool(mg.closed_by)}))


def main(argv):
    scenarios.Run = ServiceRun
    scenarios.service_purchase = service_purchase
    scenarios.service_refund = service_refund
    return scenarios.main(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
