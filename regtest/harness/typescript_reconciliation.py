"""Fresh application/controller/subs paths; the fixture wallets stay live."""
import json
import shutil
import subprocess
from pathlib import Path

from .scenarios import PRICE, SPACE_A


def reconcile(run, buyer, operator, command, restart, runtime_file, runner_file, link, receipt):
    stack = run.stack
    root = Path(__file__).resolve().parents[2]
    scenario = "TypeScript application/controller/subs restore and continued issuance"

    def step(label, got, expected):
        run.report.step(scenario, None, label, got, expected, match=got == expected)
        if got != expected:
            raise AssertionError(label)

    stack.stop_process("registry")
    stack.stop_process("subs")
    stack.subs_dir.rename(stack.subs_dir.with_name("subs-before-recovery"))
    stack.subs_dir.mkdir()
    config = json.loads(runtime_file.read_text())
    config["database"] = str(runtime_file.parent / "recovered.db")
    runtime_file.write_text(json.dumps(config))
    host = json.loads(runner_file.read_text())
    host["store"]["db"] = config["database"]
    old_host = Path(host["controller"]["dir"])
    host["controller"]["dir"] = str(old_host.with_name("runner-recovered"))
    runner_file.write_text(json.dumps(host))

    def recovery(mode):
        result = subprocess.run([shutil.which("node"), str(root / "ts/src/main.ts"), mode, str(runtime_file),
                                 *([str(runner_file)] if mode == "reconcile" else [])], cwd=root,
                                capture_output=True, text=True, timeout=600)
        with (stack.logs / "typescript-recovery.log").open("a") as log:
            log.write(f"{mode}: exit {result.returncode}\n{result.stdout}{result.stderr}\n")
        if result.returncode != 0:
            raise RuntimeError(f"TypeScript {mode} failed; retained recovery log has details")
        return json.loads(result.stdout)

    restored = recovery("restore")
    step("journal-only application restore remains quarantined", {"ready": restored["ready"], "paused": restored["sales_paused"],
         "armed": restored["issuance"]["armed"]}, {"ready": False, "paused": True, "armed": 1})
    completed = recovery("reconcile")
    step("known original transaction and restored subs complete recovery", {"ready": completed["ready"], "acknowledged": completed["acknowledged"],
         "paused": completed["sales_paused"]}, {"ready": True, "acknowledged": True, "paused": True})
    restart()
    status = command("status")
    step("runner adopts the bound acknowledged store completion", status["recovery"]["ready"], True)
    step("fulfilled sale retains its first receipt after restore", {"status": buyer.get(link)["status"],
         "same_receipt": operator.get("/operator/orders/o1")["fulfillment"] == receipt}, {"status": "fulfilled", "same_receipt": True})
    step("certificate bytes require fresh verification", buyer.get(link)["certificate_available"], False)
    verified = command("certify", "b1")
    step("real libveritas restores the original certificate", verified["members"]["o1"]["delivered"], True)
    step("restored cancelled refund remains settled", operator.get("/operator/orders/o2")["refunded_total"], PRICE)
    operator.post("/operator/pause", {"paused": False})
    operator.post("/operator/listings", {"handle": "three" + SPACE_A, "price_sats": PRICE})
    request = buyer.post("/requests", {"handle": "three" + SPACE_A, "script_pubkey": run.buyer_script()})
    quote = buyer.post(request["order_link"] + "/quote", {})
    run.pay(quote["address"], PRICE)
    run.mine(3)
    prepared = command("prepare", SPACE_A)
    step("restored tree and wallet prepare another batch", prepared["state"], "checkpointed")
    issued = command("issue", prepared["bid"], "--confirm", prepared["bid"])
    step("continued issuance sends a new bound commitment", issued["state"], "broadcast")
    run.mine(187)
    delivered = command("certify", prepared["bid"])
    step("continued issuance verifies a new certificate", delivered["members"][prepared["members"][0]]["delivered"], True)
    published = command("publish", prepared["bid"])
    step("continued issuance reaches verified relay delivery", published["outstanding"], [])
