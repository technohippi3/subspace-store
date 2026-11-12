"""Known-history whole-host replacement. No old host files are recovery inputs."""
import json
import secrets
import sqlite3
import time
from pathlib import Path

from .procs import OPERATOR_WALLET
from .recovery import HOST_PROCESSES
from .scenarios import PRICE, SPACE_A
from .typescript_reconciliation import reconcile


def recover_host(run, buyer, operator, command, restart, runtime_file, runner_file, link, receipt):
    stack = run.stack
    scenario = "TypeScript known-history whole-host recovery from onboarding backups"

    def step(label, actual, expected):
        run.report.step(scenario, None, label, actual, expected, match=actual == expected)
        if actual != expected:
            raise AssertionError(label)

    # Two acknowledged but undetected invoices: one is paid while the host
    # is absent, and one stays unpaid, including through the wallet rescan.
    invoices = []
    for name in ("four", "five"):
        operator.post("/operator/listings", {"handle": name + SPACE_A, "price_sats": PRICE})
        requested = buyer.post("/requests", {"handle": name + SPACE_A, "script_pubkey": run.buyer_script()})
        invoices.append((requested["order_link"], buyer.post(requested["order_link"] + "/quote", {})))
    config = json.loads(runtime_file.read_text())
    host = json.loads(runner_file.read_text())
    with sqlite3.connect(Path(config["database"]).resolve().as_uri() + "?mode=ro", uri=True) as db:
        before_store = db.execute("select store from store_meta where id=1").fetchone()[0]
        addresses = {json.loads(r[0])["destination"]["address"] for r in db.execute("select value from records where kind='sales_order'")}
    # Configuration is part of operator recovery material. Token values and
    # the seller databases/cache are deliberately absent from this set.
    (stack.recovery_set / "typescript-config.json").write_text(json.dumps(config))
    (stack.recovery_set / "typescript-runner.json").write_text(json.dumps(host))
    world_pids = {name: stack._pid(name) for name in ("network", "world_spaced", "certrelay")}
    started = time.monotonic()
    for name in HOST_PROCESSES:
        stack.kill(name)
    lost = stack.dir / "lost-typescript-host"
    lost.mkdir(mode=0o700)
    for path in [*stack.host_paths(), runtime_file.parent, stack.dir / "buyer-verification"]:
        if path.exists():
            path.rename(lost / path.name)
    step("all seller data paths are absent before replacement", any(p.exists() for p in stack.host_paths()) or runtime_file.exists(), False)
    step("network, buyer wallets and relay survive seller loss", {name: stack._pid(name) for name in world_pids}, world_pids)
    payment = stack.net("buyer").call("sendtoaddress", invoices[0][1]["address"], PRICE / 100_000_000)
    miner = stack.net("miner").call("getnewaddress", "", "bech32m")
    stack.net().call("generatetoaddress", 6, miner)
    run.chain.world_synced()

    # Every path used below is new or in the declared off-host recovery
    # set. The quarantined old host remains untouched for failure analysis.
    stack.new_host()
    stack.start_bitcoind()
    run.chain.host_synced(timeout=1800, spaced=False)
    stack.start_spaced()
    run.chain.host_synced(timeout=1800)
    backup = json.loads((stack.recovery_set / "operator-wallet.json").read_text())
    stack.spaced().call("walletimport", backup)
    run._wait_wallet()
    stack.btc().call("restorewallet", "store", str(stack.recovery_set / "store-wallet.bak"))
    step("fresh Core and Spaces wallets rescan to the surviving chain", {
        "same_tip": stack.btc().call("getbestblockhash") == stack.net().call("getbestblockhash"),
        "store_loaded": "store" in stack.btc().call("listwallets"),
        "space_owned": SPACE_A in run._owned()}, {"same_tip": True, "store_loaded": True, "space_owned": True})
    stack.start_proxies()
    stack.start_prover()
    runtime_file.parent.mkdir(mode=0o700)
    config = json.loads((stack.recovery_set / "typescript-config.json").read_text())
    host = json.loads((stack.recovery_set / "typescript-runner.json").read_text())
    # Throwaway replacement-host credentials, never printed or retained.
    for file in config["credentials"].values():
        p = Path(file)
        p.write_text(secrets.token_hex(24))
        p.chmod(0o600)
    operator.token = Path(config["credentials"]["operator"]).read_text().strip()
    runtime_file.write_text(json.dumps(config))
    runner_file.write_text(json.dumps(host))
    # Shared application/controller/subs restore path; it also checks paused
    # startup, the original receipt, settled refund and continued issuance.
    def configure_restored_subs():
        # On a replacement host the operator supplies runtime credentials
        # independently of old snapshots, before resuming admission. The
        # installer will drive this same native subs configuration route.
        endpoint = f"http://127.0.0.1:{config['listen']['subs']}"
        token = Path(config["credentials"]["subs"]).read_text().strip()
        stack.subs().post("/config", {"registry_endpoint": endpoint,
                                   "registry_auth_token": token, "registry_auto_sync": False})
        tested = stack.subs().post("/config/test/registry", {"endpoint": endpoint})
        step("replacement runtime credential reaches the paused store through subs", tested["success"], True)

    continued = reconcile(run, buyer, operator, command, restart, runtime_file, runner_file, link, receipt, configure=configure_restored_subs)
    recovered_config = json.loads(runtime_file.read_text())
    with sqlite3.connect(Path(recovered_config["database"]).resolve().as_uri() + "?mode=ro", uri=True) as db:
        after_store = db.execute("select store from store_meta where id=1").fetchone()[0]
    step("store identity survives journal-only host replacement", after_store, before_store)
    step("first new quote skips every historical payment address", continued["quote"]["address"] in addresses, False)
    step("payment made during host absence is attributed and delivered", {
        "status": buyer.get(invoices[0][0])["status"], "payment_seen": payment in [p["txid"] for p in stack.btc("store").call("listsinceblock")["transactions"]]},
        {"status": "fulfilled", "payment_seen": True})
    unknown = buyer.get(invoices[1][0])
    step("unpaid historical invoice remains unknown without a new payment request", {
        "history": unknown["payment_history"], "address": unknown["address"], "acknowledged": unknown["acknowledged"]},
        {"history": "unknown", "address": None, "acknowledged": True})
    run.report.meta["known_history_host_recovery_seconds"] = round(time.monotonic() - started, 2)
