"""Exact TypeScript attended-refund receipts. No legacy fallback or raw bytes."""
import re

GROUP = re.compile(r"g-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
HASH = re.compile(r"[0-9a-f]{64}\Z")
FIELDS = set("gid oid kind cause phase acknowledged txid refund_address charged_sats maximum_charge_sats to_buyer_sats "
             "fee_sats buyer_fee_sats merchant_fee_sats status confirmations intent_acknowledged "
             "broadcast_intents broadcast_result".split())


def receipt(value, refused, gid=None, oid=None, kind=None, cause=None):
    def invalid():
        raise refused("invalid or mismatched refund receipt")

    if not isinstance(value, dict) or set(value) != FIELDS:
        invalid()
    if not isinstance(value["gid"], str) or not GROUP.fullmatch(value["gid"]) or \
            not isinstance(value["oid"], str) or not re.fullmatch(r"o[1-9][0-9]{0,15}", value["oid"]) or \
            any(expected is not None and value[key] != expected for key, expected in
                (("gid", gid), ("oid", oid), ("kind", kind), ("cause", cause))):
        invalid()
    if value["kind"] not in ("cancellation", "excess") or value["cause"] not in ("buyer", "merchant") or \
            value["phase"] not in ("reserved", "built", "void") or type(value["acknowledged"]) is not bool or \
            value["status"] not in ("reserved", "built", "void", "settled", "needs_rebuild", "confirming", "mempool", "broadcast_unknown") or \
            value["intent_acknowledged"] is not None and type(value["intent_acknowledged"]) is not bool or \
            value["broadcast_result"] not in (None, "uncertain", "accepted"):
        invalid()
    for key in ("charged_sats", "maximum_charge_sats", "confirmations", "broadcast_intents"):
        if type(value[key]) is not int or not 0 <= value[key] <= 2_100_000_000_000_000:
            invalid()
    if value["charged_sats"] <= 0 or value["maximum_charge_sats"] < value["charged_sats"]:
        invalid()
    if value["broadcast_intents"] == 0 and (value["broadcast_result"] is not None or value["intent_acknowledged"] is not None) or \
            value["broadcast_intents"] > 0 and (value["broadcast_result"] is None or type(value["intent_acknowledged"]) is not bool) or \
            value["status"] == "settled" and value["confirmations"] < 6:
        invalid()
    if value["refund_address"] is not None and (not isinstance(value["refund_address"], str) or
                                               not 1 <= len(value["refund_address"]) <= 256):
        invalid()
    amounts = ("to_buyer_sats", "fee_sats", "buyer_fee_sats", "merchant_fee_sats")
    if value["txid"] is None:
        if value["phase"] == "built" or any(value[k] is not None for k in amounts):
            invalid()
    else:
        if value["phase"] != "built" or not isinstance(value["txid"], str) or not HASH.fullmatch(value["txid"]) or \
                not isinstance(value["refund_address"], str):
            invalid()
        if any(type(value[k]) is not int or not 0 <= value[k] <= 2_100_000_000_000_000 for k in amounts) or \
                value["to_buyer_sats"] < 546 or value["fee_sats"] != value["buyer_fee_sats"] + value["merchant_fee_sats"] or \
                value["charged_sats"] != value["to_buyer_sats"] + value["buyer_fee_sats"] or \
                value["cause"] == "merchant" and value["buyer_fee_sats"] != 0:
            invalid()
    return value
