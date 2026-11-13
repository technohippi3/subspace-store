"""Actual controller/client with recording chain RPCs, not chain evidence."""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from controller.core import Clients, Controller
from controller.journal import Journal
from runner.store import configured_store

mode, url, token, database, journal_directory, test_root = sys.argv[1:]
root = Path(test_root)
chain = json.loads((root / "mock-chain.json").read_text())
store = configured_store(dict(implementation="typescript", url=url, operator_token_file=token,
                             db=database, journal_dir=journal_directory))
journal = Journal(root / "controller-journal", "runner")
if mode == "preparation-fault":
    from preparation_fault import retain_unrelated_owner
    retain_unrelated_owner(journal)


class Rpc:
    def call(self, method, *params):
        if method == "getblockchaininfo":
            return {"blocks": chain["tipHeight"], "bestblockhash": chain["tipHash"]}
        if method == "getserverinfo":
            return {"tip": {"hash": chain["tipHash"]}}
        if method == "getrawtransaction":
            return {"blockhash": "e" * 64} if chain["minedHeight"] is not None else {}
        if method == "getblockheader":
            return {"height": chain["minedHeight"], "confirmations": 1}
        if method == "getblockcount":
            return chain["tipHeight"]
        if method == "getcommitment":
            return {"state_root": "a" * 64, "block_height": chain["rootHeight"]} if chain["rootHeight"] is not None else None
        if method == "getrootanchors":
            return [{"block": {"height": chain["anchorHeight"]}}] if chain["anchorHeight"] is not None else []
        raise AssertionError(method)


rpc = Rpc()
c = Controller(root / "controller.db", journal, store, Clients(lambda: None, lambda: None, lambda: rpc, lambda: rpc),
               None, root / "mock-verifier", root / "work", "mock-wallet")
c.wait_synced = lambda: None
c.capture_bytes = lambda bid: None
try:
    if mode == "stop-after-report":
        report = store.report_commitment
        def stop_after_report(*args):
            report(*args)
            os._exit(9)
        store.report_commitment = stop_after_report
    error = None
    try:
        c.watch("b1")
    except Exception as exc:
        error = str(exc)
    sends = root / "mock-subs-sends.jsonl"
    print(json.dumps({"state": c.batch("b1")["state"], "error": error,
                      "sends": len(sends.read_text().splitlines()) if sends.exists() else 0,
                      "finality_losses": sum(a["kind"] == "finality_lost" for a in c.alerts())}))
finally:
    c.close()
