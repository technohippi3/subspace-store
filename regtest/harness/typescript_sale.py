"""One real Spaces-stack sale through the standalone TypeScript process.

The existing chain/setup harness creates only throwaway fixtures. The
purchase uses the TypeScript buyer JSON API and shipped attended runner;
certificate and relay verification use real libveritas, never a stand-in.
This is regtest evidence, not buyer-client or public-pilot acceptance.
"""
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

from .procs import OPERATOR_WALLET, PORTS, bitcoind_version, relay_url, subs_bin, subs_capabilities
from .rpc import Http
from .scenarios import PRICE, SPACE_A, VERIFIER, Run

ROOT = Path(__file__).resolve().parents[2]
BUYER_PORT, OPERATOR_PORT = 18951, 18952


def wait(work, timeout=120):
    end = time.monotonic() + timeout
    while True:
        try:
            return work()
        except RuntimeError:
            raise
        except Exception:
            if time.monotonic() >= end:
                raise
            time.sleep(0.25)


def sale(run, recovery=None, buyer_wallet=None):
    stack, report = run.stack, run.report
    scenario = "TypeScript process, shipped runner and real Spaces/relay sale"

    def step(what, got, expected):
        report.step(scenario, None, what, got, expected, match=got == expected)
        if got != expected:
            raise AssertionError(what)

    # Reuse only fixture setup. No purchase touches this bootstrap registry.
    run.start()
    run.registry.shutdown()
    if run.controller is not None:
        run.controller.close()
    runtime = stack.dir / "typescript"
    runtime.mkdir(mode=0o700)
    journal = run.offhost / "typescript-store"
    journal.mkdir(parents=True, mode=0o700)
    operator_token = runtime / "operator-token"
    operator_token.write_text(secrets.token_hex(24))
    operator_token.chmod(0o600)
    config = {
        "version": 1, "network": "regtest",
        "database": str(runtime / "store.db"), "journalDirectory": str(journal),
        "listen": {"buyer": BUYER_PORT, "operator": OPERATOR_PORT, "subs": PORTS["registry"]},
        "core": {"url": f"http://127.0.0.1:{PORTS['bitcoind']}/",
                 "cookiePath": str(stack.btc_cookie()), "wallet": "store"},
        "credentials": {"operator": str(operator_token), "subs": str(stack.dir / "registry-token")},
        "riskBudgetSats": 100_000,
        "refundPolicy": {"minimumRate": 1000, "maximumRate": 100_000, "fallbackRate": 2000,
                         "buyerFeeCeiling": 300, "confirmationTarget": 6,
                         "maximumFee": 10_000, "maximumRefund": 100_000},
        "merchantDestinations": [], "pollMilliseconds": 500,
    }
    file = runtime / "config.json"
    file.write_text(json.dumps(config))
    operator = Http(f"http://127.0.0.1:{OPERATOR_PORT}", token=operator_token.read_text().strip())
    buyer = Http(f"http://127.0.0.1:{BUYER_PORT}")

    def start():
        process = stack._spawn("registry", [shutil.which("node"), str(ROOT / "ts/src/main.ts"), str(file)])

        def ready():
            if process.poll() is not None:
                raise RuntimeError("TypeScript process exited; retained registry log has details")
            status = operator.get("/operator/status")
            assert status["chain"]["network"] == "regtest"
            return status
        return wait(ready)

    def restart():
        # Kill only this run's store; Core, spaced, subs and relay keep running.
        pid = stack._pid("registry")
        if pid is not None:
            import signal
            os.kill(pid, signal.SIGKILL)
            def stopped():
                assert not stack._alive(pid), "store still alive"
            wait(stopped)
        return start()

    status = start()
    step("new store starts paused with live Core network", {"paused": status["paused"], "network": status["chain"]["network"]},
         {"paused": True, "network": "regtest"})
    host = {
        "network": "regtest",
        "store": {"implementation": "typescript", "url": operator.base,
                  "operator_token_file": str(operator_token), "db": config["database"], "journal_dir": str(journal)},
        "controller": {"dir": str(stack.dir / "runner"), "journal_dir": str(run.offhost / "runner"),
                       "journal_name": "runner", "operator_wallet": OPERATOR_WALLET},
        "bitcoind": {"url": f"http://127.0.0.1:{PORTS['bitcoind']}", "cookie_file": str(stack.btc_cookie())},
        "spaced": {"url": f"http://127.0.0.1:{PORTS['spaced']}", "cookie_file": str(stack.spaced_cookie())},
        "subs": {"url": f"http://127.0.0.1:{PORTS['subs']}", "write_url": f"http://127.0.0.1:{PORTS['subs_proxy']}",
                 "data_dir": str(stack.subs_dir), "capabilities": subs_capabilities(),
                 "stop_command": [sys.executable, "-m", "regtest.harness.procs", "stop-subs", stack.run],
                 "start_command": [sys.executable, "-m", "regtest.harness.procs", "start-subs", stack.run]},
        "relay": {"url": relay_url()}, "verifier": str(VERIFIER),
    }
    runner_file = runtime / "runner.json"
    runner_file.write_text(json.dumps(host))

    def command(*args, expected=0):
        result = subprocess.run([sys.executable, "-m", "runner", str(runner_file), *args], cwd=ROOT,
                                capture_output=True, text=True, timeout=3600, stdin=subprocess.DEVNULL)
        with (stack.logs / "typescript-runner.log").open("a") as log:
            log.write(f"runner {' '.join(args)}: exit {result.returncode}\n{result.stdout}{result.stderr}\n")
        if result.returncode != expected:
            raise RuntimeError(f"runner {args[0]} exited {result.returncode}; retained log has details")
        return json.loads(result.stdout)

    handle = "one" + SPACE_A
    recipient = run.buyer_script()
    step("journaled listing", operator.post("/operator/listings", {"handle": handle, "price_sats": PRICE}),
         {"handle": handle, "price_sats": PRICE, "acknowledged": True})
    step("explicit admission enable", operator.post("/operator/pause", {"paused": False}), {"paused": False, "acknowledged": True})
    requested = buyer.post("/requests", {"handle": handle, "script_pubkey": recipient})
    link = requested["order_link"]
    quote = buyer.post(link + "/quote", {})
    step("buyer quote is acknowledged", {"status": quote["status"], "price": quote["price_sats"], "acknowledged": quote["acknowledged"]},
         {"status": "quoted", "price": PRICE, "acknowledged": True})
    run.pay(quote["address"], PRICE)
    restart()
    run.mine(3)

    def converted():
        result = operator.get("/operator/orders/o1")
        assert result["status"] == "converted"
        return result
    wait(converted)
    step("background observation converts payment after crash/restart", buyer.get(link)["status"], "converted")
    prepared = command("prepare", SPACE_A)
    step("real subs proof and coordinated snapshot", {"state": prepared["state"], "members": prepared["members"]},
         {"state": "checkpointed", "members": ["o1"]})
    bid = prepared["bid"]
    command("issue", bid, expected=3)
    step("missing send confirmation retains converted sale", buyer.get(link)["status"], "converted")
    issued = command("issue", bid, "--confirm", bid)
    step("confirmed original commitment send", issued["state"], "broadcast")
    restart()
    run.mine(151)
    watched = command("watch", bid)
    if watched["certificate_status"] == "awaiting_anchor":
        run.mine(36)
    certified = command("certify", bid)
    step("real libveritas certificate accepted by TypeScript", {key: certified["members"]["o1"][key] for key in ("verified", "delivered")},
         {"verified": True, "delivered": True})
    restart()
    message = buyer.get(link + "/certificate", raw=True)
    evidence = stack.dir / "buyer-verification"
    evidence.mkdir()
    message_file = evidence / f"{handle}.certificate"
    message_file.write_bytes(message)
    anchors = evidence / "anchors.json"
    anchors.write_text(json.dumps(run.controller.root_anchors() if run.controller else run.chain.root_anchors()))
    verified = subprocess.run([str(VERIFIER), str(message_file), str(anchors)], capture_output=True, text=True, timeout=30)
    verdict = json.loads(verified.stdout)
    (evidence / f"{handle}.libveritas.json").write_text(verified.stdout)
    zone = next(z for z in verdict["zones"] if z["handle"] == handle)
    step("download independently verifies exact sovereign recipient", {"exit": verified.returncode, "verified": verdict["verified"],
         "script": zone["script_pubkey"] == recipient, "sovereignty": zone["sovereignty"]},
         {"exit": 0, "verified": True, "script": True, "sovereignty": "sovereign"})
    from .publication import _subs_seed_line
    step("publication seed is the isolated local relay", _subs_seed_line(stack), relay_url())
    published = command("publish", bid)
    step("real relay query verifies delivery", {"confirmed": published["delivery"]["o1"]["confirmed"], "outstanding": published["outstanding"]},
         {"confirmed": True, "outstanding": []})
    receipt = operator.get("/operator/orders/o1")["fulfillment"]
    restart()
    step("fulfilled sale and first receipt survive process crash", {"status": buyer.get(link)["status"],
         "same_receipt": operator.get("/operator/orders/o1")["fulfillment"] == receipt,
         "same_certificate": buyer.get(link + "/certificate", raw=True) == message},
         {"status": "fulfilled", "same_receipt": True, "same_certificate": True})
    from .typescript_refund import refund
    refund(run, buyer, operator, command, restart, wallet=buyer_wallet)
    if recovery is None:
        from .typescript_reconciliation import reconcile
        recovery = reconcile
    recovery(run, buyer, operator, command, restart, file, runner_file, link, receipt)


def main(argv):
    if os.environ.get("SUBSPACE_TYPESCRIPT_STACK_ISOLATED") != "1" or os.environ.get("SUBSPACE_RELAY") != "1":
        raise RuntimeError("run through regtest/run-typescript-sale.sh")
    if len(argv) not in (2, 3) or len(argv) == 3 and argv[2] != "whole-host":
        raise ValueError("expected a run id and optional whole-host mode")
    whole_host = len(argv) == 3
    recovery, wallet = None, None
    if whole_host:
        from .recovery import RecoveryRun
        from .typescript_host_recovery import recover_host
        run = RecoveryRun(argv[1])
        recovery, wallet = recover_host, run.stack.net("buyer")
    else:
        run = Run(argv[1])
    files = sorted([*ROOT.glob("ts/src/**/*.ts"), *ROOT.glob("controller/*.py"),
                    *ROOT.glob("runner/*.py"), Path(__file__), Path(__file__).with_name("typescript_refund.py"),
                    Path(__file__).with_name("report.py"), Path(__file__).with_name("typescript_reconciliation.py"),
                    Path(__file__).with_name("procs.py"), ROOT / "regtest/run-typescript-sale.sh",
                    *([Path(__file__).with_name(n) for n in ("typescript_host_recovery.py", "recovery.py", "service.py")]
                      if whole_host else []), *([ROOT / "regtest/run-typescript-recovery.sh"] if whole_host else [])])
    scope = "real Spaces-stack sale/refund and application/controller/subs restore with continued issuance; wallets and Core stay live, no whole-host gate"
    if whole_host:
        scope = "known-history whole-host TypeScript recovery from onboarding wallet backups, journals and coordinated subs snapshot; independent network and buyer wallets survive"
    run.report.meta.update({"scope": scope,
                            "comparison_source": "fixed_spec",
                            "core": bitcoind_version(),
                            "subs_binary": {"name": subs_bin().name, "sha256": hashlib.sha256(subs_bin().read_bytes()).hexdigest()}, "source_files": {
                                str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}})
    try:
        sale(run, recovery=recovery, buyer_wallet=wallet)
    except BaseException as exc:
        run.report.meta["error"] = f"{type(exc).__name__}: {exc}"
        run.report.save()
        raise
    finally:
        run.stack.stop_all()
        run.report.save()
        (run.stack.dir / "report.md").write_text(run.report.markdown())
    return run.report.exit_code()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
