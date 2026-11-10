"""Exercise the private-test mode on isolated regtest, never on mainnet.

Reuses the real checkout, runner and certificate checks of scenario 10.
Run each scenario on its own fresh run: the allowance cannot be recycled.
Usage: python3 -m regtest.harness.private_purchase RUN private_checkout|private_refund
"""

import json
import sys

from . import checkout, scenarios
from .service import ServiceRun
from .scenarios import SPACE_A


class PrivateRun(ServiceRun):
    def _open_host(self):
        super()._open_host()
        process = self.registry.process
        write = process.write_config

        def configure():
            write()
            if not hasattr(self, "private_test"):
                self.private_test = {
                    "handle": "one" + SPACE_A, "script_pubkey": self.buyer_script(),
                    "price_sats": 1000, "max_fee_rate_sat_vb": 20, "refund_fee_rate_sat_vb": 2,
                }
                self.buyer_script = lambda: self.private_test["script_pubkey"]
            config = json.loads(process.config.read_text())
            config["private_attended_test"] = self.private_test
            process.config.write_text(json.dumps(config))

        process.write_config = configure


class PrivateRunner(checkout.RunnerCli):
    def __init__(self, run):
        super().__init__(run)
        config = json.loads(self.config.read_text())
        config["private_attended_test"] = run.private_test
        self.config.write_text(json.dumps(config))

    def __call__(self, *args):
        if args[0] == "issue" and "--confirm" in args:
            refused, answer = super().__call__(*args, "--fee-rate", "21")
            self.run.report.step("private purchase", "Y3", "refuse a confirmed send above the ceiling",
                                 {"exit": refused, "refused": answer.get("refused")},
                                 {checkout.EXPECT: {"exit": 3}},
                                 match=refused == 3 and "ceiling" in answer.get("refused", ""))
            args = (*args, "--fee-rate", "1")
        return super().__call__(*args)


def private_checkout(run):
    checkout.PRICE = 1000
    checkout.RunnerCli = PrivateRunner
    checkout.checkout_purchase(run)
    reg = run.registry
    oid = reg.op("GET", "/operator/orders?status=fulfilled")["orders"][0]
    first = reg.order(oid)["dest_address"]
    reg.process.restart()
    second = reg.order(oid)["dest_address"]
    ok, why = scenarios.attempt(reg.request, run.private_test["handle"], run.private_test["script_pubkey"])
    run.report.step("private purchase", "Y4", "restart keeps one invoice and refuses a second order",
                    {"same_address": first == second, "second_request": ok},
                    {checkout.EXPECT: {"same_address": True, "second_request": False}},
                    match=first == second and not ok)


def private_refund(run):
    reg = run.registry
    handle, script = run.private_test["handle"], run.private_test["script_pubkey"]
    reg.list_name(handle, 1000)
    oid = reg.request(handle, script)
    quote = reg.quote(oid)
    run.pay(quote["address"], 1000)
    run.mine(6)
    reg.cancel(oid)
    buyer = run.stack.btc("buyer")
    address = buyer.call("getnewaddress", "private-refund", "bech32m")
    reg.set_refund_address(oid, address)
    runner = PrivateRunner(run)
    code, built = runner("refund", oid)
    if code != 0:
        raise RuntimeError(f"private refund build refused: {built}")
    attempt = reg.order(oid)["groups"][0]["attempts"][0]
    decoded = run.stack.btc().call("decoderawtransaction", attempt["raw"])
    rate_ok = built["fee"] == decoded["vsize"] * 2
    run.report.step("private refund", "Y7", "signed refund uses the explicit rate and measured size",
                    {"fee": built["fee"], "vsize": decoded["vsize"], "to_buyer": built["to_buyer"]},
                    {checkout.EXPECT: {"fee": decoded["vsize"] * 2, "to_buyer": 1000 - built["fee"]}},
                    match=rate_ok and built["to_buyer"] == 1000 - built["fee"])
    gid = built["gid"]
    code, result = runner("broadcast-refund", gid, "--confirm", gid)
    if code != 0 or not result.get("acknowledged"):
        raise RuntimeError(f"private refund send refused: {result}")
    run.mine(6)
    reg.observe()
    received = round(buyer.call("getreceivedbyaddress", address, 6) * 100_000_000)
    run.report.step("private refund", "Y7", "the buyer receives the refund after settlement",
                    {"received": received}, {checkout.EXPECT: {"received": built["to_buyer"]}},
                    match=received == built["to_buyer"])


def main(argv):
    if len(argv) != 3 or argv[2] not in ("private_checkout", "private_refund"):
        raise SystemExit(__doc__)
    scenarios.Run = PrivateRun
    scenarios.private_checkout = private_checkout
    scenarios.private_refund = private_refund
    return scenarios.main(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
