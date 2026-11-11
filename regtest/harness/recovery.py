"""Scenario 11: the operator gate's recovery rehearsal on a fresh host
(CONTROLLER-DESIGN.md, "Operator gate rehearsal"; PAYMENT-SPEC.md,
"Acceptance gates"). Regtest only.

Two kinds of process run here. The world: a "network" bitcoind that holds
the chain, the buyers' and the miner's wallets, a `spaced` of its own and
the relay that reads from it. The host: its own bitcoind, which syncs from
the network node as a peer, `spaced`, `subs`, the prover, the store service,
the fault proxies and the attended runner. The host's state is lost whole,
and a new host is brought up from the off-host recovery set alone:
- the store's journal and the controller's (the runner's) journal;
- the coordinated snapshots the runner took at each checkpoint;
- the operator wallet's backup, exported from `spaced` at onboarding, and
  the store's payment and refund wallet's backup, taken by Bitcoin Core at
  onboarding.
Credentials aren't in the set: the new host makes new tokens and cookies.

Before the loss, on four spaces, one in-flight state each:
- A (`@test10000`): b1 fulfilled, then a later batch `broadcast` with its
  txid known, sent after the latest snapshot;
- B (`@test9999`): a batch `checkpointed`;
- C (`@test9998`): a broadcast whose answer is withheld by the fault
  proxy. A second runner refuses while the sender is alive (A23). The
  sender is then killed; the next opening settles it to uncertain (A21),
  before A spends its unconfirmed change and before the whole host is lost;
- D (`@test9997`): a batch `committed_local` after the latest snapshot;
plus a cancellation refund from the store's hot wallet, broadcast, and an
unpaid quote. The world's node has every transaction in its mempool when
the host is lost, and nothing is mined while the host is down.

After the restore: reconcile through the runner, check that no name is
issued twice, no refund pays twice, no reservation disappears and each
space's restored tree root agrees with the chain, then issue the waiting
batches and another batch on A after the recovery, to fulfilled, and build
and pay a new refund. b1's order, fulfilled before the loss, gets its
certificate again: `subs` builds it on b4's later root, `certify` accepts
that root once it is final and covered (A19), and the buyer's download
from the order page verifies. The store's replay and the complete recovery are
timed. An owner-signed PSBT refund family isn't exercised: the API can't
export one.

Usage: python3 -m regtest.harness.recovery <run> recovery_rehearsal

Harness code. Results from it are regtest results.
"""

import hashlib
import hmac
import json
import os
import secrets
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

from controller.rpc import Http, JsonRpc, RpcError

from . import scenarios
from .procs import BIN, OPERATOR_WALLET, bitcoind_bin, PORTS, PRESET, Stack, relay_enabled, relay_url, \
    subs_capabilities
from .scenarios import PRICE, SPACED_FEE_RATE, VERIFIER
from .service import ServiceRegistry, ServiceRun

ROOT = Path(__file__).resolve().parents[2]
EXPECT = "expected (recovery rules of CONTROLLER-DESIGN.md and PAYMENT-SPEC.md, not the model)"
A, B, C, D = "@test10000", "@test9999", "@test9998", "@test9997"
SPACES = (A, B, C, D)

PORTS.update({"network": 18953, "network_p2p": 18954, "world_spaced": 18955})

# What the host loses: every process here, and every path in
# `RecoveryStack.host_paths`.
HOST_PROCESSES = ("runner-held", "registry", "subs", "subs_proxy", "prover", "spaced_proxy",
                  "spaced", "bitcoind")


def _rpcauth(path, user):
    """A throwaway rpcauth user for a spaced against a bitcoind, made for this
    run; it never leaves the run directory."""
    password, salt = secrets.token_hex(16), secrets.token_hex(16)
    digest = hmac.new(salt.encode(), password.encode(), hashlib.sha256).hexdigest()
    path.write_text(json.dumps({"user": user, "password": password,
                                "rpcauth": f"{user}:{salt}${digest}"}))
    path.chmod(0o600)


class RecoveryStack(Stack):
    """The harness stack with the world split off: the network node, the
    world's spaced and the relay outlive the host."""

    @property
    def world(self):
        return self.dir / "world"

    @property
    def net_dir(self):
        return self.world / "bitcoind"

    @property
    def world_spaced_dir(self):
        return self.world / "spaced"

    @property
    def certrelay_dir(self):
        return self.world / "certrelay"

    @property
    def recovery_set(self):
        """The part of the off-host store that holds the onboarding backups."""
        return self.dir / "offhost" / "recovery"

    def host_paths(self):
        """Every path the host loses."""
        return [self.btc_dir, self.spaced_dir, self.subs_dir, self.dir / "host",
                self.dir / "runner", self.dir / "service", self.dir / "registry-token",
                self.dir / "spaced-bitcoin-rpc.json", self.dir / "runner.json",
                self.dir / "spaced_proxy.ctl", self.dir / "subs_proxy.ctl"]

    def init(self):
        if self.dir.exists():
            raise FileExistsError(f"{self.dir} exists")
        if not PRESET.exists():
            raise FileNotFoundError("run regtest/fetch.sh first")
        self.dir.mkdir(parents=True)
        self.world.mkdir()
        # The world holds the preset chain. The host starts empty and syncs
        # from it as a peer, before the loss and after it.
        shutil.copytree(PRESET / "bitcoind", self.net_dir)
        self.world_spaced_dir.mkdir()
        _rpcauth(self.world / "spaced-bitcoin-rpc.json", "worldspaced")
        self.new_host()

    def new_host(self):
        """The paths a fresh host starts with: empty data directories and a
        new credential for its spaced."""
        for d in (self.btc_dir, self.spaced_dir, self.subs_dir):
            d.mkdir()
        _rpcauth(self.dir / "spaced-bitcoin-rpc.json", "spaced")

    # Clients

    def net(self, wallet=None):
        url = f"http://127.0.0.1:{PORTS['network']}"
        if wallet:
            url += f"/wallet/{wallet}"
        return JsonRpc(url, self.net_dir / "regtest" / ".cookie")

    def world_spaced(self):
        cookie = sorted(self.world_spaced_dir.rglob(".cookie"))[0]
        return JsonRpc(f"http://127.0.0.1:{PORTS['world_spaced']}", cookie)

    # The world

    def start_network(self):
        if self.running("network"):
            return
        auth = json.loads((self.world / "spaced-bitcoin-rpc.json").read_text())
        self._spawn("network", [
            str(bitcoind_bin()), f"-datadir={self.net_dir}", "-regtest", "-txindex=1",
            "-listen=1", f"-bind=127.0.0.1:{PORTS['network_p2p']}", "-dnsseed=0",
            "-fixedseeds=0", "-discover=0", "-whitelist=noban,relay@127.0.0.1",
            "-rpcbind=127.0.0.1", "-rpcallowip=127.0.0.1", f"-rpcport={PORTS['network']}",
            "-fallbackfee=0.0001", "-rpcworkqueue=100", "-printtoconsole=1",
            f"-rpcauth={auth['rpcauth']}",
        ])
        self._wait("network bitcoind", lambda: self.net().call("getblockchaininfo"))

    def start_world_spaced(self):
        if self.running("world_spaced"):
            return
        auth = json.loads((self.world / "spaced-bitcoin-rpc.json").read_text())
        self._spawn("world_spaced", [
            str(BIN / "spaced"), "--chain", "regtest",
            "--bitcoin-rpc-url", f"http://127.0.0.1:{PORTS['network']}",
            "--rpc-bind", "127.0.0.1", "--rpc-port", str(PORTS["world_spaced"]),
            "--data-dir", str(self.world_spaced_dir),
        ], env={"SPACED_BITCOIN_RPC_USER": auth["user"],
                "SPACED_BITCOIN_RPC_PASSWORD": auth["password"]})
        self._wait("world spaced", lambda: self.world_spaced().call("getserverinfo"))

    def start_certrelay(self):
        """The relay is the world's: it reads from the world's spaced, so it
        keeps running while the host is lost."""
        if self.running("certrelay"):
            return
        self.certrelay_dir.mkdir(exist_ok=True)
        cookie = sorted(self.world_spaced_dir.rglob(".cookie"))[0]
        token = cookie.read_text().strip()
        self._spawn("certrelay", [
            str(BIN / "certrelay"), "--chain", "regtest",
            "--data-dir", str(self.certrelay_dir),
            "--bind", "127.0.0.1", "--port", str(PORTS["certrelay"]),
            "--self-url", relay_url(), "--is-bootstrap",
            "--anchor-refresh", "1", "--allow-private-peers",
        ], env={"RUST_LOG": "info",
                "CERTRELAY_SPACED_RPC_URL": f"http://{token}@127.0.0.1:{PORTS['world_spaced']}"})
        self._wait("certrelay", lambda: Http(relay_url(), timeout=5).get("/health", raw=True)
                   is not None)

    # The host

    def start_bitcoind(self):
        """The host's node: no chain of its own, its one peer the network
        node."""
        if self.running("bitcoind"):
            return
        self._spawn("bitcoind", [
            str(bitcoind_bin()), f"-datadir={self.btc_dir}", "-regtest", "-txindex=1",
            "-listen=0", f"-connect=127.0.0.1:{PORTS['network_p2p']}", "-dnsseed=0",
            "-fixedseeds=0", "-rpcbind=127.0.0.1", "-rpcallowip=127.0.0.1",
            f"-rpcport={PORTS['bitcoind']}", "-fallbackfee=0.0001", "-rpcworkqueue=100",
            "-printtoconsole=1", f"-rpcauth={self._spaced_btc_auth()['rpcauth']}",
        ])
        self._wait("bitcoind", lambda: self.btc().call("getblockchaininfo"))

    def kill(self, name):
        """A crash: SIGKILL, no orderly shutdown."""
        pid = self._pid(name)
        if pid is None:
            return None
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            os.kill(pid, signal.SIGKILL)
        deadline = time.time() + 30
        while self._alive(pid) and time.time() < deadline:
            time.sleep(0.1)
        (self.pids / f"{name}.pid").unlink(missing_ok=True)
        return pid

    def stop_all(self):
        for name in ("runner-held", "registry", "subs", "certrelay", "subs_proxy", "prover",
                     "spaced_proxy", "spaced", "bitcoind", "world_spaced", "network"):
            if name == "runner-held":
                self.kill(name)
            else:
                self.stop_process(name)


class ChainView:
    """What the harness reads from the host and the world. It acts as the
    world (mining, buyers' payments), never as the operator."""

    def __init__(self, stack):
        self.stack = stack
        self.anchor_read_retries = 0

    def tip(self):
        return self.stack.btc().call("getblockcount")

    def host_synced(self, timeout=600, spaced=True):
        """The host's node at the network's best block, then its spaced."""
        deadline = time.time() + timeout
        want = self.stack.net().call("getbestblockhash")
        while time.time() < deadline:
            try:
                if self.stack.btc().call("getbestblockhash") == want:
                    break
            except Exception:  # noqa: BLE001 - starting up
                pass
            time.sleep(0.3)
        else:
            raise TimeoutError("the host's node didn't reach the network's tip")
        if spaced:
            self._spaced_at(self.stack.spaced, want, deadline, "spaced")
        return want

    def world_synced(self, timeout=600):
        want = self.stack.net().call("getbestblockhash")
        self._spaced_at(self.stack.world_spaced, want, time.time() + timeout, "world spaced")

    @staticmethod
    def _spaced_at(client, want, deadline, what):
        while time.time() < deadline:
            try:
                info = client().call("getserverinfo")
                if info["tip"]["hash"] == want and info.get("ready", True):
                    return
            except Exception:  # noqa: BLE001 - starting up
                pass
            time.sleep(0.3)
        raise TimeoutError(f"{what} didn't reach the network's tip")

    def root_anchors(self, attempts=40):
        for i in range(attempts):
            try:
                return self.stack.spaced().call("getrootanchors")
            except RpcError as e:
                if "Could not read anchors file" not in str(e) or i == attempts - 1:
                    raise
                self.anchor_read_retries += 1
                time.sleep(0.25)

    def network_has(self, txids, timeout=120):
        """Every txid in the network node's mempool or chain."""
        net = self.stack.net()
        deadline = time.time() + timeout
        missing = set(txids)
        while missing and time.time() < deadline:
            pool = set(net.call("getrawmempool"))
            for t in list(missing):
                if t in pool:
                    missing.discard(t)
                    continue
                try:
                    if net.call("getrawtransaction", t, True).get("blockhash"):
                        missing.discard(t)
                except RpcError:
                    pass
            if missing:
                time.sleep(0.3)
        return not missing

    def host_has(self, txid, timeout=120):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if txid in self.stack.btc().call("getrawmempool"):
                return True
            time.sleep(0.3)
        return False


class RunnerCli:
    """The attended runner as the operator runs it, one process per command
    and no terminal. A command can also be left running: the host is lost
    while it waits."""

    def __init__(self, run):
        self.run = run
        self.config = run.stack.dir / "runner.json"
        self.config.write_text(json.dumps(runner_config(run), indent=1))
        self.log = run.stack.logs / "runner.log"

    def argv(self, *args):
        return [sys.executable, "-m", "runner", str(self.config), *args]

    def __call__(self, *args):
        started = time.time()
        p = subprocess.run(self.argv(*args), cwd=ROOT, capture_output=True, text=True,
                           stdin=subprocess.DEVNULL, timeout=7200)
        seconds = round(time.time() - started, 2)
        with open(self.log, "a") as f:
            f.write(f"$ runner {' '.join(args)}\nexit {p.returncode} ({seconds} s)\n"
                    f"{p.stdout}{p.stderr}\n")
        try:
            out = json.loads(p.stdout)
        except ValueError:
            out = {"error": f"no JSON output; exit {p.returncode}: {p.stderr[-600:]}"}
        return p.returncode, out, seconds

    def spawn(self, *args):
        """Start a command and leave it running, as the host's process
        `runner-held`."""
        stack = self.run.stack
        stack.logs.mkdir(parents=True, exist_ok=True)
        log = open(stack.logs / "runner-held.log", "ab")
        p = subprocess.Popen(self.argv(*args), cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, start_new_session=True)
        (stack.pids / "runner-held.pid").write_text(str(p.pid))
        return p


def runner_config(run):
    """The runner's host configuration, with the keys of
    `deploy/runner.example.json`. Its controller directory is host state;
    its journal and snapshots are off-host."""
    proc, stack = run.registry.process, run.stack
    procs = [sys.executable, "-m", "regtest.harness.procs"]
    return {
        "network": "regtest",
        "store": {"url": proc.url(), "operator_token_file": str(proc.operator_token_file),
                  "db": str(run.host / "store.db"), "journal_dir": str(proc.journal_dir)},
        "controller": {"dir": str(stack.dir / "runner"), "journal_dir": str(run.offhost),
                       "journal_name": "runner", "operator_wallet": OPERATOR_WALLET,
                       "snapshot_dir": str(run.offhost / "snapshots")},
        "bitcoind": {"url": f"http://127.0.0.1:{PORTS['bitcoind']}",
                     "cookie_file": str(stack.btc_cookie())},
        "spaced": {"url": f"http://127.0.0.1:{PORTS['spaced']}",
                   "cookie_file": str(stack.spaced_cookie())},
        "subs": {"url": f"http://127.0.0.1:{PORTS['subs']}",
                 "write_url": f"http://127.0.0.1:{PORTS['subs_proxy']}",
                 "data_dir": str(stack.subs_dir),
                 "stop_command": procs + ["stop-subs", stack.run],
                 "start_command": procs + ["start-subs", stack.run],
                 "capabilities": subs_capabilities()},
        "relay": {"url": relay_url()},
        "verifier": str(VERIFIER),
    }


class RecoveryRun(ServiceRun):
    def __init__(self, name):
        super().__init__(name)
        self.stack = RecoveryStack(name)
        self.chain = ChainView(self.stack)
        self.controller = None  # the runner's controller is the only one
        self.times = {}

    # The world: mining, buyers

    def mine(self, n, to="miner"):
        """Blocks found by the world: the host's pending transactions reach
        the network node first, then the host syncs."""
        host_pool = self.stack.btc().call("getrawmempool") if self.stack.running("bitcoind") \
            else []
        if host_pool and not self.chain.network_has(host_pool):
            raise RuntimeError("the host's transactions didn't reach the network node")
        addr = self.stack.net(to).call("getnewaddress", "", "bech32m")
        self.stack.net().call("generatetoaddress", n, addr)
        if self.stack.running("bitcoind"):
            self.chain.host_synced()
        self.chain.world_synced()

    def buyer_script(self):
        b = self.stack.net("buyer")
        return b.call("getaddressinfo", b.call("getnewaddress", "", "bech32m"))["scriptPubKey"]

    def pay(self, address, sats):
        txid = self.stack.net("buyer").call("sendtoaddress", address, sats / 1e8)
        if not self.chain.host_has(txid):
            raise RuntimeError(f"payment {txid} didn't reach the host's node")
        return txid

    # Setup

    def _open_host(self):
        token_file = self.stack.dir / "registry-token"
        if not token_file.exists():
            token_file.write_text(secrets.token_hex(24))
            token_file.chmod(0o600)
        self.token = token_file.read_text().strip()
        # The buyers' order links are theirs, not the host's: they outlive it.
        links = self.registry.links if getattr(self, "registry", None) else {}
        self.registry = ServiceRegistry(self)
        self.registry.links.update(links)

    def start(self):
        s = self.stack
        s.init()
        s.start_network()
        net = s.net()
        for w in ("miner", "buyer"):
            net.call("createwallet", w)
        # The preset chain's own regtest wallet funds the buyer: an upstream
        # test fixture, on the network node only.
        net.call("loadwallet", "default")
        s.net("default").call("sendtoaddress",
                              s.net("buyer").call("getnewaddress", "", "bech32m"), 1.0)
        addr = s.net("miner").call("getnewaddress", "", "bech32m")
        net.call("generatetoaddress", 1, addr)
        s.start_world_spaced()
        s.start_bitcoind()
        self.chain.host_synced(timeout=1800, spaced=False)
        s.start_spaced()
        self.chain.host_synced(timeout=1800)
        self.chain.world_synced(timeout=1800)
        s.start_proxies()
        s.start_prover()
        self.host.mkdir(exist_ok=True)
        self._open_host()
        self._onboard()
        s.start_subs()
        self._setup_subs()
        self.registry.serve(PORTS["registry"])

    def _onboard(self):
        """Onboarding: the store's wallet created and backed up, the operator
        wallet imported into spaced and exported as its backup, every space
        operated. The backups go to the off-host recovery set."""
        s, sp = self.stack, self.stack.spaced()
        s.recovery_set.mkdir(parents=True, exist_ok=True)
        s.btc().call("createwallet", "store")
        store_backup = s.recovery_set / "store-wallet.bak"
        s.btc("store").call("backupwallet", str(store_backup))
        store_backup.chmod(0o600)
        export = json.loads((PRESET / "wallets" / f"{OPERATOR_WALLET}.json").read_text())
        sp.call("walletimport", export)
        self._wait_wallet()
        operator_backup = s.recovery_set / "operator-wallet.json"
        operator_backup.write_text(json.dumps(sp.call("walletexport", OPERATOR_WALLET)))
        operator_backup.chmod(0o600)
        owned = self._owned()
        missing = [x for x in SPACES if x not in owned]
        if missing:
            raise RuntimeError(f"the operator wallet doesn't own {missing}")
        for space in SPACES:
            r = sp.call("walletsendrequest", OPERATOR_WALLET, {
                "requests": [{"request": "operate", "subject": space}],
                "fee_rate": SPACED_FEE_RATE, "dust": None, "force": False,
                "confirmed_only": False, "skip_tx_check": False})
            if any(t.get("error") for t in r["result"]):
                raise RuntimeError(f"operate {space}: {r}")
            self.mine(6)
        self._wait_wallet()

    def _owned(self):
        owned = self.stack.spaced().call("walletlistspaces", OPERATOR_WALLET)["owned"]
        return {o.get("name") or o.get("spaceout", {}).get("space", {}).get("name") for o in owned}

    def _wait_wallet(self, timeout=1800):
        deadline = time.time() + timeout
        sp = self.stack.spaced()
        while time.time() < deadline:
            info = sp.call("walletgetinfo", OPERATOR_WALLET)
            if info.get("tip") == self.chain.tip() and \
                    sp.call("walletlistspaces", OPERATOR_WALLET)["owned"]:
                return
            time.sleep(1)
        raise TimeoutError("operator wallet did not sync")

    def _setup_subs(self):
        subs = self.stack.subs()
        self._configure_subs()
        for space in SPACES:
            subs.post(f"/spaces/{space}/operate")

    def _configure_subs(self):
        self.stack.subs().post("/config", {
            "prover_endpoint": f"http://127.0.0.1:{PORTS['prover']}",
            "registry_endpoint": f"http://127.0.0.1:{PORTS['registry']}",
            "registry_auth_token": self.token,
            "registry_auto_sync": False,
        })


# Steps

def _rstep(run, scen, case, what, result, expect, check, note=""):
    code, out, seconds = result
    run.report.step(scen, case, what, {"exit": code, "seconds": seconds, "output": out},
                    {EXPECT: expect}, match=bool(check(code, out)), note=note)
    return out


def _buy(run, scen, label, space, pay=True):
    """The owner lists the name; a buyer requests it, is quoted and pays."""
    reg = run.registry
    handle = label + space
    reg.list_name(handle, PRICE)
    spk = run.buyer_script()
    oid = reg.request(handle, spk)
    q = reg.quote(oid)
    txid = run.pay(q["address"], q["price_sats"]) if pay else None
    run.report.step(scen, None, f"{handle}: request, quote" + (", payment" if pay else ""),
                    {"oid": oid, "address": q["address"], "payment": txid}, required=False)
    return oid


def _store_state(run):
    """What the store holds that a restore must keep: each order's status,
    sums, reservation and refund groups, and each name's hold and
    fulfillment reservation."""
    reg = run.registry
    orders = {}
    for oid in reg.op("GET", "/operator/orders")["orders"]:
        o = reg.order(oid)
        orders[oid] = {
            "name": o["name"], "status": o["status"], "dest_script": o["dest_script"],
            "recipient_spk": o["recipient_spk"], "sums": o["sums"],
            "reserved": o["reserved"], "available": o["available"],
            "refunded_total": o["refunded_total"],
            "groups": [{"gid": g["gid"], "closed_by": g["closed_by"],
                        "attempts": sorted(a["txid"] for a in g["attempts"])}
                       for g in o["groups"]]}
    db = sqlite3.connect(f"file:{run.host / 'store.db'}?mode=ro", uri=True)
    names = {r[0]: {"price": r[1], "hold_order": r[2], "fulfillment_order": r[3]}
             for r in db.execute("select name, price, hold_order, fulfillment_order from names")}
    db.close()
    return {"orders": orders, "names": names}


def _journal_size(path):
    lines = [l for l in path.read_text().splitlines() if l] if path.exists() else []
    return {"entries": len(lines), "bytes": path.stat().st_size if path.exists() else 0}


def _finalize(run, scen, runner, bids):
    """Mine every batch to d >= 150 and a root anchor that covers it, then
    watch each to final."""
    heights = {}
    for bid in bids:
        code, out, _ = runner("watch", bid)
        if out.get("state") not in ("mined", "final") or out.get("depth") is None:
            raise RuntimeError(f"{bid} isn't mined: {out}")
        heights[bid] = run.chain.tip() - out["depth"]
    top = max(heights.values())
    target_tip = top + 150
    if run.chain.tip() < target_tip:
        run.mine(target_tip - run.chain.tip())
    anchor = -(-(top + 144) // 36) * 36
    if run.chain.tip() < anchor:
        run.mine(anchor - run.chain.tip())
    deadline = time.time() + 180
    while run.chain.root_anchors()[0]["block"]["height"] < anchor and time.time() < deadline:
        time.sleep(0.5)
    out = {}
    for bid in bids:
        code, w, _ = runner("watch", bid)
        out[bid] = {"state": w.get("state"), "depth": w.get("depth"),
                    "certificate_status": w.get("certificate_status")}
    run.report.step(scen, None, f"mined to d >= 150 and the anchor at {anchor}: "
                    + ", ".join(bids), out,
                    {EXPECT: {b: {"state": "final", "certificate_status": "verified"}
                              for b in bids}},
                    match=all(v["state"] == "final" and v["certificate_status"] == "verified"
                              for v in out.values()))


def _certify_and_publish(run, scen, runner, bid):
    cert = _rstep(run, scen, None, f"runner certify {bid}", runner("certify", bid),
                  {"exit": 0, "every member verified and delivered": True},
                  lambda c, o: c == 0 and o.get("members") and all(
                      m["verified"] and m["delivered"] for m in o["members"].values()))
    pub = _rstep(run, scen, None, f"runner publish {bid}: delivery confirmed by a verified "
                 "lookup through the relay", runner("publish", bid),
                 {"exit": 0, "outstanding": [], "every member confirmed": True},
                 lambda c, o: c == 0 and o.get("outstanding") == [] and o.get("delivery")
                 and all(d.get("confirmed") for d in o["delivery"].values()))
    return cert, pub


def _wait_held(run, timeout=600):
    """The broadcast the fault proxy holds: answered upstream, never to the
    runner."""
    proxy = Http(f"http://127.0.0.1:{PORTS['subs_proxy']}", timeout=10)
    deadline = time.time() + timeout
    while time.time() < deadline:
        held = proxy.get("/__proxy__").get("held") or []
        if held:
            return held[0]
        time.sleep(0.5)
    raise TimeoutError("no broadcast was held")


def _journaled_batch(run, bid):
    last = None
    for e in (run.offhost / "runner.jsonl").read_text().splitlines():
        e = json.loads(e)
        if e["kind"] == "batch" and e["batch"]["bid"] == bid:
            last = e["batch"]
    return last


def recovery_rehearsal(run):
    if not relay_enabled() or not subs_capabilities()["attach_txid"]:
        raise RuntimeError("the rehearsal needs SUBSPACE_RELAY=1 and the subs-combined build "
                           "(U1(b) and --fabric-seed); see regtest/run-recovery.sh")
    r, s, reg = run.report, run.stack, run.registry
    runner = RunnerCli(run)
    scen = "11a. in-flight states before the host is lost"
    r.step(scen, None, "the world and the host",
           {"network_node": f"127.0.0.1:{PORTS['network']}, the preset chain",
            "host_node": "empty data directory, synced from the network node as its one peer",
            "spaces": list(SPACES), "subs_capabilities": subs_capabilities(),
            "recovery_set": sorted(p.name for p in s.recovery_set.iterdir())}, required=False,
           note="the backups are written at onboarding, mode 0600, and never kept in the "
                "repository")

    # A, b1: fulfilled.
    first_order_tip = run.chain.tip()
    o1 = _buy(run, scen, "one", A)
    run.mine(3)
    prep = _rstep(run, scen, None, "runner prepare @test10000", runner("prepare", A),
                  {"exit": 0, "state": "checkpointed", "members": [o1]},
                  lambda c, o: c == 0 and o.get("state") == "checkpointed"
                  and o.get("members") == [o1])
    b1, b1_root = prep["bid"], prep["root"]
    _rstep(run, scen, None, f"runner issue {b1} confirmed", runner("issue", b1, "--confirm", b1),
           {"exit": 0, "state": "broadcast"},
           lambda c, o: c == 0 and o.get("state") == "broadcast")
    run.mine(1)
    _finalize(run, scen, runner, [b1])
    _certify_and_publish(run, scen, runner, b1)
    r.step(scen, None, f"{o1} after delivery", {"status": reg.order(o1)["status"]},
           {EXPECT: {"status": "fulfilled"}}, match=reg.order(o1)["status"] == "fulfilled")

    # Orders for the in-flight batches and the refund.
    o2 = _buy(run, scen, "two", A)       # cancelled and refunded
    o3 = _buy(run, scen, "three", B)     # B: checkpointed
    o4 = _buy(run, scen, "four", C)      # C: issuing, answer withheld
    o5 = _buy(run, scen, "five", A)      # A: broadcast after the snapshot
    o6 = _buy(run, scen, "six", D)       # D: committed_local after the snapshot
    run.mine(3)
    _rstep(run, scen, None, f"runner cancel {o2}", runner("cancel", o2),
           {"exit": 0, "cancellation": "final"},
           lambda c, o: c == 0 and o.get("cancellation") == "final")
    refund_address = s.net("buyer").call("getnewaddress", "refund", "bech32m")
    reg.set_refund_address(o2, refund_address)
    run.mine(3)

    bids = {}
    for space, oid in ((B, o3), (C, o4), (A, o5)):
        out = _rstep(run, scen, None, f"runner prepare {space}", runner("prepare", space),
                     {"exit": 0, "state": "checkpointed", "members": [oid]},
                     lambda c, o, oid=oid: c == 0 and o.get("state") == "checkpointed"
                     and o.get("members") == [oid])
        bids[space] = out["bid"]
    from controller.core import Controller as _C
    latest_snapshot = max((run.offhost / "snapshots").iterdir(), key=_C.snapshot_number).name

    # D stops at committed_local, which no runner command does: the harness
    # builds the runner's controller from the same host configuration and
    # takes the first three steps.
    from controller import host as chost
    from runner.store import Store
    cfg = json.loads(runner.config.read_text())
    st = cfg["store"]
    ctl, _ = chost.build(cfg, Store(st["url"], st["operator_token_file"], st["db"],
                                    st["journal_dir"]), cwd=ROOT)
    bd = ctl.freeze(D)
    ctl.stage(bd)
    committed = ctl.commit_local(bd)
    bids[D] = bd
    r.step(scen, None, f"{bd} on {D} stopped at committed_local after the latest snapshot",
           {"state": ctl.batch(bd)["state"], "root": committed["root"],
            "members": ctl.batch(bd)["members"], "latest_snapshot": latest_snapshot},
           {EXPECT: {"state": "committed_local", "members": [o6]}},
           match=ctl.batch(bd)["state"] == "committed_local" and ctl.batch(bd)["members"] == [o6],
           note="through controller.host.build from the runner's configuration: no runner "
                "command stops at committed_local")
    ctl.db.close()

    built = _rstep(run, scen, "N2", f"runner refund {o2} once settled", runner("refund", o2),
                   {"exit": 0, "to_buyer": PRICE - 300},
                   lambda c, o: c == 0 and o.get("to_buyer") == PRICE - 300)
    gid, refund_txid = built["gid"], built["txid"]

    code, status, _ = runner("status")
    if code != 0:
        raise RuntimeError(f"status before held broadcast failed: {status}")

    # C: the broadcast goes out, and the fault proxy in front of subs holds
    # its answer. The runner waits while a second runner is refused.
    (s.dir / "subs_proxy.ctl").write_text(json.dumps({"hold_response": "/broadcast",
                                                      "count": 1}))
    bc = bids[C]
    held_proc = runner.spawn("issue", bc, "--confirm", bc)
    held = _wait_held(run)
    c_txid = json.loads(held["upstream_response"]).get("txid")
    journaled = _journaled_batch(run, bc)
    r.step(scen, None, f"{bc} on {C}: broadcast sent, its answer withheld from the runner",
           {"upstream": {"status": held["upstream_status"], "txid": c_txid},
            "runner_waiting": held_proc.poll() is None,
            "journaled": {k: journaled.get(k) for k in ("state", "intent", "txid")}},
           {EXPECT: {"runner_waiting": True, "journaled": {"state": "issuing", "intent": 1,
                                                           "txid": None}}},
           match=held_proc.poll() is None and journaled["state"] == "issuing"
           and journaled["intent"] == 1 and not journaled.get("txid") and bool(c_txid))

    code, busy, _ = runner("status")
    r.step(scen, "A23", "second runner refuses while the broadcast owner is alive",
           {"exit": code, "answer": busy}, {EXPECT: {"exit": 3, "refused": "controller busy"}},
           match=code == 3 and "controller busy" in busy.get("refused", "")
           and held_proc.poll() is None)
    # Evidence only: a read-only SQLite connection, never a controller
    # opening that could reconcile or write while the sender owns it.
    with sqlite3.connect((s.dir / "runner" / "controller.db").as_uri() + "?mode=ro",
                         uri=True) as db:
        db.row_factory = sqlite3.Row
        before_batches = {b["bid"]: dict(b) for b in db.execute("select * from batches")}
        alert_count = db.execute("select count(*) from alerts").fetchone()[0]
    r.step(scen, "A23", "refused status leaves the live attempt and alerts unchanged",
           {"state": before_batches[bc]["state"], "alerts": alert_count},
           {EXPECT: {"state": "issuing", "alerts": len(status["controller_alerts"])}},
           match=before_batches[bc]["state"] == "issuing"
           and alert_count == len(status["controller_alerts"])
           and _journaled_batch(run, bc) == journaled)
    # Release ownership by a genuine process death, not by deleting the
    # lock. A can then spend C's unconfirmed change, preserving A15's
    # ancestor-rebroadcast coverage as well as A23's live-owner check.
    killed_sender = s.kill("runner-held")
    held_proc.wait(timeout=10)
    r.step(scen, "A23", "the held sender is killed before another runner opens",
           {"killed": bool(killed_sender), "exit": held_proc.returncode},
           {EXPECT: {"killed": True}}, match=bool(killed_sender))

    ba = bids[A]
    out = _rstep(run, scen, None, f"runner issue {ba} confirmed: sent after the latest snapshot",
                 runner("issue", ba, "--confirm", ba), {"exit": 0, "state": "broadcast"},
                 lambda c, o: c == 0 and o.get("state") == "broadcast" and o.get("txid"))
    a_txid = out.get("txid")
    _rstep(run, scen, "A5", f"runner broadcast-refund {gid} confirmed",
           runner("broadcast-refund", gid, "--confirm", gid), {"exit": 0, "acknowledged": True},
           lambda c, o: c == 0 and o.get("acknowledged") is True)
    # An unpaid quote, the newest address the store's wallet gave out.
    o7 = _buy(run, scen, "seven", B, pay=False)

    # The host's node, which sent it: the world may not have it yet.
    vin = [v["txid"] for v in s.btc().call("getrawtransaction", a_txid, True)["vin"]]
    unconfirmed = [t for t in vin
                   if not s.btc().call("getrawtransaction", t, True).get("blockhash")]
    ja = _journaled_batch(run, ba)
    journaled_ancestors = [t for t, _ in json.loads(ja.get("ancestors") or "[]")]
    c_is_parent = c_txid in journaled_ancestors
    r.step(scen, "A15", f"{ba}'s commitment and its unconfirmed inputs",
           {"inputs": vin, "unconfirmed_inputs": unconfirmed,
            "spends_the_change_of": f"{bc}'s commitment" if c_txid in vin else None,
            "journaled_ancestors": journaled_ancestors},
           {EXPECT: {"journaled_ancestors": "every unconfirmed transaction it spends from"}},
           match=bool(unconfirmed) and c_is_parent
           and all(t in journaled_ancestors for t in unconfirmed),
           note="the operator wallet funds a commitment from unconfirmed change, which can be "
                "another space's commitment in flight (R26)")
    propagated = run.chain.network_has([c_txid, a_txid, refund_txid])
    net_pool = set(s.net().call("getrawmempool"))
    got = {"in_network_mempool": {"C": c_txid in net_pool, "A": a_txid in net_pool,
                                  "refund": refund_txid in net_pool}}
    r.step(scen, None, "the world has every pending transaction when the host is lost", got,
           {EXPECT: {"in_network_mempool": {"C": True, "A": True, "refund": True}}},
           match=propagated and all(got["in_network_mempool"].values()))
    code, status, _ = runner("status")
    if code != 0:
        raise RuntimeError(f"status after sender death failed: {status}")
    before = _store_state(run)
    before_alerts = {"store": len(status["alerts"]), "controller": len(status["controller_alerts"])}
    blocks_since_first = run.chain.tip() - first_order_tip
    before_batches = {b["bid"]: b for b in status["batches"]}
    r.step(scen, None, "batches before the loss",
           {b: (v["space"], v["state"], v["txid"]) for b, v in before_batches.items()},
           {EXPECT: {b1: "final", bids[A]: "broadcast", bids[B]: "checkpointed",
                     bids[C]: "broadcast_uncertain", bids[D]: "committed_local"}},
           match={b1: "final", bids[A]: "broadcast", bids[B]: "checkpointed",
                  bids[C]: "broadcast_uncertain", bids[D]: "committed_local"}
           == {b: v["state"] for b, v in before_batches.items()},
           note="A21: only after the sender dies does a new owner settle it to uncertain")

    # The host is lost.
    scen = "11b. host loss and a fresh host from the recovery set"
    # Evidence the lost host's runner kept is moved out of host state first.
    if (s.dir / "runner" / "certs").exists():
        shutil.copytree(s.dir / "runner" / "certs", s.dir / "certs" / "lost-host-runner")
    killed = {name: s.kill(name) for name in HOST_PROCESSES}
    for p in s.host_paths():
        if p.is_dir():
            shutil.rmtree(p)
        elif p.exists():
            p.unlink()
    offhost = sorted(str(p.relative_to(run.offhost)) for p in run.offhost.rglob("*")
                     if p.is_file() and "snapshots" not in p.parts)
    r.step(scen, None, "host lost: every host process killed, every host path deleted",
           {"killed": {k: bool(v) for k, v in killed.items()},
            "deleted": [str(p.relative_to(s.dir)) for p in s.host_paths()],
            "remaining_offhost": offhost,
            "snapshots": sorted(p.name for p in (run.offhost / "snapshots").iterdir()),
            "world": ["network bitcoind", "world spaced", "certrelay"]},
           {EXPECT: {"no host path left": True}},
           match=not any(p.exists() for p in s.host_paths()) and held_proc.poll() is not None,
           note="nothing is mined while the host is down")
    history = {"store_journal": _journal_size(run.offhost / "store-service" / "store.jsonl"),
               "runner_journal": _journal_size(run.offhost / "runner.jsonl"),
               "orders": len(before["orders"]),
               "refund_groups": sum(len(o["groups"]) for o in before["orders"].values()),
               "alerts": before_alerts,
               "blocks_since_the_first_order": blocks_since_first,
               "sales_period": "none: a rehearsal's few orders, mined at once on regtest"}

    timings = {}

    def timed(name, fn):
        t = time.time()
        out = fn()
        timings[name] = round(time.time() - t, 2)
        return out

    t0 = time.time()
    s.new_host()
    timed("host node synced from the network node",
          lambda: (s.start_bitcoind(), run.chain.host_synced(timeout=1800, spaced=False)))
    timed("spaced synced", lambda: (s.start_spaced(), run.chain.host_synced(timeout=1800)))
    backup = json.loads((s.recovery_set / "operator-wallet.json").read_text())
    timed("operator wallet restored from its onboarding backup and synced",
          lambda: (s.spaced().call("walletimport", backup), run._wait_wallet()))
    owned = run._owned()
    timed("store wallet restored from its onboarding backup",
          lambda: s.btc().call("restorewallet", "store",
                               str(s.recovery_set / "store-wallet.bak")))
    r.step(scen, None, "host node, spaced and both wallets on the fresh host",
           {"tip": run.chain.tip(), "network_tip": s.net().call("getblockcount"),
            "host_mempool": s.btc().call("getrawmempool"),
            "operator_wallet_owns": sorted(x for x in owned if x in SPACES),
            "store_wallet_loaded": "store" in s.btc().call("listwallets")},
           {EXPECT: {"tip": "the network's", "operator_wallet_owns": sorted(SPACES),
                     "store_wallet_loaded": True}},
           match=run.chain.tip() == s.net().call("getblockcount")
           and set(SPACES) <= owned and "store" in s.btc().call("listwallets"),
           note="a fresh node learns no earlier mempool from its peer")

    run.host.mkdir()
    run._open_host()
    reg = run.registry
    reg.process.write_config()
    replay = timed("store replay from its journal (python3 -m service restore)",
                   lambda: subprocess.run([sys.executable, "-m", "service", "restore",
                                           str(reg.process.config)], cwd=ROOT,
                                          capture_output=True, text=True, timeout=3600))
    r.step(scen, None, "python3 -m service restore: the store from its journal alone",
           {"exit": replay.returncode, "output": (replay.stdout + replay.stderr).strip()[-600:],
            "seconds": timings["store replay from its journal (python3 -m service restore)"]},
           {EXPECT: {"exit": 0}}, match=replay.returncode == 0)
    startup = timed("store started (refund attempts reconciled before serving)",
                    lambda: reg.process.start())
    r.step(scen, "H6", "the store's start: refund attempts reconciled before serving",
           {"rebroadcast": startup["startup"]["rebroadcast"],
            "refund_in_host_mempool": refund_txid in s.btc().call("getrawmempool")},
           {EXPECT: {"rebroadcast": [refund_txid], "refund_in_host_mempool": True}},
           match=startup["startup"]["rebroadcast"] == [refund_txid]
           and refund_txid in s.btc().call("getrawmempool"),
           note="the fresh node doesn't know the refund, so the store sends the same signed "
                "bytes again; the world already has them")
    s.start_proxies()
    s.start_prover()
    runner = RunnerCli(run)
    # The fresh controller database lacks every journaled batch: nothing but
    # status and restore runs, and no batch id is given out again.
    _rstep(run, scen, "A16", f"runner prepare {A} before the restore", runner("prepare", A),
           {"exit": 3, "refused": "restore required"},
           lambda c, o: c == 3 and "restore required" in o.get("refused", ""))
    code, status, _ = runner("status")
    rec = status.get("recovery") or {}
    r.step(scen, "A16", "runner status before the restore",
           {"state": rec.get("state"), "waiting": rec.get("waiting"),
            "batches": status.get("batches")},
           {EXPECT: {"state": "required", "batches": []}},
           match=rec.get("state") == "required" and status.get("batches") == []
           and "missing: b1, b2, b3, b4, b5" in (rec.get("waiting") or [""])[0])
    restored = timed("runner restore: subs from the snapshot, the controller from its journal, "
                     "reconciled", lambda: runner("restore"))
    code, out, _ = restored
    rec = out.get("recovery") or {}
    verdicts = {b: v["verdict"] for b, v in (rec.get("batches") or {}).items()}
    want = {b1: "closed", bids[A]: "waiting", bids[B]: "reconciled", bids[C]: "waiting",
            bids[D]: "closed"}
    r.step(scen, "A13", "runner restore", {"exit": code, "output": out},
           {EXPECT: {"exit": 0, "snapshot": latest_snapshot, "verdicts": want,
                     "ready": False, "resumed_from": "required", "subs_copied": True,
                     "replayed": True}},
           match=code == 0 and out.get("snapshot") == latest_snapshot and verdicts == want
           and rec.get("ready") is False and out.get("resumed_from") == "required"
           and out.get("subs_copied") is True and out.get("replayed") is True)
    states = {b: v["state"] for b, v in (rec.get("batches") or {}).items()}
    r.step(scen, "A13", "reconciled states",
           {"states": states, "waiting": rec.get("waiting"), "spaces": rec.get("spaces")},
           {EXPECT: {bids[D]: "rebuilt", bids[C]: "broadcast_uncertain",
                     bids[A]: "broadcast", bids[B]: "checkpointed", b1: "final"}},
           match=states.get(bids[D]) == "rebuilt" and states.get(bids[C]) == "broadcast_uncertain"
           and states.get(bids[A]) == "broadcast" and states.get(bids[B]) == "checkpointed"
           and states.get(b1) == "final")
    # A fresh host makes fresh credentials: subs is told the store's new
    # registry token. Host provisioning, not part of the recovery set.
    run._configure_subs()
    r.step(scen, None, "subs given the new host's registry token", {"configured": True},
           required=False)

    _rstep(run, scen, "A14", f"runner issue {bids[B]} while the restore waits",
           runner("issue", bids[B], "--confirm", bids[B]),
           {"exit": 3, "refused": "a restore isn't reconciled yet, nothing was sent"},
           lambda c, o: c == 3 and "isn't reconciled yet" in o.get("refused", ""))
    first = timed(f"readback {bids[C]}", lambda: runner("readback", bids[C]))
    _rstep(run, scen, "A13", f"runner readback {bids[C]}: nothing on this host yet", first,
           {"exit": 0, "adopted": False, "state": "broadcast_uncertain"},
           lambda c, o: c == 0 and o.get("adopted") is False
           and o.get("state") == "broadcast_uncertain",
           note="the commitment is in the world's mempool only; finding nothing proves nothing")
    _rstep(run, scen, "A11", f"runner rebroadcast {bids[A]} without its confirmation",
           runner("rebroadcast", bids[A]), {"exit": 3, "refused": "nothing was sent"},
           lambda c, o: c == 3 and "nothing was sent" in o.get("refused", ""))
    in_pool = s.btc().call("getrawmempool")
    r.step(scen, "A11", "nothing sent after the refused rebroadcast",
           {"host_mempool_has": {"A": a_txid in in_pool, "C": c_txid in in_pool}},
           {EXPECT: {"host_mempool_has": {"A": False, "C": False}}},
           match=a_txid not in in_pool and c_txid not in in_pool)
    out = timed(f"rebroadcast {bids[A]}",
                lambda: runner("rebroadcast", bids[A], "--confirm", bids[A]))
    want_anc = [{"txid": t, "in_mempool": True} for t in journaled_ancestors]
    _rstep(run, scen, "A15", f"runner rebroadcast {bids[A]} confirmed: its journaled "
           "unconfirmed ancestors first, then its own journaled bytes", out,
           {"exit": 0, "txid": a_txid, "in_mempool": True, "ancestors": want_anc},
           lambda c, o: c == 0 and o.get("txid") == a_txid and o.get("in_mempool")
           and o.get("ancestors") == want_anc)

    def adopt_c(when):
        out = timed(f"readback {bids[C]} {when}", lambda: runner("readback", bids[C]))
        _rstep(run, scen, "A13", f"runner readback {bids[C]} {when}: adopted", out,
               {"exit": 0, "adopted": True, "txid": c_txid, "state": "broadcast"},
               lambda c, o: c == 0 and o.get("adopted") is True and o.get("txid") == c_txid
               and o.get("state") == "broadcast")

    attaches = [f"{A}: attach {bids[A]}'s txid once it is mined"]
    if c_is_parent:
        # C's commitment went out again as A's journaled ancestor, so this
        # node has it in its mempool now.
        adopt_c("again, from this node's mempool")
        attaches.append(f"{C}: attach {bids[C]}'s txid once it is mined")
    code, status, _ = runner("status")
    waiting = (status.get("recovery") or {}).get("waiting")
    expected_waiting = ([] if c_is_parent else
                        [f"{bids[C]}: uncertain: no transaction carrying its root found yet; "
                         "read back again (finding nothing proves nothing)"]) + attaches
    r.step(scen, "A14", "runner status before a block", {"waiting": waiting},
           {EXPECT: {"waiting": expected_waiting}}, match=waiting == expected_waiting)
    t_block = time.time()
    run.mine(1)
    timings["a block arrives (regtest: mined at once)"] = round(time.time() - t_block, 2)
    if not c_is_parent:
        adopt_c("once a block carries it")
    for bid in (bids[A], bids[C]):
        out = timed(f"attach-txid {bid}", lambda bid=bid: runner("attach-txid", bid))
        _rstep(run, scen, "A9", f"runner attach-txid {bid}: subs told the adopted txid", out,
               {"exit": 0, "attached": True},
               lambda c, o: c == 0 and o.get("answer") is not None)
    for bid in (bids[A], bids[C]):
        runner("watch", bid)
    code, status, sec = timed("runner status: ready", lambda: runner("status"))
    t_ready = time.time()
    rec = status.get("recovery") or {}
    r.step(scen, "A14", "runner status after the readback and the attaches",
           {"ready": rec.get("ready"), "waiting": rec.get("waiting"),
            "spaces": {k: {"root": v.get("root"), "attach": v.get("attach")}
                       for k, v in (rec.get("spaces") or {}).items()}},
           {EXPECT: {"ready": True, "waiting": []}},
           match=rec.get("ready") is True and rec.get("waiting") == [])
    complete = round(t_ready - t0, 2)
    run.times = {"store_replay_seconds":
                 timings["store replay from its journal (python3 -m service restore)"],
                 "complete_recovery_seconds": complete, "steps": timings, "history": history}
    r.step(scen, None, "times, with the history they were measured on", run.times,
           required=False,
           note="regtest: blocks arrive at once and the chain is short; the targets are open "
                "points for the workspace_owner")

    # Checks
    scen = "11c. the restored state against the state before the loss"
    after = _store_state(run)
    lost = {oid: (before["orders"][oid]["status"], after["orders"].get(oid, {}).get("status"))
            for oid in before["orders"]
            if before["orders"][oid]["status"] != after["orders"].get(oid, {}).get("status")}
    r.step(scen, None, "every order's status as before", {"changed": lost},
           {EXPECT: {"changed": {}}}, match=lost == {})
    keys = ("reserved", "available", "refunded_total", "sums", "dest_script", "recipient_spk",
            "groups")
    diff = {oid: {k: (b[k], after["orders"][oid][k]) for k in keys
                  if b[k] != after["orders"][oid][k]}
            for oid, b in before["orders"].items() if oid in after["orders"]}
    diff = {k: v for k, v in diff.items() if v}
    # The refund confirmed in the block that arrived: one confirmation, not
    # settled, so its group stays open and its reservation stays.
    r.step(scen, None, "no reservation disappears: every order's reservation, sums and refund "
           "groups as before", {"differences": diff}, {EXPECT: {"differences": {}}},
           match=diff == {}, note="sums are recomputed from the chain")
    views = {oid: reg.buyer_view(oid)["status"] for oid in before["orders"]}
    r.step(scen, "H1", "every buyer's order link opens its own order, as before",
           views, {EXPECT: {oid: o["status"] for oid, o in before["orders"].items()}},
           match=views == {oid: o["status"] for oid, o in before["orders"].items()})
    cert_status, _ = _download(reg, o1)
    r.step(scen, None, f"{o1}'s certificate on its order page after the restore",
           {"download_status": cert_status}, {EXPECT: {"download_status": 404}},
           match=cert_status == 404,
           note="certificates aren't journaled; the runner delivers them again (11d)")
    names = {n: (before["names"][n]["fulfillment_order"],
                 after["names"].get(n, {}).get("fulfillment_order"))
             for n in before["names"]
             if before["names"][n]["fulfillment_order"]
             != after["names"].get(n, {}).get("fulfillment_order")}
    holds = {n: (before["names"][n]["hold_order"], after["names"].get(n, {}).get("hold_order"))
             for n in before["names"]}
    r.step(scen, None, "every name's fulfillment reservation as before",
           {"changed": names, "holds": holds}, {EXPECT: {"changed": {}}}, match=names == {})
    committed = {}
    for space in SPACES:
        for h in _subs_handles(s, space):
            committed.setdefault(f"{h['name']}{space}", []).append(h["commitment_root"])
    twice = {h: roots for h, roots in committed.items() if len(roots) > 1}
    code, status, _ = runner("status")
    member_of = {}
    for b in status["batches"]:
        if b["state"] not in ("rebuilt", "superseded"):
            for m in b["members"]:
                member_of.setdefault(m, []).append(b["bid"])
    r.step(scen, None, "no name issued twice: each handle committed once in subs, each order "
           "in one live or closed batch",
           {"committed": committed, "orders_in_two_batches":
            {m: v for m, v in member_of.items() if len(v) > 1}},
           {EXPECT: {"committed_twice": {}, "orders_in_two_batches": {}}},
           match=twice == {} and all(len(v) == 1 for v in member_of.values()))
    roots = {}
    for space in SPACES:
        pipe = s.subs().get(f"/spaces/{space}/pipeline")
        chain = s.spaced().call("getcommitment", space, None)
        roots[space] = {"subs_root": pipe.get("root"), "subs_txid": pipe.get("txid"),
                        "chain_root": chain and chain.get("state_root")}
    r.step(scen, None, "the restored tree root of each space against the chain",
           roots, {EXPECT: {A: "subs root = chain root, with the txid", C: "subs root = chain "
                            "root, with the txid", B: "subs one local commitment ahead (b "
                            "checkpointed, never sent)", D: "no commitment on either side"}},
           match=roots[A]["subs_root"] == roots[A]["chain_root"] and roots[A]["subs_txid"] == a_txid
           and roots[C]["subs_root"] == roots[C]["chain_root"] and roots[C]["subs_txid"] == c_txid
           and roots[B]["chain_root"] is None and roots[B]["subs_root"] is not None
           and roots[D]["subs_root"] is None and roots[D]["chain_root"] is None)
    o2v = reg.order(o2)
    g = o2v["groups"]
    pays = _payments_to(s, refund_address)
    r.step(scen, None, "no refund pays twice",
           {"groups": [{"gid": x["gid"], "attempts": [a["txid"] for a in x["attempts"]]}
                       for x in g],
            "transactions_paying_the_refund_address": pays},
           {EXPECT: {"groups": [{"gid": gid, "attempts": [refund_txid]}],
                     "transactions_paying_the_refund_address": {refund_txid: PRICE - 300}}},
           match=len(g) == 1 and [a["txid"] for a in g[0]["attempts"]] == [refund_txid]
           and pays == {refund_txid: PRICE - 300})

    # Issuance and refunds resume.
    scen = "11d. issuance and refunds resume"
    _rstep(run, scen, "A4", f"runner issue {bids[B]} confirmed: the binding check again, then "
           "sent", runner("issue", bids[B], "--confirm", bids[B]),
           {"exit": 0, "state": "broadcast"},
           lambda c, o: c == 0 and o.get("state") == "broadcast")
    prep = _rstep(run, scen, None, f"runner prepare {D}: the rebuilt batch redone from staging",
                  runner("prepare", D), {"exit": 0, "state": "checkpointed", "members": [o6]},
                  lambda c, o: c == 0 and o.get("state") == "checkpointed"
                  and o.get("members") == [o6])
    bd2 = prep.get("bid")
    _rstep(run, scen, None, f"runner issue {bd2} confirmed", runner("issue", bd2, "--confirm", bd2),
           {"exit": 0, "state": "broadcast"},
           lambda c, o: c == 0 and o.get("state") == "broadcast")
    run.mine(1)
    pending = [bids[A], bids[C], bids[B], bd2]
    _finalize(run, scen, runner, pending)
    for bid in pending:
        _certify_and_publish(run, scen, runner, bid)
    statuses = {oid: reg.order(oid)["status"] for oid in (o3, o4, o5, o6)}
    r.step(scen, None, "the in-flight orders after delivery", statuses,
           {EXPECT: {oid: "fulfilled" for oid in (o3, o4, o5, o6)}},
           match=all(v == "fulfilled" for v in statuses.values()))

    # b1's order was fulfilled before the loss, and its certificate wasn't
    # journaled. subs now builds it on b4's root, later than b1's: once that
    # root is final and covered, certify accepts it and delivers it again.
    a_root = s.spaced().call("getcommitment", A, None)["state_root"]
    out = _rstep(run, scen, "A19", f"runner certify {b1}: {o1}'s certificate again, on "
                 f"{bids[A]}'s later root", runner("certify", b1),
                 {"exit": 0, "verified": True, "delivered": True},
                 lambda c, o: c == 0 and o.get("members", {}).get(o1, {}).get("verified")
                 and o["members"][o1]["delivered"])
    status, body = _download(reg, o1)
    vdir = s.dir / "certs" / "buyer-after-restore"
    vdir.mkdir(parents=True, exist_ok=True)
    handle = "one" + A
    (vdir / f"{handle}.message.bin").write_bytes(body)
    (vdir / "anchors.json").write_text(json.dumps(run.chain.root_anchors()))
    proc = subprocess.run([str(VERIFIER), str(vdir / f"{handle}.message.bin"),
                           str(vdir / "anchors.json")], capture_output=True, text=True)
    (vdir / f"{handle}.libveritas.json").write_text(proc.stdout + proc.stderr)
    res = json.loads(proc.stdout) if proc.stdout.strip().startswith("{") else {}
    zones = res.get("zones", [])
    zone = next((z for z in zones if z["handle"] == handle), None)
    space_zone = next((z for z in zones if z["handle"] == A), None)
    got = {"page_status": reg.buyer_view(o1)["status"], "download_status": status,
           "verified": res.get("verified", False), "handle": zone is not None,
           "script_pubkey_is_the_buyer's": bool(
               zone and zone["script_pubkey"] == before["orders"][o1]["recipient_spk"]),
           "sovereign": bool(zone and zone["sovereignty"] == "sovereign"),
           "root": "b4's, later than b1's" if space_zone
           and space_zone["commitment_root"] == a_root != b1_root else
           (space_zone or {}).get("commitment_root")}
    exp = {"page_status": "fulfilled", "download_status": 200, "verified": True,
           "handle": True, "script_pubkey_is_the_buyer's": True, "sovereign": True,
           "root": "b4's, later than b1's"}
    r.step(scen, "A19", f"{o1}'s order page offers its certificate again; the buyer's download "
           "verified with libveritas against anchors read from spaced", got, {EXPECT: exp},
           match=got == exp)

    # A restore comes back with sales paused (S5); the owner resumes them.
    sales = reg.op("GET", "/operator/sales")
    got = {"paused": sales["paused"], "paused_by": sales["paused_by"]}
    r.step(scen, "S5", "the restored store's sales are paused until the owner resumes them",
           got, {EXPECT: {"paused": True, "paused_by": "restore"}},
           match=got == {"paused": True, "paused_by": "restore"})
    resumed = reg.op("POST", "/operator/sales", {"paused": False})
    got = {"paused": resumed["paused"], "acknowledged": resumed["acknowledged"]}
    r.step(scen, "S5", "the owner resumes sales", got,
           {EXPECT: {"paused": False, "acknowledged": True}},
           match=got == {"paused": False, "acknowledged": True})

    # Another batch on A after the recovery, which needs U1(b).
    o8 = _buy(run, scen, "eight", A)
    seven_address = reg.order(o7)["dest_address"]
    eight_address = reg.order(o8)["dest_address"]
    alerts = [a for a in reg.op("GET", "/operator/alerts")["alerts"]
              if a["kind"] == "destination_held"]
    r.step(scen, "H11", "the first quote after the restore: the restored wallet's next address "
           "is the unpaid quote's, and the store skips it",
           {"eight_address_differs": eight_address != seven_address,
            "alerts": [(a["oid"], json.loads(a["detail"])) for a in alerts]},
           {EXPECT: {"eight_address_differs": True, "alerts": [[o8, {"skipped": 1}]]}},
           match=eight_address != seven_address
           and [(a["oid"], json.loads(a["detail"])) for a in alerts] == [(o8, {"skipped": 1})])
    run.mine(3)
    prep = _rstep(run, scen, None, f"runner prepare {A}: the next batch after the recovery",
                  runner("prepare", A), {"exit": 0, "state": "checkpointed", "members": [o8]},
                  lambda c, o: c == 0 and o.get("state") == "checkpointed"
                  and o.get("members") == [o8])
    b_next = prep.get("bid")
    _rstep(run, scen, None, f"runner issue {b_next} confirmed",
           runner("issue", b_next, "--confirm", b_next), {"exit": 0, "state": "broadcast"},
           lambda c, o: c == 0 and o.get("state") == "broadcast")
    run.mine(1)
    _finalize(run, scen, runner, [b_next])
    _certify_and_publish(run, scen, runner, b_next)
    r.step(scen, None, f"{o8} after delivery", {"status": reg.order(o8)["status"]},
           {EXPECT: {"status": "fulfilled"}}, match=reg.order(o8)["status"] == "fulfilled")

    # A new refund after the recovery.
    o9 = _buy(run, scen, "nine", B)
    run.mine(3)
    _rstep(run, scen, None, f"runner cancel {o9}", runner("cancel", o9),
           {"exit": 0, "cancellation": "final"},
           lambda c, o: c == 0 and o.get("cancellation") == "final")
    refund9 = s.net("buyer").call("getnewaddress", "refund", "bech32m")
    reg.set_refund_address(o9, refund9)
    run.mine(3)
    built = _rstep(run, scen, None, f"runner refund {o9}", runner("refund", o9),
                   {"exit": 0, "to_buyer": PRICE - 300},
                   lambda c, o: c == 0 and o.get("to_buyer") == PRICE - 300)
    _rstep(run, scen, "A5", f"runner broadcast-refund {built.get('gid')} confirmed",
           runner("broadcast-refund", built.get("gid"), "--confirm", built.get("gid")),
           {"exit": 0, "acknowledged": True},
           lambda c, o: c == 0 and o.get("acknowledged") is True)
    run.mine(6)
    reg.observe()
    pays9, pays2 = _payments_to(s, refund9), _payments_to(s, refund_address)
    o2v, o9v = reg.order(o2), reg.order(o9)
    got = {"o2": {"paid": pays2, "closed": bool(o2v["groups"][0]["closed_by"]),
                  "refunded_total": o2v["refunded_total"], "reserved": o2v["reserved"]},
           "o9": {"paid": pays9, "closed": bool(o9v["groups"][0]["closed_by"]),
                  "refunded_total": o9v["refunded_total"]}}
    exp = {"o2": {"paid": {refund_txid: PRICE - 300}, "closed": True, "refunded_total": PRICE,
                  "reserved": 0},
           "o9": {"paid": {built.get("txid"): PRICE - 300}, "closed": True,
                  "refunded_total": PRICE}}
    r.step(scen, None, "both refunds settled, each paid once", got, {EXPECT: exp},
           match=got == exp)
    r.step(scen, None, "the store's and the controller's alerts after the recovery",
           {"store": [(a["oid"], a["kind"]) for a in reg.op("GET", "/operator/alerts")["alerts"]],
            "controller": runner("status")[1].get("controller_alerts")}, required=False)
    run.report.meta["recovery_times"] = run.times


def _download(reg, oid):
    """The buyer's certificate download from the order page."""
    import http.client
    conn = http.client.HTTPConnection("127.0.0.1", PORTS["registry"], timeout=30)
    conn.request("GET", f"/o/{reg.links[oid]}/certificate")
    resp = conn.getresponse()
    out = (resp.status, resp.read())
    conn.close()
    return out


def _subs_handles(stack, space):
    out, page = [], 1
    while True:
        r = stack.subs().get(f"/spaces/{space}/handles?filter=committed&page={page}&per_page=100")
        out.extend(r["handles"])
        if page >= max(1, r["total_pages"]):
            return out
        page += 1


def _payments_to(stack, address):
    """txid -> sats paid to `address`, over the chain and the network's
    mempool, from the buyer's wallet's view."""
    w = stack.net("buyer")
    out = {}
    for t in w.call("listtransactions", "*", 1000, 0, True):
        if t.get("address") == address and t["category"] == "receive":
            out[t["txid"]] = out.get(t["txid"], 0) + int(round(t["amount"] * 1e8))
    return out


def main(argv):
    scenarios.Run = RecoveryRun
    scenarios.recovery_rehearsal = recovery_rehearsal
    return scenarios.main(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
