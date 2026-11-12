"""Explicit TypeScript pilot selection, separate from the frozen private test."""
from dataclasses import dataclass
import re


class ConfigError(ValueError):
    pass


GENESIS = {"mainnet": "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
           "regtest": "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206"}


@dataclass(frozen=True)
class PublicPilot:
    version: int
    space: str
    minimum_fee_rate_sat_vb: int
    maximum_fee_rate_sat_vb: int

    def fee_rate(self, rate):
        if type(rate) is not int or not self.minimum_fee_rate_sat_vb <= rate <= self.maximum_fee_rate_sat_vb:
            raise ConfigError("an explicit issuance fee rate within the public pilot bounds is required")
        return rate


def public_config(config):
    raw = config.get("public_pilot") if isinstance(config, dict) else None
    if raw is None:
        return None
    from service.ledger import canonical_handle
    if not isinstance(config.get("network"), str) or config["network"] not in GENESIS or config.get("private_attended_test") is not None or \
            not isinstance(config.get("store"), dict) or config["store"].get("implementation") != "typescript" or \
            not isinstance(raw, dict) or set(raw) != set(PublicPilot.__dataclass_fields__):
        raise ConfigError("public_pilot requires an explicit TypeScript network and separate exact configuration")
    p = PublicPilot(**raw)
    if type(p.version) is not int or p.version != 1 or not isinstance(p.space, str) or not canonical_handle("name@" + p.space) or \
            type(p.minimum_fee_rate_sat_vb) is not int or type(p.maximum_fee_rate_sat_vb) is not int or \
            not 1 <= p.minimum_fee_rate_sat_vb <= p.maximum_fee_rate_sat_vb <= 100000:
        raise ConfigError("public_pilot requires one canonical space and positive bounded issuance fee rates")
    return p


def qualify(runner, status, btc, spaced):
    """Read-only fresh evidence; no keys, addresses or token values returned."""
    node = runner.c.btc
    identity = status.get("installation_identity") or {}
    if identity.get("network") != {"mainnet": "main", "regtest": "regtest"}[runner.network] or \
            identity.get("genesis") != GENESIS[runner.network] or \
            not isinstance(identity.get("wallet"), str) or not identity["wallet"] or \
            not re.fullmatch("[0-9a-f]{64}", identity.get("descriptorHash", "")) or \
            node.call("getblockhash", 0) != GENESIS[runner.network]:
        raise ConfigError("public pilot installation identity differs")
    index = node.call("getindexinfo", "txindex").get("txindex") or {}
    if node.call("getnetworkinfo").get("version") != 310200 or btc.get("initialblockdownload") is not False or \
            btc.get("headers") != btc.get("blocks") or index.get("synced") is not True or \
            index.get("best_block_height") != btc.get("blocks") or node.call("getmempoolinfo").get("loaded") is not True:
        raise ConfigError("public pilot requires ready Core 31.2 and a current transaction index")
    tip, height = btc.get("bestblockhash"), btc.get("blocks")
    if not tip or (spaced.get("tip") or {}).get("hash") != tip or \
            (spaced.get("tip") or {}).get("height") != height or \
            (status.get("chain") or {}).get("best_block_hash") != tip or \
            (status.get("chain") or {}).get("blocks") != height:
        raise ConfigError("public pilot peers must share the current Core tip")
    wallet = runner.c.spaced.call("walletgetinfo", runner.c.operator_wallet)
    if wallet.get("tip") != height or wallet.get("scanning", False) is not False:
        raise ConfigError("public pilot operator wallet is not scanned to the current tip")
    seller = status.get("seller") or {}
    spaces = seller.get("spaces") or []
    if seller.get("explicit_limits") is not True or status.get("production_ready") is not True or \
            len(spaces) != 1 or spaces[0].get("space") != runner.public_pilot.space:
        raise ConfigError("public pilot requires explicit installation limits and exactly its configured space")
