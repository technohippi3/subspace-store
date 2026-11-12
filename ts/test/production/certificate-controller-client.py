"""Shipped verification loop and client, with a recording verifier/RPCs.
The executable reads a mock JSON message; it is not cryptographic evidence.
"""
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
settings = json.loads((root / "mock-certificate.json").read_text())
chain_file = root / "mock-chain.json"
store = configured_store(dict(implementation="typescript", url=url, operator_token_file=token,
                             db=database, journal_dir=journal_directory))
journal = Journal(root / "controller-journal", "runner")


class Rpc:
    def call(self, method, *params):
        chain = json.loads(chain_file.read_text())
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
            height = chain["rootHeight"] if params[1] == "a" * 64 else settings["height"]
            return {"state_root": params[1], "block_height": height} if height is not None else None
        if method == "getrootanchors":
            return [{"block": {"height": chain["anchorHeight"]}}] if chain["anchorHeight"] is not None else []
        raise AssertionError(method)


class Subs:
    def post(self, *args):
        return {}

    def get(self, path, raw=False):
        handle = path.split("/")[2]
        index = 1 if handle == "n0@space" else 2
        return json.dumps(dict(handle=handle, script_pubkey="5120" + str(index).rjust(64, "0"),
                               space="@space", root=settings["root"], height=settings["height"],
                               verified=settings.get("verified", True), sovereignty=settings.get("sovereignty", "sovereign"),
                               wrong_recipient=settings.get("wrong_recipient", False))).encode()


verifier = root / "mock-verifier"
verifier.write_text('''#!/usr/bin/env python3
import json,sys,pathlib
p=json.loads(pathlib.Path(sys.argv[1]).read_bytes())
settings=json.loads((pathlib.Path(sys.argv[1]).parents[2]/"mock-certificate.json").read_text())
if settings.get("change_tip"):
 chain_file=pathlib.Path(sys.argv[1]).parents[2]/"mock-chain.json"
 chain=json.loads(chain_file.read_text());chain["tipHash"]="c"*64;chain["tipHeight"]+=1;chain_file.write_text(json.dumps(chain))
print(json.dumps({"verified":p["verified"],"zones":[{"handle":p["handle"],"script_pubkey":"wrong" if p["wrong_recipient"] else p["script_pubkey"],"sovereignty":p["sovereignty"]},
 {"handle":p["space"],"commitment_root":p["root"],"commitment_height":p["height"]}]}))
sys.exit(settings.get("exit_code",0))
''')
verifier.chmod(0o700)
rpc, subs = Rpc(), Subs()
c = Controller(root / "controller.db", journal, store, Clients(lambda: subs, lambda: subs, lambda: rpc, lambda: rpc),
               None, verifier, root / "work", "mock-wallet")
c.wait_synced = lambda: None
c.capture_bytes = lambda bid: None
try:
    if mode == "stop-after-certificate":
        accept = store.accept_certificate
        def stop_after_certificate(*args):
            accept(*args)
            os._exit(9)
        store.accept_certificate = stop_after_certificate
    error, result = None, None
    try:
        result = Runner(store, c).certify("b1")
    except Exception as exc:
        error = str(exc)
    sends = root / "mock-subs-sends.jsonl"
    print(json.dumps({"state": c.batch("b1")["state"], "error": error, "result": result,
                      "sends": len(sends.read_text().splitlines()) if sends.exists() else 0,
                      "alerts": [a["kind"] for a in c.alerts()]}))
finally:
    c.close()
