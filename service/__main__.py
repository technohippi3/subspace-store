"""Run the store service: python3 -m service <config.json>

After a host loss, rebuild its database from the off-host journal alone,
into the configured path, which must not hold a database:

    python3 -m service restore <config.json>

A start that finds no store database while the journal has entries refuses
to serve until this has been run (PAYMENT-SPEC.md, "Host loss and restore").

The configuration names files and endpoints, never credentials:

    {
      "network": "regtest",
      "listen": {"host": "127.0.0.1", "port": 18951},
      "db": "/path/to/store.db",
      "journal_dir": "/path/on/another/volume",
      "bitcoind": {"url": "http://127.0.0.1:18443", "cookie": "/path/.cookie",
                   "wallet": "store"},
      "tokens": {"operator": "/path/operator-token", "subs": "/path/registry-token"},
      "policy": {"hold_minutes": 15, "excess_minimum_over_fee": 546,
                 "refund_fee_sats": 300, "hot_wallet_cap_sats": 1000000},
      "poll_seconds": 2
    }

Only regtest is accepted, and only a loopback listener: the project
authorizes no mainnet, no real funds and no production deployment. A token
file that doesn't exist is created with a fresh random token, mode 0600.
"""

import ipaddress
import json
import secrets
import signal
import sys
import threading
from pathlib import Path

from .app import Service
from .bitcoin import BitcoinChainView
from .journal import Journal
from .ledger import Ledger, Policy, RestoreRefused, RestoreRequired, restore_from_journal
from .rpc import BitcoinRpc


class ConfigError(Exception):
    pass


def read_token(path):
    p = Path(path)
    if not p.exists():
        p.write_text(secrets.token_urlsafe(32))
        p.chmod(0o600)
    token = p.read_text().strip()
    if len(token) < 24:
        raise ConfigError(f"token in {path} is too short")
    return token


def load(path):
    cfg = json.loads(Path(path).read_text())
    if cfg.get("network") != "regtest":
        raise ConfigError("only regtest is supported: no mainnet, testnet or signet")
    host = cfg.get("listen", {}).get("host", "127.0.0.1")
    if not ipaddress.ip_address(host).is_loopback:
        raise ConfigError("the service listens on loopback only")
    return cfg


def build(cfg):
    b = cfg["bitcoind"]
    node = BitcoinRpc(b["url"], b["cookie"])
    chain = node.call("getblockchaininfo")["chain"]
    if chain != "regtest":
        raise ConfigError(f"bitcoind is on {chain}, not regtest")
    wallet = BitcoinRpc(b["url"], b["cookie"], wallet=b["wallet"])
    view = BitcoinChainView(node, wallet)
    p = cfg.get("policy", {})
    policy = Policy(hold_seconds=int(p.get("hold_minutes", 15) * 60),
                    excess_minimum_over_fee=int(p.get("excess_minimum_over_fee", 546)),
                    refund_fee=int(p.get("refund_fee_sats", 300)))
    ledger = Ledger(cfg["db"], view, Journal(cfg["journal_dir"]), policy)
    return Service(ledger, view, read_token(cfg["tokens"]["operator"]),
                   read_token(cfg["tokens"]["subs"]),
                   int(p.get("hot_wallet_cap_sats", 1_000_000)),
                   poll_seconds=float(cfg.get("poll_seconds", 2)))


def restore(cfg):
    counts = restore_from_journal(cfg["db"], Journal(cfg["journal_dir"]))
    print(f"restored {cfg['db']} from the off-host journal: {json.dumps(counts)}", flush=True)
    return 0


def main(argv):
    if len(argv) == 3 and argv[1] == "restore":
        try:
            return restore(load(argv[2]))
        except (ConfigError, RestoreRefused) as e:
            print(f"refusing to restore: {e}", file=sys.stderr)
            return 3
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        cfg = load(argv[1])
        service = build(cfg)
    except (ConfigError, RestoreRequired) as e:
        print(f"refusing to start: {e}", file=sys.stderr)
        return 3
    service.start()
    listen = cfg.get("listen", {})
    service.serve(listen.get("host", "127.0.0.1"), int(listen.get("port", 18951)))
    print(f"store service listening on {listen.get('host', '127.0.0.1')}:"
          f"{listen.get('port', 18951)}; startup {json.dumps(service.startup)}", flush=True)
    done = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *a: done.set())
    done.wait()
    service.shutdown()
    service.ledger.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
