"""Controller entry protocol with recording stand-ins, not chain evidence."""
import json
import tempfile
import unittest
from pathlib import Path

from controller.core import Clients, Controller, Refused
from controller.host import ConfigError, check
from controller.journal import Journal
from runner.store import Refused as StoreRefused, Store, TypeScriptStore, configured_store
from tests.test_controller_host import config


class EntryRecovery(unittest.TestCase):
    def test_A24_store_protocol_selection_and_malformed_replies_never_fall_back(self):
        cfg = dict(url="http://127.0.0.1:9", operator_token_file="mock-token",
                   db="mock-db", journal_dir="mock-journal")
        self.assertIs(type(configured_store(cfg)), Store)
        typed = configured_store(dict(cfg, implementation="typescript"))
        self.assertIs(type(typed), TypeScriptStore)
        with self.assertRaises(StoreRefused):
            configured_store(dict(cfg, implementation="unknown"))
        with tempfile.TemporaryDirectory() as tmp:
            for mode in ("unknown", None, False):
                with self.assertRaises(ConfigError):
                    check(config(tmp, write=False, store__implementation=mode))
        b = dict(entry_key="1" * 32, root="a" * 64, members=["o1"])
        good = dict(found=True, entry=b["entry_key"], root=b["root"], oids=["o1"],
                    acknowledged=True, batchable=True, phase="open", delegate=None)
        for reply in ({"found": 0}, {"found": True}, dict(good, root="b" * 64),
                      dict(good, oids=["o2"]), dict(good, acknowledged=1), dict(good, extra=True)):
            calls = []
            typed.op = lambda method, path, body: calls.append(path) or reply
            with self.assertRaises(StoreRefused):
                typed.entry_status(b)
            self.assertEqual(calls, ["/operator/issuance-entries/lookup"])

    def test_A25_entry_identity_is_journaled_before_contact_and_survives_a_lost_reply(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            journal = Journal(root / "journal", "controller")
            writes = []
            test = self

            class Registry:
                bound_entries = True
                entered = None
                creates = 0
                calls = 0

                def observe(self):
                    pass

                def batch_entry_ok(self, oid):
                    return True

                def entry_status(self, b, create=False):
                    self.calls += 1
                    ack = c.acknowledged(b["bid"])
                    test.assertEqual(ack["entry_key"], b["entry_key"])
                    test.assertEqual((ack["root"], ack["members"]), (b["root"], b["members"]))
                    if self.entered is None and not create:
                        return {"found": False}
                    if create:
                        self.creates += 1
                        self.entered = dict(found=True, acknowledged=True, batchable=True, phase="open", delegate=None)
                        raise ConnectionError("simulated lost entry reply")
                    return self.entered

                def arm_entry(self, b):
                    self.entered.update(phase="armed", delegate=b["delegate_in"])
                    return dict(self.entered, granted=True)

            class Subs:
                def post(self, path, body, **kwargs):
                    writes.append(path)
                    return json.dumps({"txid": "a" * 64})

            registry = Registry()
            def opened():
                result = Controller(root / "controller.db", journal, registry,
                                    Clients(Subs, Subs, lambda: None, lambda: None), None,
                                    root / "mock-verifier", root / "work", "mock-wallet")
                result.live_delegate = lambda space: {"outpoint": "mock-delegate:0"}
                result.capture_bytes = lambda bid: None
                return result

            c = opened()
            try:
                c.db.execute("insert into batches(bid,space,members,digest,state,root) "
                             "values('b1','@space',?,'mock-digest','checkpointed',?)",
                             (json.dumps(["o1"]), "a" * 64))
                c._journal("b1")
                journal.set_down(True)
                with self.assertRaises(Refused):
                    c.issue("b1")
                self.assertEqual(registry.calls, 0)
                key = c.batch("b1")["entry_key"]
                journal.set_down(False)
                with self.assertRaises(ConnectionError):
                    c.issue("b1")
                self.assertEqual(c.batch("b1")["state"], "checkpointed")
                self.assertEqual(writes, [])
            finally:
                c.close()
            c = opened()
            try:
                c.issue("b1")
                self.assertEqual(c.batch("b1")["entry_key"], key)
                self.assertEqual(c.batch("b1")["state"], "broadcast")
                self.assertEqual(registry.creates, 1)
                self.assertEqual(writes, ["/spaces/@space/broadcast"])
                with self.assertRaises(Refused):
                    c.issue("b1")
            finally:
                c.close()
