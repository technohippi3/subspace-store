"""Time the store's replay from its journal on a generated journal.

The operator gate records how long the store's replay from its off-host
journal takes, with the history it was measured on (CONTROLLER-DESIGN.md,
"Operator gate rehearsal"). A rehearsal's few orders can't show whether a
whole sales period replays fast enough, so this builds a journal of the
requested size and times `python3 -m service restore` on it, the command
the rehearsal runs on regtest.

The journal is generated, and every result is labelled so. It is written
by the service's own ledger (`service/ledger.py`) over the model's simulated
chain (`model/chain.py`), so every entry is a record state the store really
writes. To keep generation linear, each evaluation steps only the orders in
flight in the current wave; orders closed in earlier waves aren't evaluated
again, which changes none of their records. The chain view indexes
outputs by script, which returns what the model chain's own scan returns. Nothing is random: which orders
are paid, expire, are cancelled and refunded, or raise an alert follows
from their index.

Each order: a name listed, a recipient request, a quote, then one of
- paid, converted, issuing, ready and fulfilled;
- unpaid, its hold ending;
- paid, cancelled, and refunded from a hot-wallet refund group that
  settles;
and a share of the issued ones get an owner alert from subs' staging
outcome and stay issuing. The sales period an order count stands for is the caller's
assumption, stated in the output.

Usage:
    python3 tools/replay_timing.py --orders 1000 [--wave 25] [--period "..."]

Prints one JSON object.
"""

import argparse
import hashlib
import itertools
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from model.chain import Chain, Tx  # noqa: E402
from service.journal import Journal  # noqa: E402
from service.ledger import Ledger, Policy, valid_p2tr  # noqa: E402

PRICE, FEE = 10_000, 300
SPACE = "@generated"


def p2tr(seed):
    """A distinct P2TR script with a valid key, from a counter: no randomness."""
    for i in itertools.count():
        script = "5120" + hashlib.sha256(f"{seed}/{i}".encode()).hexdigest()
        if valid_p2tr(script):
            return script


class SimulatedChainView:
    """The ledger's chain view over the model's simulated chain, acting as
    the node too: a refund it sends goes to the simulated mempool."""

    def __init__(self, chain):
        self.chain = chain
        self.n = 0
        self.by_script = {}  # script -> txids paying it, in the order added

    def add(self, tx):
        """A transaction reaches the simulated network; indexed by the
        scripts it pays, so that a lookup doesn't scan the whole chain."""
        self.chain.add(tx)
        for spk, _ in tx.outputs:
            txids = self.by_script.setdefault(spk, [])
            if tx.txid not in txids:
                txids.append(tx.txid)

    def refresh(self):
        pass

    @property
    def tip(self):
        return self.chain.tip

    def outputs_to(self, script):
        """What `Chain.outputs_to` returns, from the index: every output
        paying `script`, mined or in the mempool."""
        found = []
        for txid in self.by_script.get(script, ()):
            if self.chain.position(txid) is None and not self.chain.in_mempool(txid):
                continue
            for vout, (spk, value) in enumerate(self.chain.txs[txid].outputs):
                if spk == script:
                    found.append({"outpoint": (txid, vout), "value": value,
                                  "conf": self.chain.conf(txid)})
        return found

    def conf(self, txid):
        return self.chain.conf(txid)

    def position(self, txid):
        return self.chain.position(txid)

    def in_mempool(self, txid):
        return self.chain.in_mempool(txid)

    def spender(self, outpoint):
        return self.chain.spender(tuple(outpoint))

    @staticmethod
    def _tx(d):
        return Tx(d["txid"], tuple(tuple(i) for i in d["inputs"]),
                  tuple(tuple(o) for o in d["outputs"]))

    def exclusive(self, a, b):
        return self.chain.exclusive(self._tx(a), self._tx(b))

    def new_destination(self, oid):
        self.n += 1
        return f"generated-dest-{self.n}", p2tr(f"dest-{self.n}")

    def refund_script(self, address):
        return "0014" + hashlib.sha256(address.encode()).hexdigest()[:40]

    def send(self, tx):
        try:
            self.add(self._tx(tx))
        except Exception:  # noqa: BLE001 - already known, as a node answers
            pass


class WaveLedger(Ledger):
    """The service's ledger, evaluating only the orders in the current wave
    (and their refund groups). Every write and journal entry is the
    ledger's own."""

    active = None

    def observe(self):
        if self.active is None:
            return super().observe()
        self.chain.refresh()
        with self.tx():
            self.record_payment_outputs_of(self.active)
            for oid in sorted(self.active, key=lambda o: int(o[1:])):
                self._step_order(oid)
            for oid in sorted(self.active, key=lambda o: int(o[1:])):
                for g in self._groups_of(oid):
                    self._step_group(g["gid"])
                self._reasons(oid)
        self.flush_journal()

    def record_payment_outputs_of(self, oids):
        for oid in oids:
            o = self._order(oid)
            if not o["dest_script"]:
                continue
            found = self.chain.outputs_to(o["dest_script"])
            for x in found:
                self.db.execute("insert or ignore into payment_outputs values (?, ?, ?, ?)",
                                (x["outpoint"][0], x["outpoint"][1], oid, x["value"]))
            if found and o["payment_history"] != "detected":
                self._set_order(oid, payment_history="detected")


def mine(chain, n):
    for _ in range(n):
        chain.mine()


def generate(directory, orders, wave, cancel_every, expire_every, alert_every):
    chain = Chain()
    view = SimulatedChainView(chain)
    now = [0.0]
    journal = Journal(directory / "journal")
    led = WaveLedger(directory / "built.db", view, journal, Policy(), clock=lambda: now[0])
    counts = {"fulfilled": 0, "expired": 0, "refunded": 0, "alerts": 0}  # alerted: issuing
    for start in range(0, orders, wave):
        idx = list(range(start, min(start + wave, orders)))
        oids = {}
        for i in idx:
            handle = f"n{i}{SPACE}"
            led.list_name(handle, PRICE)
            oid, _ = led.request(handle, p2tr(f"buyer-{i}"))
            oids[i] = oid
        led.active = set(oids.values())
        for i, oid in oids.items():
            led.quote(oid)
        expiring = [i for i in idx if i % expire_every == expire_every - 1]
        paying = [i for i in idx if i not in expiring]
        for i in paying:
            o = led.operator_view(oids[i])
            view.add(Tx(f"pay-{i}", ((f"coin-{i}", 0),), ((o["dest_script"], PRICE),)))
        mine(chain, 3)
        led.observe()
        now[0] += 16 * 60
        led.observe()
        counts["expired"] += len(expiring)
        cancelled = [i for i in paying if i % cancel_every == 0]
        for i in cancelled:
            oid = oids[i]
            led.cancel(oid)
            led.set_refund_address(oid, f"generated-refund-{i}",
                                   view.refund_script(f"generated-refund-{i}"))
        mine(chain, 3)
        for i in cancelled:
            oid = oids[i]
            payment = led.outputs(oid)[0]["outpoint"]
            tx = {"txid": f"refund-{i}", "inputs": [tuple(payment)],
                  "outputs": [(led.operator_view(oid)["refund_spk"], PRICE - FEE)],
                  "raw": "02" + f"refund-{i}".encode().hex()}
            gid = f"g{i}"
            led.open_group(gid, oid, "cancellation", tx, PRICE - FEE, FEE)
            led.broadcast(gid, tx["txid"])
        mine(chain, 6)
        led.observe()
        counts["refunded"] += len(cancelled)
        issued = [oids[i] for i in paying if i not in cancelled]
        if issued:
            led.mark_issuing_all(issued)
            # subs' staging outcome for a share of them: the owner is alerted.
            noted = [i for i in paying if i not in cancelled and i % alert_every == 1]
            if noted:
                led.subs_ack([{"handle": f"n{i}{SPACE}",
                               "outcome": "already_staged_different_spk"} for i in noted])
                counts["alerts"] += len(noted)
            else:
                noted = []
            # An alerted order waits for the owner, issuing; the rest are
            # delivered.
            delivered = [oid for oid in issued if oid not in {oids[i] for i in noted}]
            for oid in delivered:
                led.mark_ready(oid)
            for oid in delivered:
                led.mark_fulfilled(oid)
            counts["fulfilled"] += len(delivered)
        now[0] += 60
    led.active = None
    tables = {t: led.db.execute(f"select count(*) from {t}").fetchone()[0]
              for t in ("names", "orders", "groups", "attempts", "alerts", "authorizations")}
    backlog = led.db.execute("select count(*) from journal_backlog").fetchone()[0]
    led.close()
    if backlog:
        raise RuntimeError(f"{backlog} records never reached the journal")
    return journal, counts, tables


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--orders", type=int, default=1000)
    ap.add_argument("--wave", type=int, default=25)
    ap.add_argument("--cancel-every", type=int, default=20, help="every n-th paid order")
    ap.add_argument("--expire-every", type=int, default=10, help="every n-th order expires")
    ap.add_argument("--alert-every", type=int, default=50)
    ap.add_argument("--period", default="unstated",
                    help="the sales period this order count stands for: an assumption")
    args = ap.parse_args(argv)
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        t = time.time()
        journal, counts, tables = generate(d, args.orders, args.wave, args.cancel_every,
                                           args.expire_every, args.alert_every)
        built = round(time.time() - t, 2)
        config = d / "config.json"
        config.write_text(json.dumps({"network": "regtest", "db": str(d / "restored.db"),
                                      "journal_dir": str(journal.dir)}))
        t = time.time()
        p = subprocess.run([sys.executable, "-m", "service", "restore", str(config)], cwd=ROOT,
                           capture_output=True, text=True, timeout=7200)
        replay = round(time.time() - t, 3)
        if p.returncode != 0:
            raise SystemExit(f"restore failed: {p.stderr}")
        db = __import__("sqlite3").connect(d / "restored.db")
        restored = {t: db.execute(f"select count(*) from {t}").fetchone()[0] for t in tables}
        db.close()
        out = {
            "label": "generated journal, not regtest, not a real sales history",
            "sales_period_assumed": args.period,
            "generated_by": "service/ledger.py over model/chain.py (tools/replay_timing.py)",
            "orders": args.orders, "outcomes": counts,
            "journal": {"entries": len(journal.entries()),
                        "bytes": journal.path.stat().st_size},
            "records_built": tables, "records_restored": restored,
            "seconds": {"generation": built,
                        "replay (python3 -m service restore)": replay},
            "python": sys.version.split()[0],
        }
    if restored != tables:
        raise SystemExit(f"restored records differ: {restored} != {tables}")
    print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
