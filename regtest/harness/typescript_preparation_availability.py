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
    recipients = {}
    def paid(name):
        operator.post("/operator/listings", {"handle": name + SPACE_A, "price_sats": PRICE})
        recipient = run.buyer_script()
        requested = buyer.post("/requests", {"handle": name + SPACE_A, "script_pubkey": recipient})
        link = requested["order_link"]
        recipients[link] = recipient
        quoted = buyer.post(link + "/quote", {})
        run.pay(quoted["address"], PRICE)
        run.mine(3)
        def converted():
            assert buyer.get(link)["status"] == "converted"
        wait(converted)
        return link
    link = paid("abort-check")
    survivor = paid("survivor-check")
    r = build(json.loads(runner_file.read_text()))
    try:
        old = next(b for b in reversed(r.c.batches()) if b["txid"])
        old_bid, old_txid, old_members = old["bid"], old["txid"], old["members"]
        receipts = {oid: operator.get("/operator/orders/" + oid)["fulfillment"] for oid in old_members}
        bid = r.c.freeze(SPACE_A)
        survivor_oid = next(oid for oid in r.c.batch(bid)["members"] if r.store.order(oid)["name"] == "survivor-check" + SPACE_A)
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
    step("surviving paid member remains converted after abort", buyer.get(survivor)["status"], "converted")
    r = build(json.loads(runner_file.read_text()))
    try:
        rows = r.c.journal.entries()
        floor = next(row["seq"] for row in rows if row["kind"] == "controller_protocol")
        abort = next(row["seq"] for row in rows if row["kind"] == "preparation_abort" and row["bid"] == bid)
        clear = next(row["seq"] for row in rows if row["kind"] == "preparation_effect" and row["bid"] == bid and row["operation"] == "pending_clear" and row["phase"] == "intent")
        step("mandatory protocol is acknowledged before abort and pending clear", floor < abort < clear, True)
    finally:
        r.close()
    prepared = command("prepare", SPACE_A)
    step("same paid member enters a fresh proved checkpointed batch", {"fresh": prepared["bid"] != bid, "members": prepared["members"], "state": prepared["state"]},
         {"fresh": True, "members": [survivor_oid], "state": "checkpointed"})
    issued = command("issue", prepared["bid"], "--confirm", prepared["bid"])
    step("surviving paid member reaches one bound issuance", issued["state"], "broadcast")
    run.mine(187)
    certified = command("certify", prepared["bid"])
    step("surviving recipient has a real verified certificate", certified["members"][survivor_oid]["delivered"], True)
    delivered = command("publish", prepared["bid"])
    step("surviving member reaches verified relay fulfillment", {"outstanding": delivered["outstanding"], "status": buyer.get(survivor)["status"]},
         {"outstanding": [], "status": "fulfilled"})
    import subprocess
    from .scenarios import VERIFIER
    evidence = run.stack.dir / "abort-survivor-verification"
    evidence.mkdir()
    message = evidence / "recipient.message"
    message.write_bytes(buyer.get(survivor + "/certificate", raw=True))
    r = build(json.loads(runner_file.read_text()))
    try:
        anchors = evidence / "anchors.json"
        anchors.write_text(json.dumps(r.c.root_anchors()))
    finally:
        r.close()
    verified = subprocess.run([str(VERIFIER), str(message), str(anchors)], capture_output=True, text=True, timeout=30)
    verdict = json.loads(verified.stdout)
    zone = next(z for z in verdict["zones"] if z["handle"] == "survivor-check" + SPACE_A)
    step("independent download verifies the survivor's original recipient", {"exit": verified.returncode, "verified": verdict["verified"], "script": zone["script_pubkey"] == recipients[survivor], "sovereignty": zone["sovereignty"]},
         {"exit": 0, "verified": True, "script": True, "sovereignty": "sovereign"})
    step("cancelled member stays cancelled after survivor fulfillment", buyer.get(link)["status"], "cancelled")
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
