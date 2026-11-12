"""Attended refund after the real TypeScript sale; fresh fixture wallets only."""
from .scenarios import PRICE, SPACE_A


def refund(run, buyer, operator, command, restart):
    scenario = "TypeScript buyer cancellation and attended runner refund"

    def step(what, got, expected):
        run.report.step(scenario, None, what, got, expected, match=got == expected)
        if got != expected:
            raise AssertionError(what)

    handle = "two" + SPACE_A
    operator.post("/operator/listings", {"handle": handle, "price_sats": PRICE})
    request = buyer.post("/requests", {"handle": handle, "script_pubkey": run.buyer_script()})
    link = request["order_link"]
    quote = buyer.post(link + "/quote", {})
    run.pay(quote["address"], PRICE)
    run.mine(3)
    cancelled = buyer.post(link + "/cancel", {})
    step("buyer cancellation before issuance is journaled", cancelled["cancellation"], "final")
    wallet = run.stack.btc("buyer")
    address = wallet.call("getnewaddress", "", "bech32m")
    buyer.post(link + "/refund-destination", {"address": address})
    command("refund", "o2", "--cause", "buyer", expected=1)
    step("refund refuses before six confirmations", buyer.get(link)["refund_groups"], [])
    run.mine(3)
    command("refund", "o2", expected=3)
    prepared = command("refund", "o2", "--cause", "buyer")
    step("attended preparation does not send", prepared["status"], "built")
    again = command("refund", "o2", "--cause", "buyer")
    step("repeated preparation returns the same signed group", {"gid": again["gid"], "txid": again["txid"]},
         {"gid": prepared["gid"], "txid": prepared["txid"]})
    gid, txid = prepared["gid"], prepared["txid"]
    restart()
    step("refund-status recovers the prepared receipt", command("refund-status", gid)["txid"], txid)
    step("prepared refund remains unsent after process crash", txid in run.stack.btc().call("getrawmempool"), False)
    command("broadcast-refund", gid, "--txid", txid, expected=3)
    command("broadcast-refund", gid, "--confirm", gid, expected=3)
    step("missing group or transaction confirmation sends nothing", txid in run.stack.btc().call("getrawmempool"), False)
    sent = command("broadcast-refund", gid, "--confirm", gid, "--txid", txid)
    step("explicit reviewed transaction reaches the mempool", {"status": sent["status"], "txid": sent["txid"]},
         {"status": "mempool", "txid": txid})
    restart()
    repeated = command("broadcast-refund", gid, "--confirm", gid, "--txid", txid)
    step("retry after process crash observes the same refund", {"txid": repeated["txid"], "intents": repeated["broadcast_intents"]},
         {"txid": txid, "intents": 1})
    run.mine(6)
    view = buyer.get(link)
    transaction = wallet.call("gettransaction", txid)
    received = sum(round(d["amount"] * 100_000_000) for d in transaction["details"]
                   if d["category"] == "receive" and d["address"] == address)
    step("settled refund is received by the buyer", {"status": view["refund_groups"][0]["status"], "refunded": view["refunded_sats"],
         "received": received, "reserved": view["reserved_refund_sats"]},
         {"status": "settled", "refunded": PRICE, "received": prepared["to_buyer_sats"], "reserved": 0})
    restart()
    step("settled history survives process crash", command("refund-status", gid)["status"], "settled")
