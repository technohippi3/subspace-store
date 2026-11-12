"""Real controller/HTTP client with a recording subs stand-in.

Fault modes stop this process at actual persistence boundaries. It owns only
the temporary test controller, public mock identities and made-up token.
"""
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
store = configured_store(dict(implementation="typescript", url=url,
                             operator_token_file=token, db=database,
                             journal_dir=journal_directory))
journal = Journal(root / "controller-journal", "runner")
if mode == "recover-controller":
    journal.set_down(False)
sends = root / "mock-subs-sends.jsonl"


class Writes:
    def post(self, path, body=None, raw=False, **kwargs):
        assert path == "/spaces/@space/broadcast" and raw
        with sends.open("a") as output:
            output.write(json.dumps({"path": path, "body": body}) + "\n")
            output.flush()
            os.fsync(output.fileno())
        if mode == "stop-after-send":
            os._exit(9)
        return json.dumps({"txid": "a" * 64}).encode()


writes = Writes()
c = Controller(root / "controller.db", journal, store,
               Clients(lambda: writes, lambda: writes, lambda: None, lambda: None),
               None, root / "mock-verifier", root / "work", "mock-wallet")
c.live_delegate = lambda space: {"outpoint": "mock-delegate:0"}
c.capture_bytes = lambda bid: None
try:
    if not c.batches():
        c.db.execute("insert into batches(bid,space,members,digest,state,root) "
                     "values('b1','@space',?,'mock-digest','checkpointed',?)",
                     (json.dumps(["o1", "o2"]), "a" * 64))
        assert c._journal("b1")
    if mode == "controller-down":
        journal.set_down(True)
    if mode == "stop-after-entry":
        entry_status = store.entry_status

        def stop_at_entry(batch, create=False):
            result = entry_status(batch, create)
            if create:
                os._exit(9)
            return result

        store.entry_status = stop_at_entry
    if mode == "stop-after-intent":
        c._send = lambda bid: os._exit(9)
    if mode == "stop-after-attempt":
        save = c._save

        def stop_at_attempt(bid, **fields):
            result = save(bid, **fields)
            if fields.get("attempted") == 1:
                os._exit(9)
            return result

        c._save = stop_at_attempt
    error = None
    try:
        if mode == "prepare":
            pass
        elif mode == "rollback":
            c.rollback_local("b1")
        elif mode == "host-restore":
            c._reconcile()
        elif c.batch("b1")["state"] == "checkpointed":
            c.issue("b1")
        else:
            c.resume("b1")
    except Exception as exc:
        error = str(exc)
    b = c.batch("b1")
    print(json.dumps({"state": b["state"], "key": b["entry_key"], "attempted": b["attempted"],
                      "sends": len(sends.read_text().splitlines()) if sends.exists() else 0,
                      "error": error}))
finally:
    c.close()
