"""The private test's configuration and permanent one-order allowance.

The allowance is a journaled setting, consumed in the quote transaction.
It is independent of the name's temporary hold and of the sales pause.
"""

import ipaddress
import json
from dataclasses import asdict, dataclass
from urllib.parse import urlsplit


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class PrivatePurchase:
    handle: str
    script_pubkey: str
    price_sats: int
    max_fee_rate_sat_vb: int
    refund_fee_rate_sat_vb: int
    network: str = "regtest"

    def admission(self):
        return {k: v for k, v in asdict(self).items()
                if k in ("handle", "script_pubkey", "price_sats", "network")}

    def fee_rate(self, rate):
        if type(rate) is not int or not 0 < rate <= self.max_fee_rate_sat_vb:
            raise ConfigError("an explicit positive fee rate within the private test ceiling is required")
        return rate


def private_config(config):
    """Called before opening databases, reading credentials or making RPCs."""
    from .ledger import canonical_handle, valid_p2tr

    if not isinstance(config, dict) or config.get("network") not in ("regtest", "mainnet"):
        raise ConfigError("only regtest or an explicit private mainnet test is supported")
    raw = config.get("private_attended_test")
    if raw is None and config["network"] == "regtest":
        return None
    fields = set(PrivatePurchase.__dataclass_fields__) - {"network"}
    if not isinstance(raw, dict) or set(raw) != fields:
        raise ConfigError("private_attended_test must specify the handle, script_pubkey, price_sats, "
                          "max_fee_rate_sat_vb and refund_fee_rate_sat_vb")
    p = PrivatePurchase(**raw, network=config["network"])
    if not canonical_handle(p.handle) or not valid_p2tr(p.script_pubkey):
        raise ConfigError("private_attended_test requires a canonical handle and valid P2TR script")
    if type(p.price_sats) is not int or p.price_sats != 1000:
        raise ConfigError("the private purchase price must be 1000 sats")
    if type(p.max_fee_rate_sat_vb) is not int or p.max_fee_rate_sat_vb <= 0:
        raise ConfigError("max_fee_rate_sat_vb must be a positive integer")
    p.fee_rate(p.refund_fee_rate_sat_vb)
    return p


def loopback(host):
    try:
        return ipaddress.ip_address(host).is_loopback
    except (ValueError, TypeError):
        return False


def private_runner_urls(config):
    # The relay is external. Core may be an authenticated remote node.
    # Store/subs/spaced remain inside the VM's loopback network.
    for section, key in (("store", "url"), ("spaced", "url"),
                         ("subs", "url"), ("subs", "write_url")):
        url = config.get(section, {}).get(key)
        if section == "subs" and key == "write_url" and url is None:
            continue
        try:
            host = urlsplit(url).hostname
        except (ValueError, TypeError):
            host = None
        if not loopback(host):
            raise ConfigError(f"{section}.{key} must use a loopback IP for the private test")


def require_indexed_node(node):
    info = node.call("getblockchaininfo")
    index = node.call("getindexinfo", "txindex").get("txindex", {})
    if info.get("initialblockdownload") is not False or index.get("synced") is not True:
        raise ConfigError("the private test requires a synced node and transaction index")


class Allowance:
    POLICY = "private_purchase_policy"
    ORDER = "private_purchase_order"

    def __init__(self, ledger, config):
        from .ledger import Refused, RestoreRequired

        self.ledger, self.config = ledger, config
        saved = ledger._setting(self.POLICY)
        used = ledger._setting(self.ORDER)
        # A stale database must not forget a journaled consumption.
        journaled = {}
        journal_has_orders = False
        for entry in ledger.journal.entries():
            for r in entry.get("records", []):
                journal_has_orders |= r["kind"] == "order"
                if r["kind"] == "setting" and r["key"] in (self.POLICY, self.ORDER):
                    journaled[r["key"]] = r["state"]["value"]
        if any(ledger._setting(k) != v for k, v in journaled.items()):
            raise RestoreRequired("private purchase database is behind its journal; restore it")
        if config is None:
            if saved is not None or used is not None:
                raise Refused("the recorded private purchase configuration is required")
            return
        encoded = json.dumps(config.admission(), sort_keys=True)
        if saved is not None and saved != encoded:
            raise Refused("the private purchase allowance cannot be changed")
        if saved is None:
            if used is not None or journal_has_orders \
                    or ledger.db.execute("select 1 from orders limit 1").fetchone():
                raise Refused("a private purchase must start with an empty order history")
            with ledger.tx():
                ledger._put_setting(self.POLICY, encoded)
            ledger.flush_journal()
        if used is not None:
            order = ledger._order(used)
            self.check(order)
            if order["dest_script"] is None:
                raise RestoreRequired("private purchase allowance has no invoice; restore it")
        issued = ledger.db.execute("select oid from orders where dest_script is not null").fetchall()
        if any(r["oid"] != used for r in issued):
            raise RestoreRequired("private purchase invoice history disagrees with its allowance")

    def request(self, handle, script):
        from .ledger import Refused

        if self.config and ((handle, script) != (self.config.handle, self.config.script_pubkey)
                            or self.ledger._setting(self.ORDER) is not None):
            raise Refused("only the configured private purchase order is allowed; reuse its order link")

    def price(self, handle, price):
        from .ledger import Refused

        if self.config and handle == self.config.handle and price != self.config.price_sats:
            raise Refused("the private purchase price cannot be changed")

    def check(self, order):
        from .ledger import Refused

        if not self.config:
            return
        used = self.ledger._setting(self.ORDER)
        if (order["name"], order["recipient_spk"]) != (self.config.handle, self.config.script_pubkey) \
                or (used is not None and used != order["oid"]):
            raise Refused("the private purchase allowance does not admit this order")
        price = order["price"] if order["dest_script"] else self.ledger._name(order["name"])["price"]
        if price != self.config.price_sats:
            raise Refused("the private purchase price differs from its allowance")

    def consume(self, order):
        self.check(order)
        if self.config:
            self.ledger._put_setting(self.ORDER, order["oid"])

    def acknowledged(self, oid):
        if not self.config:
            return True
        return self.ledger._setting(self.ORDER) == oid and not self.ledger.db.execute(
            "select 1 from journal_backlog where kind = 'setting' and key in (?, ?)",
            (self.POLICY, self.ORDER)).fetchone()
