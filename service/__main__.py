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
                 "refund_fee_sats": 300, "hot_wallet_cap_sats": 1000000,
                 "exposure_limit_sats": null},
      "poll_seconds": 2
    }

Mainnet requires the explicit private_attended_test configuration and
a loopback listener. Configuration is not transaction authorization. A token
file that doesn't exist is created with a fresh random token, mode 0600.
"""

import json
import secrets
import signal
import sys
import threading
from pathlib import Path

from .app import Service
from .bitcoin import BitcoinChainView
from .journal import Journal
from .ledger import Ledger, Policy, Refused, RestoreRefused, RestoreRequired, restore_from_journal
from .rpc import BitcoinRpc
from .private_purchase import ConfigError, loopback, private_config, require_indexed_node


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
    validate(cfg)
    return cfg


def validate(cfg):
    private = private_config(cfg)
    host = cfg.get("listen", {}).get("host", "127.0.0.1")
    if not loopback(host):
        raise ConfigError("the service listens on loopback only")
    return private


def _limit(v):
    """`exposure_limit_sats`: absent or null for no limit, else a positive
    whole number of sats."""
    if v is None:
        return None
    if not isinstance(v, int) or isinstance(v, bool) or v <= 0:
        raise ConfigError("policy.exposure_limit_sats must be null or a positive integer")
    return v


def build(cfg):
    private = validate(cfg)
    b = cfg["bitcoind"]
    node = BitcoinRpc(b["url"], b["cookie"])
    chain = node.call("getblockchaininfo")["chain"]
    expected = "main" if cfg["network"] == "mainnet" else "regtest"
    if chain != expected:
        raise ConfigError(f"bitcoind is on {chain}, not {expected}")
    if cfg["network"] == "mainnet":
        require_indexed_node(node)
    wallet = BitcoinRpc(b["url"], b["cookie"], wallet=b["wallet"])
    if cfg["network"] == "mainnet":
        info = wallet.call("getwalletinfo")
        if info.get("private_keys_enabled") is not True or info.get("scanning") is not False:
            raise ConfigError("the private test requires a loaded signing wallet that is not rescanning")
    view = BitcoinChainView(node, wallet)
    p = cfg.get("policy", {})
    policy = Policy(hold_seconds=int(p.get("hold_minutes", 15) * 60),
                    excess_minimum_over_fee=int(p.get("excess_minimum_over_fee", 546)),
                    refund_fee=int(p.get("refund_fee_sats", 300)),
                    exposure_limit_sats=_limit(p.get("exposure_limit_sats")))
    ledger = Ledger(cfg["db"], view, Journal(cfg["journal_dir"]), policy,
                    private_purchase=private)
    return Service(ledger, view, read_token(cfg["tokens"]["operator"]),
                   read_token(cfg["tokens"]["subs"]),
                   private.price_sats if private else int(p.get("hot_wallet_cap_sats", 1_000_000)),
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
    except (ConfigError, RestoreRequired, Refused) as e:
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
