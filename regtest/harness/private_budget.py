"""Measure signed transaction shapes for the private-purchase budget.

Regtest only, through the existing isolated harness and fixture wallets.
Usage: python3 -m regtest.harness.private_budget RUN measure_budget
No mainnet endpoints or owner wallets are used. These are representative
shapes, not a quotation for the eventual wallet's selected inputs.
"""

import sys
from decimal import Decimal

from . import scenarios
from .procs import OPERATOR_WALLET


def sats(value):
    return int(Decimal(str(value)) * 100_000_000)


class BudgetRun(scenarios.Run):
    def measure(self, label, txid):
        node = self.stack.btc()
        tx = node.call("getrawtransaction", txid, True)
        incoming = sum(sats(node.call("getrawtransaction", v["txid"], True)["vout"][v["vout"]]["value"])
                       for v in tx["vin"])
        fee = incoming - sum(sats(v["value"]) for v in tx["vout"])
        row = {"transaction": label, "txid": txid, "vsize": tx["vsize"], "weight": tx["weight"],
               "inputs": len(tx["vin"]), "outputs": len(tx["vout"]), "fee_sats": fee}
        self.report.step("private purchase budget", None, label, row, required=False,
                         note="measured from signed regtest bytes; inputs and change can differ on mainnet")

    def _setup_chain(self):
        original = self.stack.spaced
        run = self

        def client():
            rpc = original()
            call = rpc.call

            def capture(method, *args):
                out = call(method, *args)
                if method == "walletsendrequest":
                    for tx in out["result"]:
                        if not tx.get("error"):
                            run.measure("operate " + args[1]["requests"][0]["subject"], tx["txid"])
                return out

            rpc.call = capture
            return rpc

        self.stack.spaced = client
        try:
            super()._setup_chain()
        finally:
            self.stack.spaced = original


def measure_budget(run):
    node, buyer, sp = run.stack.btc(), run.stack.btc("buyer"), run.stack.spaced()
    if node.call("getblockchaininfo")["chain"] != "regtest":
        raise RuntimeError("budget measurement is regtest only")
    run.mine(36)
    address = sp.call("walletgetnewaddress", OPERATOR_WALLET, "Space")
    out = sp.call("walletsendrequest", OPERATOR_WALLET, {
        "requests": [{"request": "delegate", "subject": scenarios.SPACE_A, "to": address}],
        "fee_rate": scenarios.SPACED_FEE_RATE, "dust": None, "force": False,
        "confirmed_only": False, "skip_tx_check": False})
    for tx in out["result"]:
        if tx.get("error"):
            raise RuntimeError("regtest delegation failed")
        run.measure("delegate to a fresh address in the fixture wallet", tx["txid"])
    run.mine(6)
    operator = sp.call("walletgetnewaddress", OPERATOR_WALLET, "Coin")
    txid = buyer.call("sendtoaddress", operator, 0.0001)
    run.measure("fund operator with 10000 sats, Core-selected change", txid)
    run.mine(6)
    payment = run.stack.btc("store").call("getnewaddress", "budget-payment", "bech32m")
    txid = buyer.call("sendtoaddress", payment, 0.00001)
    run.measure("1000-sat buyer payment, Core-selected change", txid)
    run.mine(6)
    returned = buyer.call("getnewaddress", "budget-return", "bech32m")
    out = sp.call("walletsendrequest", OPERATOR_WALLET, {
        "requests": [{"request": "send", "amount": 5000, "to": returned}],
        "fee_rate": scenarios.SPACED_FEE_RATE, "dust": None, "force": False,
        "confirmed_only": False, "skip_tx_check": False})
    for tx in out["result"]:
        if tx.get("error"):
            raise RuntimeError("regtest return failed")
        run.measure("partial operator return with change, not a full sweep", tx["txid"])


if __name__ == "__main__":
    scenarios.Run = BudgetRun
    scenarios.measure_budget = measure_budget
    sys.exit(scenarios.main(sys.argv))
