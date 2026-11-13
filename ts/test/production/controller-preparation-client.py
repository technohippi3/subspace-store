"""Actual Python controller over real store/recording-native HTTP, with crash hooks."""
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from controller.core import Clients, Controller
from controller.journal import Journal
from controller.publication import Publisher
from controller.rpc import Http
from runner.store import configured_store

root, operator, native, operation, mode, bid = sys.argv[1:]
root = Path(root)
token = root / "preparation-operator-token"
token.write_text("mock-bound-entry-operator-token".ljust(48, "x"))
token.chmod(0o600)
store = configured_store(dict(implementation="typescript", url=operator, operator_token_file=str(token),
                             db=str(root / "store.db"), journal_dir=str(root / "journal")))


class CrashJournal(Journal):
    def append(self, kind, **data):
        batch = data.get("batch", {})
        if mode == "before-committed-ack" and kind == "batch" and batch.get("state") == "committed_local":
            os._exit(9)
        result = super().append(kind, **data)
        if (mode == "after-freeze" and kind == "batch" and batch.get("state") == "frozen" or
            mode == "after-staged" and kind == "batch" and batch.get("state") == "staged" or
            mode == "after-committed" and kind == "batch" and batch.get("state") == "committed_local" or
            mode == "after-owner" and kind == "preparation_pending" and data["phase"] == "owned" or
            mode == "after-clear-owner" and kind == "preparation_pending" and data["phase"] == "cleared" or
            mode == "after-commit-intent" and kind == "commit_local_intent" or
            kind == "preparation_effect" and mode == f"after-{data['operation']}-{data['phase']}"):
            os._exit(9)
        return result


class ReadOnlyNode:
    def call(self, method, *args):
        state = json.loads((root / "preparation-native.json").read_text())
        if method == "getcommitment":
            value = state["spaces"][args[0]]["chain"]
            return None if value is None else dict(state_root=value, block_height=1)
        if method == "getblockcount":
            return 10
        raise AssertionError("unexpected recording node read")


class NativeHttp(Http):
    def post(self, path, *args, **kwargs):
        result = super().post(path, *args, **kwargs)
        if path.endswith("/commit") and mode == "after-commit-response":
            os._exit(9)
        return result


journal = CrashJournal(root / "controller-journal", "controller")
controller = Controller(root / "controller.db", journal, store,
                        Clients(lambda: NativeHttp(native), lambda: Http(native), lambda: ReadOnlyNode(), lambda: ReadOnlyNode()),
                        None, root / "unused-verifier", root / "unused-work", "mock-wallet")
error, result = None, None
try:
    if operation == "freeze":
        result = controller.freeze("@space")
    elif operation == "stage":
        result = controller.stage(bid)
    elif operation == "commit":
        result = controller.commit_local(bid)
    elif operation == "barriers":
        calls = {"freeze": lambda: controller.freeze("@other"), "stage": lambda: controller.stage(bid),
                 "commit": lambda: controller.commit_local(bid), "issue": lambda: controller.issue(bid), "send": lambda: controller._send(bid),
                 "resume": lambda: controller.resume(bid), "release": lambda: controller.release_unsent(bid, ["o2"]),
                 "prove": lambda: controller.prove(bid), "checkpoint": lambda: controller.checkpoint(bid),
                 "snapshot": lambda: controller.snapshot("blocked"), "rebroadcast": lambda: controller.rebroadcast_commitment(bid),
                 "attach": lambda: controller.attach_txid(bid), "watch": lambda: controller.watch_bound(bid),
                 "readback": lambda: controller.readback(bid), "capture": lambda: controller.capture_bytes(bid),
                 "supersession": lambda: controller.supersession_progress(controller.batch(bid)),
                 "restore": lambda: controller.restore_from_journal(), "reconcile": lambda: controller.reconcile_bound(),
                 "statement": lambda: controller.bound_statement()}
        publication = Publisher(controller, store, journal, root / "publication.db", Http(native), "http://127.0.0.1:1")
        calls["publish"] = lambda: publication.publish(bid, ["o1"])
        result = {}
        for name, work in calls.items():
            try:
                work()
                result[name] = "UNEXPECTED SUCCESS"
            except Exception as failure:
                result[name] = str(failure)
        publication.db.close()
    else:
        raise AssertionError("unknown preparation fixture operation")
except Exception as failure:
    error = str(failure)
finally:
    print(json.dumps(dict(error=error, result=result, batches=controller.batches(), alerts=controller.alerts(), journal=journal.entries())))
    controller.close()
