"""Explicit refund rates for the private test; signing never sends."""

from .ledger import Refused


def check_refund(view, private, tx, fee):
    decoded = view.node.call("decoderawtransaction", tx["raw"])
    size = decoded.get("vsize")
    if type(size) is not int or size <= 0:
        raise Refused("the signed refund has no valid virtual size")
    if type(fee) is not int or fee < 0 or fee > size * private.max_fee_rate_sat_vb:
        raise Refused("the signed refund exceeds the private test fee-rate ceiling")
    return size


def build_refund(builder, ledger, oid, kind, private):
    charged = ledger.available(oid)
    rate = private.fee_rate(private.refund_fee_rate_sat_vb)
    # A first sizing pass, not an assumed final transaction size. Rebuild
    # after decoding the signed result; inputs, change and recipient vary.
    fee = 111 * rate
    for _ in range(6):
        if kind == "excess" and charged < fee + ledger.policy.excess_minimum_over_fee:
            raise Refused("excess below the refund minimum")
        to_buyer = charged - fee
        if to_buyer <= 0:
            raise Refused("nothing refundable at the explicit fee rate")
        tx, actual = builder.build(ledger, oid, to_buyer, fee)
        size = builder.view.node.call("decoderawtransaction", tx["raw"]).get("vsize")
        if type(size) is not int or size <= 0:
            raise Refused("the signed refund has no valid virtual size")
        required = size * rate
        if fee != required:
            fee = required
            continue
        check_refund(builder.view, private, tx, actual)
        return tx, to_buyer, actual, charged
    raise Refused("the refund fee could not be sized within the private test limit")
