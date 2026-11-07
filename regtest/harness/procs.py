"""Start and stop the local regtest stack.

bitcoind (regtest, preset chain from spaces' test utilities), spaced v0.5.0,
subs-prover and subs at the pinned commit. Every process listens on
127.0.0.1 only, and its data lives under regtest/.run/<run>/. Two fault
proxies sit in front of spaced and subs so that a scenario can drop one
response (see faultproxy.py).
"""

import hashlib
import hmac
import json
import os
import secrets
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from .rpc import JsonRpc, Http

HERE = Path(__file__).resolve().parent.parent
CACHE = HERE / ".cache"
BIN = CACHE / "bin"
PRESET = CACHE / "preset" / "bitcoin_core_regtest_data"

PORTS = {
    "bitcoind": 18943,
    "spaced": 18944,
    "spaced_proxy": 18945,
    "subs": 18946,
    "subs_proxy": 18947,
    "prover": 18948,
    "registry": 18949,
    "certrelay": 18950,
}

OPERATOR_WALLET = "wallet_99"  # an upstream regtest test wallet; see README


def relay_enabled():
    """True when a run publishes to a local certrelay (SUBSPACE_RELAY=1).
    Then subs is started with `--fabric-seed` naming that relay alone, which
    needs the subs build with `upstream/subs-fabric-seed.patch` (finding R19):
    the pinned subs has no such flag, so clap would stop it at startup. The
    relay runs in the same namespace with no seeds of its own."""
    return os.environ.get("SUBSPACE_RELAY") == "1"


def relay_url():
    return f"http://127.0.0.1:{PORTS['certrelay']}"


def subs_bin():
    """The pinned subs, or another build named by SUBSPACE_SUBS_BIN, such as
    subs with the U1(b) patch in `regtest/upstream/`. A run records which."""
    import os
    return Path(os.environ.get("SUBSPACE_SUBS_BIN") or BIN / "subs")


class Stack:
    def __init__(self, run="default"):
        self.run = run
        self.dir = HERE / ".run" / run
        self.logs = self.dir / "logs"
        self.pids = self.dir / "pids"

    # Paths

    @property
    def btc_dir(self):
        return self.dir / "bitcoind"

    @property
    def spaced_dir(self):
        return self.dir / "spaced"

    @property
    def subs_dir(self):
        return self.dir / "subs"

    def btc_cookie(self):
        return self.btc_dir / "regtest" / ".cookie"

    def spaced_cookie(self):
        found = sorted(self.spaced_dir.rglob(".cookie"))
        if not found:
            raise FileNotFoundError("spaced cookie not written yet")
        return found[0]

    # Clients

    def btc(self, wallet=None):
        url = f"http://127.0.0.1:{PORTS['bitcoind']}"
        if wallet:
            url += f"/wallet/{wallet}"
        return JsonRpc(url, self.btc_cookie())

    def spaced(self):
        return JsonRpc(f"http://127.0.0.1:{PORTS['spaced']}", self.spaced_cookie())

    def subs(self, via_proxy=False, timeout=600):
        port = PORTS["subs_proxy"] if via_proxy else PORTS["subs"]
        return Http(f"http://127.0.0.1:{port}", timeout=timeout)

    # Processes

    def _spawn(self, name, argv, env=None):
        self.logs.mkdir(parents=True, exist_ok=True)
        self.pids.mkdir(parents=True, exist_ok=True)
        log = open(self.logs / f"{name}.log", "ab")
        full_env = dict(os.environ)
        full_env.update(env or {})
        p = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, env=full_env,
                             start_new_session=True)
        (self.pids / f"{name}.pid").write_text(str(p.pid))
        return p

    @staticmethod
    def _alive(pid):
        """True while the process exists and has not exited. A child that
        exited is reaped here, and a zombie counts as exited."""
        try:
            if os.waitpid(pid, os.WNOHANG)[0] == pid:
                return False
        except ChildProcessError:
            pass  # not our child
        try:
            state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
        except (FileNotFoundError, IndexError):
            return False
        return state != "Z"

    def _pid(self, name):
        f = self.pids / f"{name}.pid"
        if not f.exists():
            return None
        try:
            pid = int(f.read_text())
        except ValueError:
            return None
        return pid if self._alive(pid) else None

    def running(self, name):
        return self._pid(name) is not None

    def stop_process(self, name, timeout=60):
        pid = self._pid(name)
        if pid is None:
            return
        os.kill(pid, signal.SIGTERM)
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not self._alive(pid):
                break
            time.sleep(0.2)
        else:
            os.kill(pid, signal.SIGKILL)
            time.sleep(0.5)
            self._alive(pid)
        (self.pids / f"{name}.pid").unlink(missing_ok=True)

    def _wait(self, what, check, timeout=120):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            try:
                if check():
                    return
            except Exception as e:  # noqa: BLE001 - waiting for a service
                last = e
            time.sleep(0.5)
        raise TimeoutError(f"{what} not ready: {last}")

    def init(self):
        """Create a fresh run directory from the preset chain."""
        if self.dir.exists():
            raise FileExistsError(f"{self.dir} exists; stop and remove it first")
        if not PRESET.exists():
            raise FileNotFoundError("run regtest/fetch.sh first")
        self.dir.mkdir(parents=True)
        shutil.copytree(PRESET / "bitcoind", self.btc_dir)
        # spaced v0.5.0 sends a cookie file's contents unencoded as the Basic
        # token, which bitcoind rejects, so spaced gets a throwaway rpcauth
        # user made for this run. It never leaves the run directory.
        user, password, salt = "spaced", secrets.token_hex(16), secrets.token_hex(16)
        digest = hmac.new(salt.encode(), password.encode(), hashlib.sha256).hexdigest()
        secret = self.dir / "spaced-bitcoin-rpc.json"
        secret.write_text(json.dumps({"user": user, "password": password,
                                      "rpcauth": f"{user}:{salt}${digest}"}))
        secret.chmod(0o600)
        self.spaced_dir.mkdir()
        self.subs_dir.mkdir()

    def start_bitcoind(self):
        if self.running("bitcoind"):
            return
        self._spawn("bitcoind", [
            str(BIN / "bitcoind"), f"-datadir={self.btc_dir}", "-regtest",
            "-txindex=1", "-listen=0", "-dnsseed=0", "-fixedseeds=0",
            "-rpcbind=127.0.0.1", "-rpcallowip=127.0.0.1",
            f"-rpcport={PORTS['bitcoind']}", "-fallbackfee=0.0001",
            "-rpcworkqueue=100", "-printtoconsole=1",
            f"-rpcauth={self._spaced_btc_auth()['rpcauth']}",
        ])
        self._wait("bitcoind", lambda: self.btc().call("getblockchaininfo"))

    def _spaced_btc_auth(self):
        return json.loads((self.dir / "spaced-bitcoin-rpc.json").read_text())

    def start_spaced(self):
        if self.running("spaced"):
            return
        auth = self._spaced_btc_auth()
        self._spawn("spaced", [
            str(BIN / "spaced"), "--chain", "regtest",
            "--bitcoin-rpc-url", f"http://127.0.0.1:{PORTS['bitcoind']}",
            "--block-index-full",
            "--rpc-bind", "127.0.0.1", "--rpc-port", str(PORTS["spaced"]),
            "--data-dir", str(self.spaced_dir),
        ], env={"SPACED_BITCOIN_RPC_USER": auth["user"],
                "SPACED_BITCOIN_RPC_PASSWORD": auth["password"]})
        self._wait("spaced", lambda: self.spaced().call("getserverinfo"))

    def start_prover(self):
        if self.running("prover"):
            return
        self._spawn("prover", [str(BIN / "subs-prover"), "--server",
                               "--server-port", str(PORTS["prover"])],
                    env={"RUST_LOG": "info"})
        self._wait("subs-prover", lambda: Http(
            f"http://127.0.0.1:{PORTS['prover']}", timeout=5).get("/health", raw=True) is not None)

    def start_subs(self, via_spaced_proxy=True):
        if self.running("subs"):
            return
        spaced_port = PORTS["spaced_proxy"] if via_spaced_proxy else PORTS["spaced"]
        relay_args = []
        if relay_enabled():
            self.start_certrelay()
            relay_args = ["--fabric-seed", relay_url()]
        self._spawn("subs", [
            str(subs_bin()), "--port", str(PORTS["subs"]),
            "--data-dir", str(self.subs_dir), "--wallet", OPERATOR_WALLET,
            "--rpc-url", f"http://127.0.0.1:{spaced_port}",
            "--rpc-cookie", str(self.spaced_cookie()),
            *relay_args,
        ], env={"RUST_LOG": "info,subsd=info,subs_core=info"})
        self._wait("subs", lambda: self.subs().get("/status", timeout=10) is not None)

    @property
    def certrelay_dir(self):
        return self.dir / "certrelay"

    def start_certrelay(self):
        """The pinned certrelay (the commit subs locks), on regtest, against
        this run's spaced directly. It is a bootstrap relay with no seeds, so
        it announces to and syncs from nobody, and it listens on 127.0.0.1
        inside the namespace. The spaced credentials go through the
        environment, not the command line."""
        if self.running("certrelay"):
            return
        self.certrelay_dir.mkdir(exist_ok=True)
        token = self.spaced_cookie().read_text().strip()
        self._spawn("certrelay", [
            str(BIN / "certrelay"), "--chain", "regtest",
            "--data-dir", str(self.certrelay_dir),
            "--bind", "127.0.0.1", "--port", str(PORTS["certrelay"]),
            "--self-url", relay_url(), "--is-bootstrap",
            "--anchor-refresh", "1", "--allow-private-peers",
        ], env={"RUST_LOG": "info",
                "CERTRELAY_SPACED_RPC_URL": f"http://{token}@127.0.0.1:{PORTS['spaced']}"})
        self._wait("certrelay", lambda: Http(relay_url(), timeout=5).get("/health", raw=True) is not None)

    def start_proxies(self):
        for name, listen, target in (("spaced_proxy", "spaced_proxy", "spaced"),
                                     ("subs_proxy", "subs_proxy", "subs")):
            if self.running(name):
                continue
            self._spawn(name, [sys.executable, "-P", "-m", "regtest.harness.faultproxy",
                               str(PORTS[listen]), str(PORTS[target]),
                               str(self.dir / f"{name}.ctl")],
                        env={"PYTHONPATH": str(HERE.parent)})
        self._wait("proxies", lambda: Http(
            f"http://127.0.0.1:{PORTS['spaced_proxy']}", timeout=5).get("/__proxy__"))

    def stop_all(self):
        for name in ("registry", "subs", "certrelay", "subs_proxy", "prover",
                     "spaced_proxy", "spaced", "bitcoind"):
            self.stop_process(name)


def main(argv):
    if len(argv) < 2 or argv[1] not in ("start", "stop", "status"):
        print("usage: procs.py start|stop|status [run]")
        return 2
    stack = Stack(argv[2] if len(argv) > 2 else "default")
    if argv[1] == "start":
        from .scenarios import isolated
        if not isolated():
            print("refusing to start: not inside an isolated network namespace; "
                  "use regtest/start.sh")
            return 3
        if not stack.dir.exists():
            stack.init()
        stack.start_bitcoind()
        stack.start_spaced()
        stack.start_proxies()
        stack.start_prover()
        stack.start_subs()
        print(f"running in {stack.dir}")
    elif argv[1] == "stop":
        stack.stop_all()
        print("stopped")
    else:
        for name in PORTS:
            print(name, "running" if stack.running(name) else "stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
