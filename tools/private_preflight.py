"""Read-only checks inside the private purchase's clean Linux VM.

Usage: python3 tools/private_preflight.py STORE_CONFIG RUNNER_CONFIG

This does not construct the store or controller, open their databases,
create wallets, sign, broadcast, start stack processes or change settings.
Only the explicitly listed read RPCs and HTTP routes below are allowed.
Output omits endpoints, paths, wallet names, credentials and RPC bodies.
PASS means the automated checks passed, not that isolation or spending
has been authorized. Run in the same network namespace as the services.
"""

import argparse
import base64
import ipaddress
import json
import os
import stat as file_stat
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import quote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from controller.host import check as check_runner  # noqa: E402
from service.private_purchase import loopback, private_config, private_runner_urls  # noqa: E402

READS = {
    "store_node": {"getblockchaininfo", "getindexinfo", "listwallets", "listwalletdir"},
    "runner_node": {"getblockchaininfo", "getindexinfo", "getblockheader"},
    "store_wallet": {"getwalletinfo"},
    "spaced": {"getserverinfo", "walletgetinfo"},
}
MANUAL = [
    "Verify the machine is the intended clean VM or separate machine, with no host wallet shares.",
    "Inspect hypervisor shares and bind mounts; their absence cannot be proved from inside the VM.",
    "Verify journals and snapshots are on the intended separate storage and backups are protected.",
    "Repeat the external network-confinement checks and recheck the throwaway space before spending.",
    "Complete and authorize the transaction budget; this report authorizes no wallet action.",
]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("redirect refused")


def valid_url(url):
    u = urlsplit(url)
    if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password \
            or u.query or u.fragment:
        raise ValueError("invalid endpoint")
    if u.port is not None and not 0 < u.port < 65536:
        raise ValueError("invalid port")
    return u


class Reader:
    def __init__(self, store, runner):
        b, r, sp = store["bitcoind"], runner["bitcoind"], runner["spaced"]
        self.rpc = {
            "store_node": (b["url"], b["cookie"]),
            "runner_node": (r["url"], r["cookie_file"]),
            "store_wallet": (b["url"].rstrip("/") + "/wallet/" + quote(b["wallet"], safe=""),
                             b["cookie"]),
            "spaced": (sp["url"], sp["cookie_file"]),
        }
        self.store, self.runner = store, runner
        # Never send local credentials through an ambient HTTP proxy or
        # forward them to a redirect target.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def _read(self, url, body=None, auth=None):
        valid_url(url)
        headers = {"Content-Type": "application/json"}
        if auth:
            headers["Authorization"] = auth
        req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                     headers=headers)
        with self.opener.open(req, timeout=10) as response:
            raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError("response too large")
        return json.loads(raw)

    def call(self, component, method, *params):
        if method not in READS.get(component, set()):
            raise ValueError("RPC is not a preflight read")
        url, cookie = self.rpc[component]
        auth = "Basic " + base64.b64encode(Path(cookie).read_bytes().strip()).decode()
        out = self._read(url, {"jsonrpc": "2.0", "id": 1, "method": method,
                               "params": list(params)}, auth)
        if out.get("error"):
            raise ValueError("RPC refused")
        return out["result"]

    def status(self):
        token = Path(self.runner["store"]["operator_token_file"]).read_text().strip()
        return self._read(self.runner["store"]["url"].rstrip("/") + "/operator/status",
                          auth="Bearer " + token)

    def subs(self, url):
        base = url.rstrip("/")
        endpoints = self._read(base + "/rpc/endpoints")
        out = self._read(base + "/rpc/spaced",
                         {"method": "getserverinfo", "params": []})
        if out.get("error"):
            raise ValueError("subs read refused")
        return endpoints, out["result"]


def listeners(text):
    """ss -H -ltn, including bracketed IPv6 and wildcard listeners."""
    result = []
    for line in text.splitlines():
        fields = line.split()
        if len(fields) < 5 or fields[0] != "LISTEN":
            raise ValueError("unrecognized listener inventory")
        host, port = fields[3].rsplit(":", 1)
        result.append((host.strip("[]"), int(port)))
    return result


def listener_check(text, ports):
    seen = listeners(text)
    return all(any(p == port for _, p in seen)
               and all(loopback(host) for host, p in seen if p == port) for port in ports)


def shared_mounts(text):
    # Known guest-share types. A normal filesystem can also be a bind
    # mount from the host, so zero matches is never proof of isolation.
    types = {"9p", "virtiofs", "vboxsf", "fuse.vmhgfs-fuse", "fuse.sshfs"}
    return sum(line.split(" - ", 1)[1].split()[0] in types for line in text.splitlines())


def directory_device(path, stat=os.stat):
    """Device where a directory would be created, without creating it.

    Resolve existing symlinks first and ascend only for missing paths.
    Unreadable paths and non-directory parents must still fail the check.
    This reports today's mount layout, not a promised future mount.
    """
    path = Path(path).resolve()
    while True:
        try:
            info = stat(path)
        except FileNotFoundError:
            if path == path.parent:
                raise
            path = path.parent
        else:
            if not file_stat.S_ISDIR(info.st_mode):
                raise NotADirectoryError("storage path is not a directory")
            return info.st_dev


def check(store, runner, *, expected="mainnet", reader=None, ss=None, mounts=None, stat=os.stat):
    checks = []

    def record(name, action):
        try:
            passed = bool(action())
            detail = "passed" if passed else "condition not met"
        except Exception as e:
            passed, detail = False, type(e).__name__ + "; details withheld"
        checks.append({"check": name, "pass": passed, "detail": detail})
        return passed

    def configuration():
        nonlocal private, ports
        private = private_config(store)
        other = private_config(runner)
        check_runner(runner)
        private_runner_urls(runner)
        if private is None or private != other or store["network"] != expected:
            return False
        listen = store.get("listen", {})
        host, port = listen.get("host", "127.0.0.1"), listen.get("port", 18951)
        if not loopback(host) or type(port) is not int or not 0 < port < 65536:
            return False
        ports = {port}
        for section in ("store", "spaced", "subs", "bitcoind"):
            u = valid_url(runner[section]["url"])
            if loopback(u.hostname):
                ports.add(u.port or (443 if u.scheme == "https" else 80))
        for url in (store["bitcoind"]["url"], runner["subs"].get("write_url", runner["subs"]["url"])):
            u = valid_url(url)
            if loopback(u.hostname):
                ports.add(u.port or (443 if u.scheme == "https" else 80))
        target = valid_url(runner["store"]["url"])
        if target.port != port or ipaddress.ip_address(target.hostname) != ipaddress.ip_address(host):
            return False
        for a, b in ((store["db"], runner["store"]["db"]),
                     (store["journal_dir"], runner["store"]["journal_dir"]),
                     (store["tokens"]["operator"], runner["store"]["operator_token_file"])):
            if Path(a).resolve() != Path(b).resolve():
                return False
        return True

    private, ports = None, set()
    if not record("matching private configuration", configuration):
        return {"automated_checks": "FAIL", "expected_network": expected,
                "checks": checks, "manual_checks": MANUAL}
    reader = reader or Reader(store, runner)
    infos = {}
    core_network = "main" if expected == "mainnet" else expected

    def node(component):
        info = reader.call(component, "getblockchaininfo")
        infos[component] = info
        index = reader.call(component, "getindexinfo", "txindex").get("txindex", {})
        return (info["chain"] == core_network and info["initialblockdownload"] is False
                and info["blocks"] == info["headers"] and index.get("synced") is True)

    for component in ("store_node", "runner_node"):
        record(component + " network, sync and index", lambda c=component: node(c))

    def wallet():
        info = reader.call("store_wallet", "getwalletinfo")
        return (info.get("private_keys_enabled") is True and info.get("scanning") is False
                and ("unlocked_until" not in info or info["unlocked_until"] > time.time()))

    record("loaded store signing wallet", wallet)
    record("only the intended Core wallet is loaded", lambda:
           set(reader.call("store_node", "listwallets")) == {store["bitcoind"]["wallet"]})
    record("only the intended wallet is registered in Core's wallet directory", lambda:
           {w["name"] for w in reader.call("store_node", "listwalletdir")["wallets"]}
           == {store["bitcoind"]["wallet"]})

    def on_chain(block):
        return bool(block) and reader.call("runner_node", "getblockheader", block)["confirmations"] >= 1

    def spaced():
        info = reader.call("spaced", "getserverinfo")
        w = reader.call("spaced", "walletgetinfo", runner["controller"]["operator_wallet"])
        return info["network"] == expected and on_chain(info["tip"]["hash"]) \
            and w["tip"] == infos["runner_node"]["blocks"]

    record("spaced network, chain and operator wallet sync", spaced)

    def status():
        value = reader.status()
        chain = value["chain"]
        return value["private_attended_test"] == vars(private) and chain["network"] == core_network \
            and on_chain(chain["best_block_hash"]) and value["journal_backlog"] == 0

    record("running store configuration, chain and journal backlog", status)
    for key in ("url", "write_url"):
        def subs(k=key):
            url = runner["subs"].get(k, runner["subs"]["url"])
            endpoints, info = reader.subs(url)
            return endpoints["wallet"] == runner["controller"]["operator_wallet"] \
                and info["network"] == expected and on_chain(info["tip"]["hash"])
        record("subs " + key + " wallet and chain", subs)

    def sockets():
        text = ss if ss is not None else subprocess.run(
            ["ss", "-H", "-ltn"], check=True, capture_output=True, text=True, timeout=10).stdout
        return listener_check(text, ports)

    record("configured local TCP ports listen only on loopback", sockets)
    record("no recognized VM shared-folder mount type", lambda: shared_mounts(
        mounts if mounts is not None else Path("/proc/self/mountinfo").read_text()) == 0)

    def storage():
        c = runner["controller"]
        data_devices = {directory_device(Path(store["db"]).parent, stat),
                        directory_device(c["dir"], stat)}
        recovery = [store["journal_dir"], c["journal_dir"],
                    c.get("snapshot_dir", str(Path(c["journal_dir"]) / "snapshots"))]
        recovery_devices = [directory_device(p, stat) for p in recovery]
        return all(device not in data_devices for device in recovery_devices)

    record("journal and snapshot filesystem devices differ from databases", storage)
    return {"automated_checks": "PASS" if all(c["pass"] for c in checks) else "FAIL",
            "expected_network": expected, "checks": checks, "manual_checks": MANUAL}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("store_config")
    parser.add_argument("runner_config")
    parser.add_argument("--expected-network", choices=("mainnet", "regtest"), default="mainnet")
    args = parser.parse_args(argv)
    try:
        store = json.loads(Path(args.store_config).read_text())
        runner = json.loads(Path(args.runner_config).read_text())
        result = check(store, runner, expected=args.expected_network)
    except Exception as e:
        result = {"automated_checks": "FAIL", "checks": [], "manual_checks": MANUAL,
                  "error": type(e).__name__ + "; details withheld"}
    print(json.dumps(result, indent=2))
    return 0 if result["automated_checks"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
