"""Shipped runner/client with recording Core/spaced facts, not chain evidence."""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from controller.core import Clients, Controller
from controller.journal import Journal
from runner.cli import Runner
from runner.store import configured_store

mode, url, token, database, journal_directory, test_root = sys.argv[1:]
root = Path(test_root)
chain = json.loads((root / "mock-chain.json").read_text())
store = configured_store(dict(implementation="typescript", url=url, operator_token_file=token,
                             db=database, journal_dir=journal_directory))
journal = Journal(root / "controller-journal", "runner")


class Rpc:
    def call(self, method, *params):
        if method == "getblockchaininfo":
            return dict(blocks=chain["tipHeight"], bestblockhash=chain["tipHash"])
        if method == "getserverinfo": return dict(tip=dict(hash=chain["tipHash"]))
        if method == "getrawtransaction":
            return dict(txid="f" * 64, blockhash="e" * 64, vin=[dict(txid="d" * 64, vout=0)]) if params[0] == "f" * 64 else {}
        if method == "getblockheader": return dict(height=290, confirmations=chain["tipHeight"] - 290 + 1)
        if method == "getblockhash": return "e" * 64
        if method == "getcommitment": return None
        if method == "getrootanchors": return []
        if method == "decoderawtransaction":
            return dict(txid="a" * 64, vin=[dict(txid="d" * 64, vout=0)], vout=[dict(scriptPubKey=dict(hex="6a20" + "a" * 64))])
        raise AssertionError(method)


rpc = Rpc()
c = Controller(root / "controller.db", journal, store, Clients(lambda: None, lambda: None, lambda: rpc, lambda: rpc),
               None, root / "mock-verifier", root / "work", "mock-wallet")
c.wait_synced = lambda: None
c.capture_bytes = lambda bid: None
try:
    if not c.batch("b1")["raw"]:
        assert c._save("b1", raw="00")
    if mode == "stop-after-proof":
        accept = store.accept_supersession
        def stop_after_proof(*args):
            accept(*args)
            os._exit(9)
        store.accept_supersession = stop_after_proof
    error, result = None, None
    try:
        result = c.watch("b1") if mode == "watch" else Runner(store, c).supersede("b1", "f" * 64, "b1")
    except Exception as exc:
        error = str(exc)
    sends = root / "mock-subs-sends.jsonl"
    print(json.dumps(dict(state=c.batch("b1")["state"], error=error, result=result,
                         sends=len(sends.read_text().splitlines()), alerts=[a["kind"] for a in c.alerts()])))
finally:
    c.close()
