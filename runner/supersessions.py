"""Exact bound supersession receipts. Signed transaction bytes are not returned."""
import re


def receipt(value, batch, refused):
    fields = set("version entry revision txid conflictTxid blockHash height tipHeight tipHash active".split())
    bad = lambda: refused("invalid or mismatched supersession receipt")
    if not isinstance(value, dict) or set(value) != {"entry", "proof", "conflicted", "acknowledged"} or \
            value["entry"] != batch["entry_key"] or type(value["conflicted"]) is not bool or type(value["acknowledged"]) is not bool:
        raise bad()
    p = value["proof"]
    if p is None:
        return value
    if not isinstance(p, dict) or set(p) != fields or type(p["version"]) is not int or p["version"] != 1 or \
            p["entry"] != batch["entry_key"] or p["txid"] != batch["txid"] or type(p["active"]) is not bool:
        raise bad()
    for key in ("txid", "conflictTxid", "blockHash", "tipHash"):
        if not isinstance(p[key], str) or not re.fullmatch(r"[0-9a-f]{64}", p[key]):
            raise bad()
    for key in ("revision", "height", "tipHeight"):
        if type(p[key]) is not int or not 0 <= p[key] <= 9_007_199_254_740_991:
            raise bad()
    if p["revision"] < 1 or p["txid"] == p["conflictTxid"] or p["tipHeight"] - p["height"] + 1 < 6 or \
            p["active"] and value["conflicted"]:
        raise bad()
    return value
