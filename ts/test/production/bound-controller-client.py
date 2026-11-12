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


state_file = root / "mock-subs-state.json"
if not state_file.exists():
    state_file.write_text(json.dumps({"rollbacks": 0, "parks": 0, "handles": {
        "n0": {"commitment_root": "a" * 64, "script_pubkey": "5120" + "1".rjust(64, "0"), "parked": False},
        "n1": {"commitment_root": "a" * 64, "script_pubkey": "5120" + "2".rjust(64, "0"), "parked": False}}}))


class Writes:
    def get(self, path, **kwargs):
        return json.loads(state_file.read_text())["handles"][path.rsplit("/", 1)[1]]

    def post(self, path, body=None, raw=False, **kwargs):
        if path.endswith("/rollback-local"):
            state = json.loads(state_file.read_text())
            for info in state["handles"].values():
                if info["commitment_root"] == "a" * 64:
                    info["commitment_root"] = None
            state["rollbacks"] += 1
            state_file.write_text(json.dumps(state))
            if mode == "stop-after-rollback":
                os._exit(9)
            if mode == "lose-rollback-answer":
                raise ConnectionError("simulated lost rollback answer")
            return {}
        if path.endswith("/park"):
            state = json.loads(state_file.read_text())
            for name in body["handles"]:
                state["handles"][name]["parked"] = body["parked"]
            state["parks"] += 1
            state_file.write_text(json.dumps(state))
            if mode == "stop-after-park":
                os._exit(9)
            return {}
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
c.live_delegate = lambda space: {"outpoint": "d" * 64 + ":0"}
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
    if mode == "stop-after-arm":
        arm = store.arm_entry
        def stop_at_arm(batch):
            result = arm(batch)
            os._exit(9)
        store.arm_entry = stop_at_arm
    if mode == "stop-after-completion":
        released = c._released_successor
        def stop_at_completion(batch):
            os._exit(9)
        c._released_successor = stop_at_completion
    error = None
    went = None
    try:
        if mode == "prepare":
            pass
        elif mode == "finish-child":
            child = next(b for b in c.batches() if b["supersedes"] == "b1")
            state = json.loads(state_file.read_text())
            for member in child["members"]:
                state["handles"][store.order(member)["name"].split("@")[0]]["commitment_root"] = "b" * 64
            state_file.write_text(json.dumps(state))
            c._save(child["bid"], state="checkpointed", root="b" * 64)
            went = c.issue(child["bid"])
        elif mode == "rollback":
            went = c.rollback_local("b1")
        elif mode == "rebuild":
            went = c.rebuild_unsent("b1", ["o2"])
        elif mode == "host-restore":
            c._reconcile()
        elif c.batch("b1")["state"] == "checkpointed":
            went = c.issue("b1")
        else:
            went = c.resume("b1")
    except Exception as exc:
        error = str(exc)
    b = c.batch("b1")
    print(json.dumps({"state": b["state"], "key": b["entry_key"], "attempted": b["attempted"],
                      "sends": len(sends.read_text().splitlines()) if sends.exists() else 0,
                      "error": error, "result": went,
                      "children": [b["bid"] for b in c.batches() if b["supersedes"] == "b1"],
                      "child_states": {b["bid"]: b["state"] for b in c.batches() if b["supersedes"] == "b1"},
                      "rollbacks": json.loads(state_file.read_text())["rollbacks"]}))
finally:
    c.close()
