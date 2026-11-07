"""Regtest scenarios, run in order on one local regtest network.

Usage: python3 -m regtest.harness.scenarios <run> <scenario>...

Scenarios: first_purchase, second_commitment, restore, lost_broadcast.
`all` runs them in that order. Each one records its steps in
.run/<run>/report.json and report.md, labelled "regtest".
"""

import json
import secrets
import shutil
import sqlite3
import sys
import time
from pathlib import Path

from . import compare
from .controller import Controller, Refused as CRefused
from .journal import Journal
from .oracle import Mirror
from .procs import CACHE, HERE, OPERATOR_WALLET, PORTS, PRESET, Stack, subs_bin
from .registry import Refused as RRefused, Registry
from .report import Report

PRICE = 10_000  # sats
FEE_RATE = 1  # sat/vB, passed to subs' /broadcast
SPACED_FEE_RATE = 250  # sat/kwu, for setup calls straight to spaced
SPACE_A = "@test10000"
SPACE_B = "@test9999"
VERIFIER = HERE / "verifier" / "target" / "release" / "subspace-regtest-verifier"
REFUSED = (CRefused, RRefused)


def attempt(fn, *args, **kwargs):
    """(ok, value or refusal text)."""
    try:
        return True, fn(*args, **kwargs)
    except REFUSED as e:
        return False, str(e)


class Run:
    def __init__(self, name):
        self.stack = Stack(name)
        self.host = self.stack.dir / "host"
        self.offhost = self.stack.dir / "offhost"
        self.report = Report(self.stack.dir / "report.json")
        self.mirrors = {}
        self.bids = {}  # regtest bid -> (space, model bid)

    # Setup

    def start(self):
        fresh = not self.stack.dir.exists()
        if fresh:
            self.stack.init()
        self.stack.start_bitcoind()
        self.stack.start_spaced()
        self.stack.start_proxies()
        self.stack.start_prover()
        self.host.mkdir(exist_ok=True)
        self._open_host()
        if fresh:
            self._setup_chain()
        self.stack.start_subs()
        if fresh:
            self._setup_subs()
        self.registry.serve(PORTS["registry"])

    def _open_host(self):
        token_file = self.stack.dir / "registry-token"
        if not token_file.exists():
            token_file.write_text(secrets.token_hex(24))
            token_file.chmod(0o600)
        self.token = token_file.read_text().strip()
        self.store_journal = Journal(self.offhost, "store")
        self.controller_journal = Journal(self.offhost, "controller")
        self.registry = Registry(self.host / "registry.db", self.store_journal,
                                 self.stack.btc("store"), self.stack.btc(), self.token)
        self.controller = Controller(self.host / "controller.db", self.controller_journal,
                                     self.registry, self.stack, VERIFIER, self.stack.dir / "certs")

    def _setup_chain(self):
        btc = self.stack.btc()
        for w in ("miner", "buyer", "store"):
            btc.call("createwallet", w)
        # The preset chain is past the point where regtest block subsidies are
        # worth anything, so the buyer is funded from the preset's own
        # regtest wallet, an upstream test fixture.
        btc.call("loadwallet", "default")
        buyer = self.stack.btc("buyer").call("getnewaddress", "", "bech32m")
        self.stack.btc("default").call("sendtoaddress", buyer, 1.0)
        self.mine(1)
        sp = self.stack.spaced()
        self.controller.wait_synced(timeout=1800)
        export = json.loads((PRESET / "wallets" / f"{OPERATOR_WALLET}.json").read_text())
        sp.call("walletimport", export)
        self._wait_wallet()
        for space in (SPACE_A, SPACE_B):
            r = sp.call("walletsendrequest", OPERATOR_WALLET, {
                "requests": [{"request": "operate", "subject": space}],
                "fee_rate": SPACED_FEE_RATE, "dust": None, "force": False,
                "confirmed_only": False, "skip_tx_check": False})
            if any(t.get("error") for t in r["result"]):
                raise RuntimeError(f"operate {space}: {r}")
            self.mine(6)

    def _wait_wallet(self, timeout=1800):
        deadline = time.time() + timeout
        sp = self.stack.spaced()
        while time.time() < deadline:
            info = sp.call("walletgetinfo", OPERATOR_WALLET)
            if info.get("tip") == self.controller.tip() and \
                    sp.call("walletlistspaces", OPERATOR_WALLET)["owned"]:
                return
            time.sleep(2)
        raise TimeoutError("operator wallet did not sync")

    def _setup_subs(self):
        subs = self.stack.subs()
        subs.post("/config", {
            "prover_endpoint": f"http://127.0.0.1:{PORTS['prover']}",
            "registry_endpoint": f"http://127.0.0.1:{PORTS['registry']}",
            "registry_auth_token": self.token,
            "registry_auto_sync": False,
        })
        for space in (SPACE_A, SPACE_B):
            subs.post(f"/spaces/{space}/operate")

    def stop(self):
        self.registry.shutdown()
        self.stack.stop_all()

    # Chain helpers

    def mine(self, n, to="miner"):
        w = self.stack.btc(to)
        addr = w.call("getnewaddress", "", "bech32m")
        self.stack.btc().call("generatetoaddress", n, addr)
        self.controller.wait_synced()

    def buyer_script(self):
        b = self.stack.btc("buyer")
        addr = b.call("getnewaddress", "", "bech32m")
        return b.call("getaddressinfo", addr)["scriptPubKey"]

    def pay(self, address, sats):
        return self.stack.btc("buyer").call("sendtoaddress", address, sats / 1e8)

    def mirror(self, space):
        if space not in self.mirrors:
            self.mirrors[space] = Mirror(PRICE, self.controller.tip())
        return self.mirrors[space]

    # Shared steps

    def buy(self, scen, space, label, case="P1"):
        """Request, quote and pay for `label@space`; return the order id once
        it has converted at three confirmations."""
        m = self.mirror(space)
        handle = f"{label}{space}"
        self.registry.list_name(handle, PRICE)
        m.list_name(handle)
        spk = self.buyer_script()
        oid = self.registry.request(handle, spk)
        self.report.step(scen, None, f"recipient request for {handle}",
                         {"oid": oid, "script_pubkey": spk})
        q = self.registry.quote(oid)
        mq = m.quote(oid, handle)
        got = {"quoted": True, "status": self.registry.order(oid)["status"],
               "price_sats": q["price_sats"], "address": q["address"]}
        exp = {"quoted": mq[0], "status": m.order_status(oid) if mq[0] else None,
               "price": PRICE}
        self.report.step(scen, None, f"fixed-price quote for {oid}", got, exp,
                         match=compare.same_quote(got, exp))
        txid = self.pay(q["address"], q["price_sats"])
        m.pay(oid, PRICE)
        return oid, txid

    def prepare(self, scen, space, members=None):
        bid, mbid = self.freeze_and_stage(scen, space, members)
        return self.commit_prove_checkpoint(scen, bid, mbid)

    def freeze_and_stage(self, scen, space, members=None):
        c, m = self.controller, self.mirror(space)
        bid = c.freeze(space, members)
        ok, mbid = m.freeze(members)
        self.bids[bid] = (space, mbid)
        b = c.batch(bid)
        got = {"members": b["members"], "state": b["state"]}
        exp = {"ok": ok, "members": m.batch_members(mbid) if ok else None,
               "state": m.batch_state(mbid) if ok else None, "refusal": None if ok else mbid}
        self.report.step(scen, None, f"freeze {bid}", got, exp,
                         match=compare.same_freeze(got, exp))
        st = c.stage(bid)
        self.report.step(scen, None, f"stage {bid} with readback",
                         {"staged": st["staged"], "parked": st["parked"],
                          "sync": st["sync"]})
        return bid, mbid

    def commit_prove_checkpoint(self, scen, bid, mbid):
        c = self.controller
        m = self.mirror(self.bids[bid][0])
        cl = c.commit_local(bid)
        m.step("commit_local", mbid)
        got = {"state": c.batch(bid)["state"], "root": cl["root"], "prev_root": cl["prev_root"],
               "is_initial": cl["is_initial"], "handles": cl["handles_committed"],
               "members_on_root": cl["members_on_root"]}
        exp = {"state": m.batch_state(mbid), "members": m.batch_members(mbid)}
        self.report.step(scen, None, f"local commit {bid} with readback", got, exp,
                         match=compare.same_local_commit(got, exp))
        return self.finish_preparation(scen, bid, mbid, cl)

    def finish_preparation(self, scen, bid, mbid, _committed):
        c = self.controller
        m = self.mirror(self.bids[bid][0])
        pr = c.prove(bid)
        m.step("prove", mbid)
        self.report.step(scen, None, f"prove {bid}", pr, {"state": m.batch_state(mbid)},
                         match=c.batch(bid)["state"] == m.batch_state(mbid))
        cp = c.checkpoint(bid)
        m.step("checkpoint", mbid)
        self.report.step(scen, None, f"checkpoint {bid} (coordinated snapshot)", cp,
                         {"state": m.batch_state(mbid)},
                         match=c.batch(bid)["state"] == m.batch_state(mbid))
        return bid, mbid

    def compare_orders(self, scen, case, what, oids, space):
        m = self.mirror(space)
        self.registry.observe()
        got = {o: self.registry.order(o)["status"] for o in oids}
        exp = {o: m.order_status(o) for o in oids}
        return self.report.step(scen, case, what, got, exp, match=got == exp)

    def compare_batch(self, scen, case, what, bid, extra=None):
        space, mbid = self.bids[bid]
        got = self.controller.batch(bid)["state"]
        exp = self.mirror(space).batch_state(mbid)
        regtest = {"state": got}
        regtest.update(extra or {})
        return self.report.step(scen, case, what, regtest, {"state": exp}, match=got == exp)

    def finalize(self, scen, bid, space):
        """Mine the commitment, then to d = 149 (not final) and d = 150."""
        m = self.mirror(space)
        self.mine(1)
        m.mine(1)
        self.controller.watch(bid)
        self.compare_batch(scen, None, f"{bid} mined at d = 0", bid,
                           {"position": self.controller.tx_position(self.controller.batch(bid)["txid"])})
        self.mine(149)
        m.mine(149)
        self.controller.watch(bid)
        self.compare_batch(scen, None, f"{bid} at d = 149", bid)
        self.mine(1)
        m.mine(1)
        self.controller.watch(bid)
        return self.compare_batch(scen, None, f"{bid} at d = 150", bid,
                                  {"subs_commit_status": self.stack.subs().get(
                                      f"/spaces/{space}/commit/status")})

    def _record_certs(self, scen, bid, res, notified, again=False):
        self.report.step(scen, None, f"certificates for {bid} verified with libveritas"
                         + (" (again)" if again else ""),
                         {"notify": notified,
                          "results": {o: {"ok": r["ok"], "checks": r["checks"], "error": r["error"],
                                          "zone": r["zone"], "space_zone": r.get("space_zone")}
                                      for o, r in res.items()}},
                         match=all(r["ok"] for r in res.values()))

    def certify(self, scen, bid, space):
        b = self.controller.batch(bid)
        try:
            self.stack.subs().post("/registry/notify", {"space": space, "root": b["root"]})
            notified = True
        except Exception as e:  # noqa: BLE001 - recorded
            notified = str(e)
        # L6: ready needs d >= 150 and a root anchor 144 past the
        # commitment (R11). In between the certificate is awaiting its anchor,
        # which is waiting, not a failed verification.
        m = self.mirror(space)
        members = b["members"]
        status = self.controller.certificate_status(bid)
        mstatus = m.certificate_status(members[0])
        self.report.step(scen, "L6", f"certificate status for {bid} at d = "
                         f"{self.controller.tip() - b['mined_height']}",
                         {"status": status, "newest_anchor":
                          self.controller.root_anchors()[0]["block"]["height"],
                          "mined_height": b["mined_height"]},
                         {"status": mstatus}, match=status == mstatus)
        if status == "awaiting_anchor":
            ok, why = attempt(self.controller.verify_certificates, bid)
            mstatus = m.certificate_status(members[0])
            self.report.step(scen, "L6", "verification refused while awaiting the anchor",
                             {"verified": ok, "why": why if not ok else ""},
                             {"verified": compare.verification_allowed(mstatus), "status": mstatus},
                             match=compare.same_verification(ok, mstatus))
            self.compare_orders(scen, "L6", f"{bid} members while awaiting the anchor", members, space)
            target = -(-(b["mined_height"] + 144) // 36) * 36
            n = max(0, target - self.controller.tip())
            if n:
                self.mine(n)
                m.mine(n)
            self.controller.watch(bid)
            # spaced reports the new tip before it has computed that block's
            # anchor, so wait for the anchor itself.
            waited, deadline = 0.0, time.time() + 120
            while self.controller.root_anchors()[0]["block"]["height"] < target \
                    and time.time() < deadline:
                time.sleep(0.5)
                waited += 0.5
            status = self.controller.certificate_status(bid)
            mstatus = m.certificate_status(members[0])
            self.report.step(scen, "L6", f"certificate status after mining {n} blocks to the anchor at {target}",
                             {"status": status, "seconds_waited_for_anchor_after_tip": waited},
                             {"status": mstatus}, match=status == mstatus)
        res = self.controller.verify_certificates(bid)
        self._record_certs(scen, bid, res, notified)
        self.compare_orders(scen, None, f"{bid} members after verification", b["members"], space)
        return res


# Scenarios

def first_purchase(run):
    scen = "1. first purchase"
    r, c, reg = run.report, run.controller, run.registry
    m = run.mirror(SPACE_A)
    oid, txid = run.buy(scen, SPACE_A, "one")
    # Q1: a second buyer asking for the held name gets no quote.
    other = reg.request("one" + SPACE_A, run.buyer_script())
    ok, why = attempt(reg.quote, other)
    mok, mwhy = m.quote(other, "one" + SPACE_A)
    r.step(scen, "Q1", "second quote for the held name", {"quoted": ok, "why": why},
           {"quoted": mok, "why": mwhy}, match=ok == mok)
    run.mine(1)
    m.mine(1)
    run.compare_orders(scen, None, "payment at 1 conf", [oid], SPACE_A)
    run.mine(2)
    m.mine(2)
    run.compare_orders(scen, "P1", "payment at 3 conf converts the hold", [oid], SPACE_A)
    bid, mbid = run.prepare(scen, SPACE_A, [oid])
    issued = c.issue(bid, FEE_RATE)
    m.step("check_and_issue", mbid, "ok")
    b = c.batch(bid)
    run.compare_orders(scen, "B3", "binding check passes; members issuing", b["members"], SPACE_A)
    run.compare_batch(scen, "B3", f"{bid} broadcast", bid, {"txid": b["txid"]})
    ok, why = attempt(reg.cancel, oid)
    mok, mwhy = m.cancel(oid)
    r.step(scen, "X3", "cancellation after issuing", {"cancelled": ok, "why": why},
           {"cancelled": mok, "why": mwhy}, match=ok == mok)
    run.finalize(scen, bid, SPACE_A)
    run.certify(scen, bid, SPACE_A)

    # L1 and L2. A reorg that takes the final commitment off the best chain:
    # the block carrying it is invalidated and a longer replacement chain is
    # mined while the node keeps the commitment transaction out of its
    # blocks. Then the commitment is mined again at d = 0, below d >= 150,
    # and finally reaches d >= 150 again.
    btc = run.stack.btc()
    b = c.batch(bid)
    commit_block = btc.call("getblockhash", b["mined_height"])
    depth = c.tip() - b["mined_height"] + 1
    btc.call("invalidateblock", commit_block)
    btc.call("prioritisetransaction", b["txid"], 0, -100_000_000)
    run.mine(depth + 1)
    m.reorg(depth, depth + 1)
    c.watch(bid)
    run.compare_batch(scen, "L1", f"{bid} after a {depth}-block reorg drops the commitment", bid,
                      {"in_mempool": b["txid"] in btc.call("getrawmempool"),
                       "getcommitment": c.onchain_commitment(SPACE_A),
                       "subs_commit_status": run.stack.subs().get(f"/spaces/{SPACE_A}/commit/status")})
    run.compare_orders(scen, "L1", "members while finality is lost", [oid], SPACE_A)
    ok, why = attempt(reg.cancel, oid)
    mok, mwhy = m.cancel(oid)
    r.step(scen, "L1", "cancellation while finality is lost", {"cancelled": ok, "why": why},
           {"cancelled": mok, "why": mwhy}, match=ok == mok)
    ok, why = attempt(c.verify_certificates, bid)
    mstatus = m.certificate_status(oid)
    r.step(scen, "L1", "certificate verification while not final",
           {"allowed": ok, "why": why if not ok else ""},
           {"allowed": compare.verification_allowed(mstatus), "status": mstatus},
           match=compare.same_verification(ok, mstatus))
    btc.call("prioritisetransaction", b["txid"], 0, 100_000_000)
    in_pool = b["txid"] in btc.call("getrawmempool")
    r.step(scen, "L7", "commitment in the node's mempool after the reorg",
           {"in_mempool": in_pool, "testmempoolaccept": btc.call(
               "testmempoolaccept", [btc.call("getrawtransaction", b["txid"])])[0]["allowed"]},
           required=False,
           note="Bitcoin Core 26.0 did not return the disconnected commitment to its mempool "
                "after invalidateblock (R10)")
    mtx = f"commit-{run.bids[bid][1]}"
    if not in_pool and m.sim.chain.in_mempool(mtx):
        m.drop(mtx)  # the model's node loses it too, as the regtest node did
    ok, why = attempt(c.retry_broadcast, bid)
    mok, mwhy = m.step("retry_broadcast", run.bids[bid][1])
    r.step(scen, "L7", "/broadcast again after the reorg", {"allowed": ok, "why": why},
           {"allowed": mok, "why": mwhy}, match=ok == mok)
    ok, val = attempt(c.rebroadcast_commitment, bid)
    mok, mval = m.step("rebroadcast_commitment", run.bids[bid][1])
    r.step(scen, "L7", "rebroadcast the identical journaled bytes",
           {"sent": ok, "result": val, "in_mempool": b["txid"] in btc.call("getrawmempool"),
            "raw_journaled": bool(c.acknowledged(bid).get("raw"))},
           {"sent": mok, "why": mval if not mok else ""}, match=ok == mok)
    ok, why = attempt(c.rebroadcast_commitment, bid)
    mok, mwhy = m.step("rebroadcast_commitment", run.bids[bid][1])
    r.step(scen, "L7", "a second rebroadcast while it is in the mempool", {"sent": ok, "why": why},
           {"sent": mok, "why": mwhy}, match=ok == mok)
    run.mine(1)
    m.mine(1)
    c.watch(bid)
    run.compare_batch(scen, "L1", f"{bid} mined again at d = 0", bid,
                      {"position": c.tx_position(b["txid"])})
    run.mine(150)
    m.mine(150)
    c.watch(bid)
    run.compare_batch(scen, "L2", f"{bid} back at d >= 150", bid,
                      {"subs_commit_status": run.stack.subs().get(f"/spaces/{SPACE_A}/commit/status")})
    run.certify(scen, bid, SPACE_A)
    return bid


def second_commitment(run):
    scen = "2. second commitment with a proof"
    r, c, reg = run.report, run.controller, run.registry
    m = run.mirror(SPACE_A)
    oids = []
    for label in ("two", "three", "four"):
        oid, _ = run.buy(scen, SPACE_A, label)
        oids.append(oid)
    run.mine(3)
    m.mine(3)
    run.compare_orders(scen, "P1", "three payments at 3 conf", oids, SPACE_A)
    two, three, four = oids
    bid, mbid = run.prepare(scen, SPACE_A, [two, three])
    # B6: no second batch while this one is open.
    ok, why = attempt(c.freeze, SPACE_A, [four])
    mok, mwhy = m.freeze([four])
    r.step(scen, "B6", "freeze a second batch while one is open", {"frozen": ok, "why": why},
           {"frozen": mok, "why": mwhy}, match=ok == mok)
    # J3: the store's journal is down when the batch is marked issuing.
    run.store_journal.set_down(True)
    m.set_offhost(False, "store")
    ok, why = attempt(c.issue, bid, FEE_RATE)
    mok, mwhy = m.step("check_and_issue", mbid, "ok")
    r.step(scen, "J3", "issue with the store journal down", {"sent": ok, "why": why},
           {"sent": mok, "why": mwhy}, match=ok == mok)
    run.compare_batch(scen, "J3", f"{bid} waits in issuing", bid,
                      {"mempool_spends": c.mempool_spend_with_root(c.batch(bid)["delegate_in"], c.batch(bid)["root"])})
    run.compare_orders(scen, "J3", "members while the journal is down", [two, three], SPACE_A)
    ok, why = attempt(c.resume, bid)
    mok, mwhy = m.step("resume", mbid)
    r.step(scen, "J3", "resume while the journal is still down", {"sent": ok, "why": why},
           {"sent": mok, "why": mwhy}, match=ok == mok)
    run.store_journal.set_down(False)
    m.set_offhost(True, "store")
    ok, why = attempt(c.resume, bid)
    mok, mwhy = m.step("resume", mbid)
    b = c.batch(bid)
    r.step(scen, "J3", "resume after both journals acknowledge", {"sent": ok, "txid": b["txid"]},
           {"sent": mok}, match=ok == mok)
    run.compare_batch(scen, "J3", f"{bid} broadcast once", bid,
                      {"wallet_spends_of_delegate": c.wallet_spend_with_root(b["delegate_in"], b["root"])})
    run.finalize(scen, bid, SPACE_A)
    run.certify(scen, bid, SPACE_A)
    return four


def restore(run):
    scen = "3. host loss and restore"
    r, c = run.report, run.controller
    m = run.mirror(SPACE_A)
    four = next(o for o in run.registry.converted_orders())
    bid, mbid = run.prepare(scen, SPACE_A, [four])
    snapshot = sorted((run.offhost / "snapshots").iterdir())[-1]
    c.issue(bid, FEE_RATE)
    m.step("check_and_issue", mbid, "ok")
    run.compare_batch(scen, "B3", f"{bid} broadcast", bid, {"txid": c.batch(bid)["txid"]})
    run.mine(1)
    m.mine(1)
    c.watch(bid)
    run.compare_batch(scen, None, f"{bid} mined before the host is lost", bid)
    # Host loss: the host's databases and the subs data directory go. The
    # off-host journals and snapshots stay, and so do bitcoind and spaced,
    # which stand in for the network and for the operator wallet restored
    # from its onboarding backup.
    run.registry.shutdown()
    run.stack.stop_process("subs")
    shutil.rmtree(run.host)
    shutil.rmtree(run.stack.subs_dir)
    m.host_loss()
    r.step(scen, None, "host lost", {"kept": ["offhost journals", "snapshots", "bitcoind", "spaced"],
                                     "snapshot": snapshot.name})
    shutil.copytree(snapshot / "subs", run.stack.subs_dir)
    run.host.mkdir()
    for name in ("registry.db", "controller.db"):
        shutil.copy(snapshot / name, run.host / name)
    run._open_host()
    c = run.controller
    run.registry.restore_from_journal()
    run.stack.start_subs()
    log = c.restore_from_journal()
    c.watch(bid)
    run.registry.serve(PORTS["registry"])
    r.step(scen, "J4", "reconcile the restored snapshot against both journals", {"log": log})
    run.compare_batch(scen, None, f"{bid} after restore", bid)
    run.compare_orders(scen, "J4", "members after restore", [four], SPACE_A)
    ok, why = attempt(run.registry.cancel, four)
    mok, mwhy = m.cancel(four)
    r.step(scen, "J4", "cancellation after restore", {"cancelled": ok, "why": why},
           {"cancelled": mok, "why": mwhy}, match=ok == mok)
    subs = run.stack.subs()
    chain = c.onchain_commitment(SPACE_A)
    pipe = subs.get(f"/spaces/{SPACE_A}/pipeline")
    status = subs.get(f"/spaces/{SPACE_A}/commit/status")
    try:
        dry = subs.post(f"/spaces/{SPACE_A}/commit", {"dry_run": True})
    except Exception as e:  # noqa: BLE001 - recorded
        dry = str(e)
    r.step(scen, None, "restored subs against the chain",
           {"subs_root": pipe.get("root"), "subs_txid": pipe.get("txid"),
            "chain_root": chain and chain.get("state_root"), "commit_status": status,
            "current_step": pipe.get("current_step"), "message": pipe.get("message"),
            "next_local_commit_dry_run": dry},
           {"root_matches_chain": True},
           match=bool(chain) and pipe.get("root") == chain.get("state_root"))
    run.finalize(scen, bid, SPACE_A)
    run.certify(scen, bid, SPACE_A)
    names = [h["name"] for h in c.handles(SPACE_A, "committed")]
    r.step(scen, None, "no name committed twice", {"committed": sorted(names)},
           {"unique": True}, match=len(names) == len(set(names)))


def lost_broadcast(run):
    scen = "4. lost broadcast response"
    r, c, reg = run.report, run.controller, run.registry
    m = run.mirror(SPACE_B)
    oid, _ = run.buy(scen, SPACE_B, "five")
    run.mine(3)
    m.mine(3)
    run.compare_orders(scen, "P1", "payment at 3 conf", [oid], SPACE_B)
    bid, mbid = run.prepare(scen, SPACE_B, [oid])
    ctl = run.stack.dir / "spaced_proxy.ctl"
    ctl.write_text(json.dumps({"drop_response": "walletsendrequest", "count": 1}))
    c.issue(bid, FEE_RATE)
    m.step("check_and_issue", mbid, "lost")
    b = c.batch(bid)
    proxy = run.stack.subs().__class__(f"http://127.0.0.1:{PORTS['spaced_proxy']}").get("/__proxy__")
    run.compare_batch(scen, "X4", f"{bid} after spaced's answer to subs was lost", bid,
                      {"subs_answer": b["answer"],
                       "dropped_upstream": [d["upstream_response"][:300] for d in proxy["dropped"]]})
    for what, call, mcall in (
            ("cancellation", lambda: reg.cancel(oid), lambda: m.cancel(oid)),
            ("retry the broadcast", lambda: c.retry_broadcast(bid), lambda: m.step("retry_broadcast", mbid)),
            ("roll back locally", lambda: c.rollback_local(bid), lambda: m.step("rollback_local", mbid))):
        ok, why = attempt(call)
        mok, mwhy = mcall()
        r.step(scen, "X4", f"{what} while uncertain", {"allowed": ok, "why": why},
               {"allowed": mok, "why": mwhy}, match=ok == mok)
    subs = run.stack.subs()
    r.step(scen, None, "subs' own view of the uncertain commitment",
           {"commit_status": subs.get(f"/spaces/{SPACE_B}/commit/status"),
            "pipeline_txid": subs.get(f"/spaces/{SPACE_B}/pipeline").get("txid")})
    rb = c.readback(bid)
    mok, mval = m.step("readback", mbid)
    r.step(scen, None, "readback from the wallet, the mempool and the chain",
           {"adopted": rb["adopted"], "txid": rb.get("txid"),
            "mempool": rb["evidence"]["mempool"], "wallet": rb["evidence"]["wallet"],
            "getcommitment": rb["evidence"]["getcommitment"]},
           {"adopted": mval}, match=rb["adopted"] == bool(mval))
    run.compare_batch(scen, None, f"{bid} after readback", bid)
    run.finalize(scen, bid, SPACE_B)
    try:
        dry = subs.post(f"/spaces/{SPACE_B}/commit", {"dry_run": True})
    except Exception as e:  # noqa: BLE001 - recorded
        dry = str(e)
    r.step(scen, None, "subs after the adopted commitment is final",
           {"commit_status": subs.get(f"/spaces/{SPACE_B}/commit/status"),
            "next_local_commit_dry_run": dry})
    run.certify(scen, bid, SPACE_B)
    # U1(b): can subs start the next commitment of this space while its last
    # one has no txid in subs? Stage a member for real, then ask for a dry
    # run of the local commit.
    nxt, _ = run.buy(scen, SPACE_B, "six")
    run.mine(3)
    m.mine(3)
    nb = c.freeze(SPACE_B, [nxt])
    c.stage(nb)
    try:
        dry = subs.post(f"/spaces/{SPACE_B}/commit", {"dry_run": True})
    except Exception as e:  # noqa: BLE001 - recorded
        dry = str(e)
    r.step(scen, "U1(b)", "next local commit while subs has no txid for the last one",
           {"staged": True, "dry_run": dry,
            "commit_status": subs.get(f"/spaces/{SPACE_B}/commit/status")}, required=False)


def attempt_upstream(fn, *args, **kwargs):
    """Like `attempt`, but an HTTP refusal from subs also counts as a refusal."""
    from .rpc import HttpError
    try:
        return True, fn(*args, **kwargs)
    except REFUSED + (HttpError,) as e:
        return False, str(e)


def continued_operation(run):
    """After the restore, the last commitment of the first space (a later
    commitment, after the first) is final, and the controller adopted its
    txid, but subs holds none. Issue another batch from there: the test of
    whether recovery restores continued operation. Runs after `restore`."""
    scen = "5. continued operation after recovery"
    r, c = run.report, run.controller
    m = run.mirror(SPACE_A)
    subs = run.stack.subs()
    # Each space has its own model mirror, and blocks mined while another
    # space's scenario ran weren't mirrored here. Bring this mirror's chain to
    # the real tip first, so depths and root anchors line up again.
    behind = c.tip() - m.sim.chain.tip
    if behind > 0:
        m.mine(behind)
    r.step(scen, None, f"model mirror of {SPACE_A} at the real tip",
           {"tip": c.tip(), "mirror_was_behind_by": behind}, {"tip": m.sim.chain.tip},
           match=c.tip() == m.sim.chain.tip)
    last = [bid for bid, (space, _) in run.bids.items() if space == SPACE_A][-1]
    lb = c.batch(last)
    pipe = subs.get(f"/spaces/{SPACE_A}/pipeline")
    r.step(scen, "R13", f"subs' view of {last} before the next batch",
           {"subs_commitment_idx": pipe.get("commitment_idx"), "subs_txid": pipe.get("txid"),
            "subs_current_step": pipe.get("current_step"),
            "subs_commit_status": subs.get(f"/spaces/{SPACE_A}/commit/status"),
            "controller_state": lb["state"], "controller_txid": lb["txid"]})
    oid, _ = run.buy(scen, SPACE_A, "seven")
    run.mine(3)
    m.mine(3)
    run.compare_orders(scen, "P1", "payment at 3 conf", [oid], SPACE_A)
    # Recovery, U1(b): tell subs the txid the controller adopted. First, txids
    # that didn't make this space's commitment must all be refused:
    # - a transaction that only carries the root's bytes;
    # - another space's commitment;
    # - an earlier commitment of this space, at another height and root.
    w = run.stack.btc("buyer")  # the wallet that pays orders, so it has funds
    raw = w.call("createrawtransaction", [], [{"data": "6a5220" + lb["root"]}])
    raw = w.call("fundrawtransaction", raw)["hex"]
    raw = w.call("signrawtransactionwithwallet", raw)["hex"]
    copied = w.call("sendrawtransaction", raw)
    run.mine(1)
    m.mine(1)
    impostors = [("a transaction carrying the root's bytes", copied)]
    other = [b for b, (space, _) in run.bids.items() if space == SPACE_B and c.batch(b)["txid"]]
    if other:
        impostors.append((f"{other[-1]}, the commitment of {SPACE_B}", c.batch(other[-1])["txid"]))
    earlier = [b for b, (space, _) in run.bids.items() if space == SPACE_A and b != last]
    if earlier:
        impostors.append((f"{earlier[-1]}, an earlier commitment of {SPACE_A}",
                          c.batch(earlier[-1])["txid"]))
    for what, txid in impostors:
        ok, why = attempt_upstream(c.attach_txid_value, last, txid)
        r.step(scen, "U1(b)", f"attach {what} to {last}",
               {"attached": ok, "txid": txid, "answer": why if not ok else ok},
               {"attached": False}, match=not ok,
               note="only the transaction that made this space's commitment is ever attached")
    att_ok, att = attempt_upstream(c.attach_txid, last)
    r.step(scen, "U1(b)", f"attach the adopted txid of {last} to subs",
           {"attached": att_ok, "answer": att,
            "subs_commit_status": subs.get(f"/spaces/{SPACE_A}/commit/status")}, required=False,
           note="needs the U1(b) patch in regtest/upstream/; the pinned subs has no such route")
    bid, mbid = run.freeze_and_stage(scen, SPACE_A, [oid])
    # In the model a frozen batch commits locally once the previous commitment
    # is final, which it is here.
    mallowed = m.batch_state(mbid) == "frozen" and m.batch_state(run.bids[last][1]) == "final"
    ok, why = attempt_upstream(c.commit_local, bid)
    r.step(scen, "U1(b)", f"local commit of {bid} after the recovery of {last}",
           {"allowed": ok, "why": why if not ok else "", "txid_attached": att_ok},
           {"allowed": mallowed, "previous": m.batch_state(run.bids[last][1])},
           match=ok == mallowed)
    if not ok:
        r.finding("R17", f"after a restore, subs refuses the next local commit for a later "
                         f"commitment it holds no txid for, although that commitment is final "
                         f"on chain: {why}")
        return
    cl = why
    m.step("commit_local", mbid)
    got = {"state": c.batch(bid)["state"], "root": cl["root"], "prev_root": cl["prev_root"],
           "is_initial": cl["is_initial"], "handles": cl["handles_committed"],
           "members_on_root": cl["members_on_root"]}
    exp = {"state": m.batch_state(mbid), "members": m.batch_members(mbid)}
    r.step(scen, None, f"local commit {bid} with readback", got, exp,
           match=compare.same_local_commit(got, exp))
    run.finish_preparation(scen, bid, mbid, cl)
    c.issue(bid, FEE_RATE)
    m.step("check_and_issue", mbid, "ok")
    run.compare_batch(scen, None, f"{bid} broadcast", bid, {"txid": c.batch(bid)["txid"]})
    run.finalize(scen, bid, SPACE_A)
    run.certify(scen, bid, SPACE_A)


def isolated():
    """True inside a network namespace with loopback only: nothing outside
    the host can reach the stack, and the stack can reach nothing outside."""
    import socket
    probe = socket.socket()
    probe.settimeout(3)
    try:
        return probe.connect_ex(("1.1.1.1", 443)) != 0 and \
            all(not l.strip().startswith(("eth", "en", "wl")) for l in
                Path("/proc/net/dev").read_text().splitlines()[2:])
    finally:
        probe.close()


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    if not isolated():
        print("refusing to run: not inside an isolated network namespace; "
              "use regtest/run-first-purchase.sh or regtest/run-all.sh", file=sys.stderr)
        return 3
    run_id = argv[1]
    run = Run(run_id)
    if run.stack.dir.exists():
        print(f"refusing to reuse run directory {run.stack.dir}; run ids are never reused",
              file=sys.stderr)
        return 3
    names = argv[2:]
    if names == ["all"]:
        names = ["first_purchase", "second_commitment", "restore", "lost_broadcast"]
    run.report.meta.update({
        "run": run_id,
        "scenarios": names,
        "isolation": "unprivileged user and network namespace (unshare -rn), loopback only",
        "subs_binary": str(subs_bin().relative_to(HERE)) if subs_bin().is_relative_to(HERE) else str(subs_bin()),
        "pins": {l.split("=")[0]: l.split("=", 1)[1]
                 for l in (HERE / "pins.env").read_text().splitlines()
                 if "=" in l and not l.startswith("#")},
    })
    import signal

    def _stop(signum, frame):
        raise KeyboardInterrupt(f"signal {signum}")
    # A background job can inherit SIGINT as ignored, so both signals end the
    # run through the same orderly path: stop the stack, write the report,
    # verdict "error".
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    run.report.meta["error"] = "did not finish"
    run.report.meta["completed"] = []
    try:
        run.start()
        for n in names:
            globals()[n](run)
            run.report.meta["completed"].append(n)
        del run.report.meta["error"]
    except BaseException as e:  # noqa: BLE001 - interrupts end the run in error too
        import traceback
        run.report.meta["error"] = f"{type(e).__name__}: {e}"
        traceback.print_exc()
    finally:
        try:
            run.stop()
        except Exception:  # noqa: BLE001
            run.stack.stop_all()
        run.report.meta["anchor_read_retries"] = getattr(run.controller, "anchor_read_retries", 0)
        (run.stack.dir / "report.md").write_text(run.report.markdown())
        run.report.save()
    verdict = run.report.verdict()
    print(f"report: {run.stack.dir / 'report.md'}")
    print(f"verdict: {verdict}")
    for f in run.report.failures():
        print(f"  required step disagrees: {f['scenario']} {f['case'] or ''} {f['step']}")
    return run.report.exit_code()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
