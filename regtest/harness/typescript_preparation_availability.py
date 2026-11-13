"""Real store pending receipts and native delivery across preparation faults."""
import json

from controller.errors import Refused
from controller.preparation_history import history
from runner.cli import build
from .scenarios import PRICE, SPACE_A


def qualify(run, buyer, operator, command, runner_file, wait):
    scenario = "Preparation abort and sent-batch availability on the real native stack"
    def step(label, got, expected):
        run.report.step(scenario, None, label, got, expected, match=got == expected)
        if got != expected:
            raise AssertionError(label)
    def paid(name):
        operator.post("/operator/listings", {"handle": name + SPACE_A, "price_sats": PRICE})
        requested = buyer.post("/requests", {"handle": name + SPACE_A, "script_pubkey": run.buyer_script()})
        link = requested["order_link"]
        quoted = buyer.post(link + "/quote", {})
        run.pay(quoted["address"], PRICE)
        run.mine(3)
        def converted():
            assert buyer.get(link)["status"] == "converted"
        wait(converted)
        return link
    link = paid("abort-check")
    r = build(json.loads(runner_file.read_text()))
    try:
        old = next(b for b in reversed(r.c.batches()) if b["txid"])
        old_bid, old_txid, old_members = old["bid"], old["txid"], old["members"]
        receipts = {oid: operator.get("/operator/orders/" + oid)["fulfillment"] for oid in old_members}
        bid = r.c.freeze(SPACE_A)
        pending = r.store.set_pending
        def cancel_after_ack(oids):
            ack = pending(oids)
            if oids:
                buyer.post(link + "/cancel", {})
            return ack
        r.store.set_pending = cancel_after_ack
        try:
            r.c.stage(bid)
            raise AssertionError("cancelled preparation unexpectedly staged")
        except Refused:
            pass
        owner, unresolved, _ = history(r.c.journal)
        step("real acknowledged pending set retains owner after buyer cancellation", {
            "owner": owner["bid"] == bid, "unresolved": unresolved, "status": buyer.get(link)["status"]},
             {"owner": True, "unresolved": None, "status": "cancelled"})
    finally:
        r.close()
    aborted = command("abort-preparation", bid)
    step("shipped abort command retires cancelled batch without a local commitment", aborted,
         {"bid": bid, "state": "rebuilt", "aborted": True})
    step("repeated abort command recovers the same retirement", command("abort-preparation", bid), aborted)
    paid("fence-check")
    r = build(json.loads(runner_file.read_text()))
    try:
        bid = r.c.freeze(SPACE_A)
        pending = r.store.set_pending
        def lost_after_ack(oids):
            pending(oids)
            raise ConnectionError("injected response loss after real pending acknowledgment")
        r.store.set_pending = lost_after_ack
        try:
            r.c.stage(bid)
            raise AssertionError("response loss unexpectedly completed")
        except ConnectionError:
            pass
        owner, unresolved, _ = history(r.c.journal)
        step("lost real pending reply retains the exact unresolved request", {
            "owner": owner["bid"] == bid, "operation": unresolved["operation"]}, {"owner": True, "operation": "pending_set"})
    finally:
        r.close()
    step("unknown request refuses the shipped abort command", "error" in command("abort-preparation", bid, expected=1), True)
    step("known sent batch still observes finality with the unknown owner", command("watch", old_bid)["state"], "final")
    verified = command("certify", old_bid)
    step("real libveritas still verifies exact sent recipients", all(m["verified"] and m["delivered"] for m in verified["members"].values()), True)
    published = command("publish", old_bid)
    step("real relay delivery continues through the unrelated fence", published["outstanding"], [])
    step("original fulfillment receipts survive availability recovery", all(operator.get("/operator/orders/" + oid)["fulfillment"] == receipt for oid, receipt in receipts.items()), True)
    r = build(json.loads(runner_file.read_text()))
    try:
        step("unknown owner remains fenced and original transaction remains bound", {
            "operation": history(r.c.journal)[1]["operation"], "same_txid": r.c.batch(old_bid)["txid"] == old_txid,
            "new_root": r.c.batch(bid)["root"]}, {"operation": "pending_set", "same_txid": True, "new_root": None})
    finally:
        r.close()
