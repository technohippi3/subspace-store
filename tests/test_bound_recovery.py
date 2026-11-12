"""Offline recovery protocol with recording peers, not chain evidence."""
import copy
import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from controller.errors import Refused
from controller.rpc import RpcError
from runner.recovery_bridge import RecoveryStore, digest
from runner.recovery_snapshot import validate_snapshot
from runner.recovery_status import recovery_status
from tests.test_entry_release import World


class BoundRecovery(unittest.TestCase):
    def world(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        w = World(tmp.name)
        self.addCleanup(lambda: w.c.close())
        w.inventory = dict(version=1, store="mock-store", sourceSequence=1, sequence=5,
                           tipHeight=200, tipHash="b" * 64, spaces=["@space"],
                           orders=[dict(id=f"o{i}", handle=f"n{i}@space", recipient=f"mock-script-{i}", status="issuing") for i in (1, 2)],
                           entries=[dict(entry="1" * 32, root="a" * 64, space="@space", oids=["o1", "o2"],
                                         delegate="d" * 64 + ":0", closed=False, superseded=False,
                                         txid="c" * 64, conflictTxid=None, revision=1)])
        w.c.registry = RecoveryStore(w.inventory)
        w.calls = []
        w.wallet_ids = ["c" * 64]
        w.wallet_tip = 200
        w.chain_root = "a" * 64
        w.subs_txid = "c" * 64
        w.rpc_failure = False

        def call(method, *args):
            w.calls.append(method)
            if w.rpc_failure:
                raise ConnectionError("simulated unknown RPC")
            return {"getblockchaininfo": dict(blocks=200, bestblockhash="b" * 64),
                    "walletgetinfo": dict(tip=w.wallet_tip),
                    "walletlisttransactions": [dict(txid=t) for t in w.wallet_ids],
                    "getserverinfo": dict(tip=dict(hash="b" * 64)),
                    "getrawtransaction": dict(blockhash="e" * 64),
                    "getblockheader": dict(confirmations=151),
                    "getcommitment": dict(state_root=w.chain_root)}[method]

        class Subs:
            def get(self, path):
                return dict(root="a" * 64, txid=w.subs_txid) if path.endswith("/pipeline") else w.get(path)

        peer = SimpleNamespace(call=call)
        w.c.clients.btc = w.c.clients.spaced = lambda: peer
        w.c.clients.subs_read = lambda: Subs()
        w.c._commitment_observation = lambda b: dict(txid=b["txid"], tipHeight=200, tipHash="b" * 64,
                                                   minedHeight=50, rootHeight=50, anchorHeight=200)
        return w

    def test_A51_known_armed_transaction_is_adopted_without_a_send_or_new_permission(self):
        w = self.world()
        w.c.reconcile_bound()
        b = w.c.batch("b1")
        self.assertEqual((b["txid"], b["intent"], b["attempted"]), ("c" * 64, 1, 1))
        statement = w.c.bound_statement()
        self.assertEqual(statement["entries"][0]["walletTxid"], "c" * 64)
        self.assertEqual(w.c.batch("b1")["state"], "final")
        self.assertEqual((w.closed, w.rollbacks), (0, 0))
        self.assertFalse(any("send" in c or "sign" in c for c in w.calls))
        self.assertFalse(w.c.registry.journal_ok("o1"))

    def test_A57_anchor_file_startup_and_rewrite_errors_retry_with_a_bound_other_errors_refuse(self):
        w = self.world()
        for message in ("Could not open anchors file: unavailable", "Could not read anchors file: partial"):
            with self.subTest(message=message), patch("controller.core.time.sleep") as sleep:
                results = [RpcError("getrootanchors", {"code": -1, "message": message}), [{"mock": "anchor"}]]

                def call(*args):
                    value = results.pop(0)
                    if isinstance(value, Exception):
                        raise value
                    return value

                w.c.clients.spaced = lambda: SimpleNamespace(call=call)
                self.assertEqual(w.c.root_anchors(attempts=2), [{"mock": "anchor"}])
                sleep.assert_called_once_with(0.25)
        for message, expected_calls in (("Could not open anchors file: unavailable", 2), ("unrelated RPC failure", 1)):
            with self.subTest(message=message), patch("controller.core.time.sleep"):
                calls = []

                def unavailable(*args):
                    calls.append(args)
                    raise RpcError("getrootanchors", {"code": -1, "message": message})

                w.c.clients.spaced = lambda: SimpleNamespace(call=unavailable)
                with self.assertRaises(RpcError):
                    w.c.root_anchors(attempts=2)
                self.assertEqual(len(calls), expected_calls)
                self.assertEqual((w.closed, w.rollbacks), (0, 0))

    def test_A52_unknown_or_conflicting_armed_identity_and_journal_outage_retain_ownership(self):
        for fault in ("unknown", "conflict", "journal"):
            with self.subTest(fault=fault):
                w = self.world()
                if fault == "unknown":
                    w.inventory["entries"][0]["txid"] = None
                elif fault == "conflict":
                    w.c._save("b1", txid="9" * 64)
                else:
                    w.journal.set_down(True)
                with self.assertRaises(Refused):
                    w.c.reconcile_bound()
                self.assertEqual(w.c.batch("b1")["entry_key"], "1" * 32)
                self.assertEqual((w.closed, w.rollbacks), (0, 0))

    def test_A53_missing_bindings_and_attempted_open_entries_cannot_be_declared_unsent(self):
        for fault in ("binding", "orphan", "unbound", "open-attempt"):
            with self.subTest(fault=fault):
                w = self.world()
                if fault == "binding":
                    w.inventory["entries"][0]["root"] = "9" * 64
                elif fault == "orphan":
                    w.c.db.execute("delete from batches")
                elif fault == "unbound":
                    w.inventory["entries"].clear()
                    w.c.registry.entries.clear()
                    w.c._save("b1", state="broadcast")
                else:
                    w.inventory["entries"][0]["delegate"] = None
                    w.c._save("b1", attempted=1)
                with self.assertRaises(Refused):
                    w.c.reconcile_bound()
                self.assertEqual((w.closed, w.rollbacks), (0, 0))

    def test_A54_unknown_wallet_chain_or_recipient_facts_refuse_completion(self):
        for fault in ("wallet-history", "wallet-tip", "chain-root", "recipient", "missing-attachment-route", "rpc"):
            with self.subTest(fault=fault):
                w = self.world()
                w.c.reconcile_bound()
                if fault == "wallet-history":
                    w.wallet_ids = []
                elif fault == "wallet-tip":
                    w.wallet_tip -= 1
                elif fault == "chain-root":
                    w.chain_root = "9" * 64
                elif fault == "recipient":
                    w.info["n1"]["script_pubkey"] = "foreign-script"
                elif fault == "missing-attachment-route":
                    w.subs_txid = None
                else:
                    w.rpc_failure = True
                with self.assertRaises((Refused, ConnectionError)):
                    w.c.bound_statement()
                self.assertEqual((w.closed, w.rollbacks), (0, 0))

    def test_A55_normal_runner_requires_its_own_acknowledged_completion_and_store_identity(self):
        w = self.world()
        db = sqlite3.connect(":memory:")
        self.addCleanup(db.close)
        db.executescript("create table store_meta(id integer, store text); insert into store_meta values(1,'mock-store');")
        statement = {k: w.inventory[k] for k in ("store", "sourceSequence")}
        position = w.journal.append("store_reconciliation", statement=statement, proofHash=digest(statement))
        marker = dict(version=2, required=False, controllerSequence=position, proofHash=digest(statement), sourceSequence=1)
        w.c.recovery_report = lambda: dict(ready=True, waiting=[], paused=[])
        store = SimpleNamespace(db=db, status=lambda: dict(chain={"blocks": 200}, application_recovery=marker))
        runner = SimpleNamespace(c=w.c, store=store)
        self.assertTrue(recovery_status(runner)["ready"])
        for fault in ("proof", "store", "source", "outage"):
            original = copy.deepcopy(marker)
            if fault == "proof":
                marker["proofHash"] = "9" * 64
            elif fault == "store":
                db.execute("update store_meta set store='another-store'")
            elif fault == "source":
                marker["sourceSequence"] += 1
            else:
                w.journal.set_down(True)
            self.assertFalse(recovery_status(runner)["ready"])
            marker.update(original)
            db.execute("update store_meta set store='mock-store'")
            w.journal.set_down(False)

    def test_A56_coordinated_snapshot_checks_all_bytes_identity_and_journal_bounds(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with sqlite3.connect(root / "registry.db") as db:
                db.executescript("create table store_meta(id integer, store text); insert into store_meta values(1,'mock-store');")
            (root / "controller.db").write_bytes(b"mock-controller-snapshot")
            files = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()}
            manifest = dict(files=files, store_journal=2, controller_journal=3)
            inventory = dict(store="mock-store", sequence=5)
            validate_snapshot(root, manifest, inventory, 4)
            for fault in ("hash", "extra", "identity", "store-bound", "controller-bound", "traversal"):
                with self.subTest(fault=fault):
                    m, i = copy.deepcopy(manifest), dict(inventory)
                    if fault == "hash":
                        m["files"]["controller.db"] = "0" * 64
                    elif fault == "extra":
                        (root / "extra").touch()
                    elif fault == "identity":
                        i["store"] = "another-store"
                    elif fault == "store-bound":
                        m["store_journal"] = 6
                    elif fault == "controller-bound":
                        m["controller_journal"] = 5
                    else:
                        m["files"]["../escape"] = "0" * 64
                    with self.assertRaises(Refused):
                        validate_snapshot(root, m, i, 4)
                    (root / "extra").unlink(missing_ok=True)
