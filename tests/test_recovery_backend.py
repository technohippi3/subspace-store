"""Production adapter composition against controlled offhost replies.

These tests execute the actual controller snapshot, runner restore and SQL
prefix checks. They do not claim SSH, chain or systemd qualification.
"""
import base64
import hashlib
import json
import select
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

from controller import host
from controller.core import Controller, Clients
from controller.errors import Refused
from controller.journal import JournalDown
from controller.recovery_backend import (RemoteJournal, acknowledged_store_position,
    acknowledged_controller_position, reference, StoreAcknowledgmentsPending)
from runner.cli import Runner, NotConfirmed
from runner.recovery_bridge import RecoveryStore
from runner.store import TypeScriptStore
from tests.test_controller_host import FakeSubs, config as host_config


class Backend:
    def __init__(self):
        self.streams = {"store": [b"acknowledged-store-record"], "controller": []}
        self.snapshots = {}
        self.down = False
        self.refuse_upload = False
        self.operations = []
        self.subs = None

    def request(self, request):
        self.operations.append(request.copy())
        if self.down:
            raise JournalDown("offhost unavailable")
        rows = self.streams[request["stream"]]
        if request["op"] == "journal-read":
            after = request["after"]
            return {"head": len(rows), "entries": [dict(sequence=i + 1,
                data=base64.b64encode(raw).decode(), sha256=hashlib.sha256(raw).hexdigest())
                for i, raw in list(enumerate(rows))[after:after + request["limit"]]]}
        if request["op"] == "journal-append":
            index = request["sequence"] - 1
            raw = base64.b64decode(request["data"], validate=True)
            if index == len(rows):
                rows.append(raw)
            elif index >= len(rows) or rows[index] != raw:
                raise JournalDown("immutable conflict")
            return {"sequence": index + 1, "sha256": hashlib.sha256(raw).hexdigest()}
        raise AssertionError(request)

    def list_snapshots(self):
        if self.down:
            raise JournalDown("offhost unavailable")
        return list(self.snapshots)

    def upload_snapshot(self, directory, name):
        assert not self.subs.running, "subs must stay stopped through acknowledgment"
        self.operations.append({"op": "upload", "snapshot": name})
        if self.refuse_upload or self.down:
            raise JournalDown("offhost checkpoint unavailable")
        self.snapshots[name] = {str(p.relative_to(directory)): p.read_bytes()
            for p in Path(directory).rglob("*") if p.is_file()}
        return {"snapshot": name, "sha256": "a" * 64}

    def materialize_snapshot(self, name, directory):
        if self.down:
            raise JournalDown("offhost unavailable")
        directory.mkdir(mode=0o700)
        for relative, raw in self.snapshots[name].items():
            path = directory / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        return {"snapshot": name, "kind": "checkpoint"}


class RecoveryBackendCases(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.backend = Backend()
        self.subs = FakeSubs([])
        self.subs.data_dir = self.root / "subs"
        self.subs.data_dir.mkdir()
        (self.subs.data_dir / "state").write_bytes(b"actual stopped snapshot fixture")
        self.backend.subs = self.subs
        db = sqlite3.connect(self.root / "store.db")
        db.execute("pragma journal_mode=wal")
        db.executescript("create table store_meta(id integer,version integer,store text);"
            "insert into store_meta values(1,1,'fixture-store');"
            "create table outbox(seq integer,payload text,acknowledged integer);"
            "insert into outbox values(1,'acknowledged-store-record',1)")
        db.close()
        self.store = TypeScriptStore("http://127.0.0.1:9", self.root / "token",
            self.root / "store.db", self.root / "must-not-create-local-mirror", self.backend)
        self.addCleanup(lambda: self.store._db.close() if self.store._db else None)
        self.c = self.controller("controller.db", self.store, self.subs)
        self.addCleanup(self.c.close)
        self.c.db.execute("insert into batches(bid,space,members,digest,state,root) values('b1','space','[]','fixture-digest','proved',?)", ("a" * 64,))
        self.assertTrue(self.c._journal("b1"))

    def controller(self, name, registry, subs):
        client = subs.client
        c = Controller(self.root / name, RemoteJournal(self.backend), registry,
            Clients(client, client, None, None), subs, self.root / "verifier",
            self.root / (name + "-certs"), "fixture-wallet",
            snapshot_dir=self.root / "staging", ready_timeout=1)
        self.assertIs(c.recovery_backend, self.backend)
        return c

    def test_prefixes_require_actual_remote_bytes_and_complete_batch_projection(self):
        self.assertFalse((self.root / "must-not-create-local-mirror").exists())
        self.assertEqual(self.store.journal.position(), 1)
        self.assertEqual(acknowledged_controller_position(self.c.db, self.backend), 1)
        self.backend.streams["store"][0] = b"different-with-the-same-count"
        with self.assertRaises(JournalDown):
            self.store.journal.position()
        self.backend.streams["store"][0] = b"acknowledged-store-record"
        self.c.db.execute("update batches set digest='local-only-unacknowledged'")
        with self.assertRaises(JournalDown):
            acknowledged_controller_position(self.c.db, self.backend)
        self.backend.down = True
        with self.assertRaises(JournalDown):
            self.store.journal.position()
        with self.assertRaises(JournalDown):
            self.c.journal.position()
        self.assertFalse((self.root / "must-not-create-local-mirror").exists())

    def test_checkpoint_waits_for_remote_ack_and_never_promotes_failed_upload(self):
        self.backend.refuse_upload = True
        with self.assertRaises(JournalDown):
            self.c.checkpoint("b1")
        self.assertEqual(self.c.batch("b1")["state"], "proved")
        self.assertFalse(self.subs.running)
        self.assertEqual(self.subs.posts, [])
        self.assertEqual(self.backend.snapshots, {})
        self.backend.refuse_upload = False
        result = self.c.checkpoint("b1")
        self.assertEqual(self.c.batch("b1")["state"], "checkpointed")
        self.assertTrue(self.subs.running)
        self.assertEqual((result["store_journal"], result["controller_journal"]), (1, 1))
        self.assertEqual(list(self.backend.snapshots), ["001-b1"])
        self.assertEqual(set(self.backend.snapshots["001-b1"]), {"registry.db", "controller.db", "manifest.json", "subs/state"})
        for name in ("registry.db", "controller.db"):
            with sqlite3.connect(str(Path(result["dir"]) / name)) as copied:
                self.assertEqual(copied.execute("pragma journal_mode").fetchone()[0], "delete")
        manifest = json.loads(self.backend.snapshots["001-b1"]["manifest.json"])
        self.assertEqual((manifest["store_journal"], manifest["controller_journal"]), (1, 1))
        self.assertFalse((self.root / "must-not-create-local-mirror").exists())

    def test_live_checkpoint_takes_fresh_copy_after_actual_sqlite_acknowledgment(self):
        source = self.root / "store.db"
        with sqlite3.connect(source) as db:
            db.execute("update outbox set acknowledged=0")
            db.execute("create table checkpoint_projection(value text)")
            db.execute("insert into checkpoint_projection values('keep committed projection')")
        self.backend.streams["store"].append(b"later unrelated acknowledged record")
        # A read-only observer signals the real completed-copy classification.
        # The separate writer never opens an in-progress backup or controls
        # the checkpoint's return values; it commits only the live marker.
        signal = self.root / "pending-copy-observed"
        code = """
import sqlite3,sys,time
from pathlib import Path
source,signal=Path(sys.argv[1]),Path(sys.argv[2])
print('ready',flush=True)
deadline=time.monotonic()+10
while time.monotonic()<deadline:
    if signal.exists():
        # A normal remote acknowledgment may span several SSH requests.
        time.sleep(1)
        with sqlite3.connect(source) as db:
            assert db.execute('select acknowledged from outbox where seq=1').fetchone()==(0,)
            db.execute('update outbox set acknowledged=1 where seq=1')
        print('acknowledged')
        raise SystemExit(0)
    time.sleep(0.005)
raise SystemExit('pending checkpoint copy was never observed')
"""
        process = subprocess.Popen([sys.executable, "-c", code, str(source), str(signal)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        def observed(connection, backend, **options):
            try:
                return acknowledged_store_position(connection, backend, **options)
            except StoreAcknowledgmentsPending:
                self.assertEqual(connection.execute("select seq,payload,acknowledged from outbox").fetchall(),
                                 [(1, "acknowledged-store-record", 0)])
                signal.touch()
                raise
        try:
            self.assertTrue(select.select([process.stdout], [], [], 10)[0], "SQLite writer did not start")
            self.assertEqual(process.stdout.readline(), "ready\n")
            with patch("controller.recovery_backend.acknowledged_store_position", side_effect=observed):
                result = self.c.checkpoint("b1")
            output, errors = process.communicate(timeout=10)
            self.assertEqual((process.returncode, output, errors), (0, "acknowledged\n", ""))
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate()
        self.assertEqual(self.c.batch("b1")["state"], "checkpointed")
        self.assertTrue(self.subs.running)
        self.assertEqual(result["store_journal"], 1)
        self.assertEqual(len(self.backend.streams["store"]), 2)
        with self.assertRaises(JournalDown):
            self.store.journal.position()
        with sqlite3.connect(Path(result["dir"]) / "registry.db") as copied:
            self.assertEqual(copied.execute("select seq,payload,acknowledged from outbox").fetchall(),
                             [(1, "acknowledged-store-record", 1)])
            self.assertEqual(copied.execute("select value from checkpoint_projection").fetchone(),
                             ("keep committed projection",))
        pending = list((self.root / "staging").glob("checkpoint-*/store-copies-*/001.db"))
        self.assertEqual(len(pending), 1)
        with sqlite3.connect(pending[0]) as copied:
            self.assertEqual(copied.execute("select acknowledged from outbox").fetchall(), [(0,)])
        self.assertEqual(set(self.backend.snapshots["001-b1"]),
                         {"registry.db", "controller.db", "manifest.json", "subs/state"})

    def test_persistent_pending_copy_exhausts_eight_attempts_without_repair_or_upload(self):
        with sqlite3.connect(self.root / "store.db") as db:
            db.execute("update outbox set acknowledged=0")
        with self.assertRaises(StoreAcknowledgmentsPending):
            self.c.checkpoint("b1")
        copies = list((self.root / "staging").glob("checkpoint-*/store-copies-*/*.db"))
        self.assertEqual(len(copies), 8)
        for candidate in [self.root / "store.db", *copies]:
            with sqlite3.connect(candidate) as db:
                self.assertEqual(db.execute("select seq,payload,acknowledged from outbox").fetchall(),
                                 [(1, "acknowledged-store-record", 0)])
        self.assertEqual(self.c.batch("b1")["state"], "proved")
        self.assertFalse(self.subs.running)
        self.assertEqual(self.backend.snapshots, {})
        self.assertEqual(self.subs.posts, [])

    def test_actual_backup_progress_deadline_preserves_failed_copy_and_stopped_subs(self):
        with patch("controller.recovery_backend.time.monotonic", side_effect=[0, 0, 31]):
            with self.assertRaisesRegex(JournalDown, "copy deadline exceeded"):
                self.c.checkpoint("b1")
        copies = list((self.root / "staging").glob("checkpoint-*/store-copies-*/*.db"))
        self.assertEqual(len(copies), 1)
        self.assertEqual(copies[0].stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.c.batch("b1")["state"], "proved")
        self.assertFalse(self.subs.running)
        self.assertEqual(self.backend.snapshots, {})
        self.assertEqual(self.subs.posts, [])

    def test_invalid_or_remote_checkpoint_proof_never_enters_pending_copy_retry(self):
        original = self.backend.request
        for failure in ("gap", "flag", "hole", "bytes", "remote", "controller"):
            with self.subTest(failure=failure):
                with sqlite3.connect(self.root / "store.db") as db:
                    db.execute("delete from outbox")
                    db.execute("insert into outbox values(1,'acknowledged-store-record',1)")
                    if failure == "gap":
                        db.execute("update outbox set seq=2")
                    elif failure == "flag":
                        db.execute("update outbox set acknowledged=2")
                    elif failure == "hole":
                        db.execute("update outbox set acknowledged=0")
                        db.execute("insert into outbox values(2,'later',1)")
                    elif failure == "bytes":
                        db.execute("update outbox set payload='unacknowledged replacement'")
                self.c.db.execute("update batches set digest=?", ("wrong" if failure == "controller" else "fixture-digest",))
                before = set((self.root / "staging").glob("checkpoint-*/store-copies-*"))
                def request(value):
                    if failure == "remote" and value.get("stream") == "store":
                        raise JournalDown("remote unavailable")
                    return original(value)
                with patch.object(self.backend, "request", side_effect=request):
                    with self.assertRaises(JournalDown) as error:
                        self.c.checkpoint("b1")
                self.assertNotIsInstance(error.exception, StoreAcknowledgmentsPending)
                after = set((self.root / "staging").glob("checkpoint-*/store-copies-*"))
                self.assertEqual(len(after - before), 1)
                self.assertEqual(len(list((after - before).pop().glob("*.db"))),
                                 0 if failure == "controller" else 1)
                self.assertEqual(self.c.batch("b1")["state"], "proved")
                self.assertFalse(self.subs.running)
                self.assertEqual(self.backend.snapshots, {})
                self.assertEqual(self.subs.posts, [])

    def test_restore_requires_remote_materialization_and_preserves_unknown_quarantine(self):
        self.c.checkpoint("b1")
        self.assertTrue(self.c._save("b1", state="broadcast_uncertain", intent=1, attempted=1,
            delegate_in="fixture-delegate:0", entry_key="fixture-entry", root="a" * 64))
        self.c.close()
        # Dispose the serving host; only the acknowledged remote set survives.
        shutil.rmtree(self.root / "subs")
        shutil.rmtree(self.root / "staging")
        (self.root / "subs").mkdir()
        protected = self.root / "subs.restoring"
        protected.mkdir()
        (protected / "foreign").write_bytes(b"preserve ambiguous prior stage")
        inventory = dict(version=1, store="fixture-store", sourceSequence=1, sequence=1,
            tipHeight=10, tipHash="b" * 64, orders=[], spaces=[], entries=[dict(
                entry="fixture-entry", root="a" * 64, oids=[], space="space", closed=False,
                superseded=False, delegate="fixture-delegate:0", txid=None)])
        registry = RecoveryStore(inventory)
        c = self.controller("replacement.db", registry, self.subs)
        self.addCleanup(c.close)
        runner = Runner(registry, c, recovery_only=True)
        network_checks = []
        runner.require_networks = lambda **kw: network_checks.append(kw)
        before = list(self.backend.streams["controller"])
        self.backend.down = True
        with self.assertRaises(JournalDown):
            runner.restore()
        self.assertFalse((self.root / "subs/state").exists())
        self.assertEqual(network_checks, [])
        self.backend.down = False
        with self.assertRaisesRegex(Refused, "armed transaction unknown"):
            runner.restore()
        self.assertEqual((self.root / "subs/state").read_bytes(), b"actual stopped snapshot fixture")
        self.assertEqual((protected / "foreign").read_bytes(), b"preserve ambiguous prior stage")
        self.assertEqual(self.backend.streams["controller"], before)
        self.assertEqual(c.batch("b1")["state"], "broadcast_uncertain")
        self.assertEqual(c.recovery_state(), "incomplete")
        self.assertIsNone(c.restore_pending()["reconciled_at"])
        self.assertEqual(self.subs.posts, [])
        with self.assertRaisesRegex(NotConfirmed, "offline recovery cannot prepare, sign or send"):
            runner.issue("b1", 1, "b1")

    def test_bounded_large_pages_preserve_all_entries_and_refuse_excess_count_and_bytes(self):
        from controller.recovery_backend import JOURNAL_PAGE_ENTRIES, JOURNAL_PAGE_BYTES
        rows = [json.dumps({"seq": i + 1, "kind": "fixture"}).encode()
                for i in range(JOURNAL_PAGE_ENTRIES + 1)]
        self.backend.streams["controller"] = rows
        self.backend.operations.clear()
        self.assertEqual(len(RemoteJournal(self.backend).entries()), len(rows))
        reads = [r for r in self.backend.operations if r.get("op") == "journal-read" and r.get("stream") == "controller"]
        self.assertEqual([r["after"] for r in reads], [0, JOURNAL_PAGE_ENTRIES])
        self.assertTrue(all(r["limit"] == JOURNAL_PAGE_ENTRIES for r in reads))
        original = self.backend.request
        def excess(request):
            value = original(dict(request, limit=len(rows)))
            return value
        with patch.object(self.backend, "request", side_effect=excess):
            with self.assertRaises(JournalDown):
                RemoteJournal(self.backend).entries()
        self.backend.streams["controller"] = [json.dumps({"seq": 1, "kind": "fixture", "value": "x" * JOURNAL_PAGE_BYTES}).encode()]
        with self.assertRaises(JournalDown):
            RemoteJournal(self.backend).entries()
        self.backend.streams["store"] = rows
        db = sqlite3.connect(":memory:")
        self.addCleanup(db.close)
        db.executescript("create table store_meta(id integer, version integer); insert into store_meta values(1,1);"
                        "create table outbox(seq integer,payload text,acknowledged integer)")
        db.executemany("insert into outbox values(?,?,1)", [(i + 1, raw.decode()) for i, raw in enumerate(rows)])
        self.assertEqual(acknowledged_store_position(db, self.backend), len(rows))
        with patch.object(self.backend, "request", side_effect=excess):
            with self.assertRaises(JournalDown):
                acknowledged_store_position(db, self.backend)

    def test_config_is_explicit_lazy_and_has_no_local_fallback(self):
        cfg = host_config(self.root, version=2, store__implementation="typescript",
            controller__snapshot_dir=str(self.root / "explicit-staging"))
        ref = dict(version=1, node="/missing-node", client="/missing-client", config="/missing-config")
        cfg["recovery_backend"] = ref
        lock = self.root / "maintenance.lock"
        lock.write_bytes(b"")
        lock.chmod(0o600)
        cfg["maintenance_lock"] = str(lock)
        host.check(cfg)
        self.assertEqual(reference(ref), ref)
        for changed in (None, dict(ref, secret="not-allowed"), dict(ref, node="relative"), dict(ref, client=ref["node"]), dict(ref, version=True)):
            with self.assertRaises((ValueError, host.ConfigError)):
                reference(changed)
        for changed in (dict(cfg, version=1), dict(cfg, store=dict(cfg["store"], implementation="python")), dict(cfg, controller=dict(cfg["controller"], snapshot_dir="relative"))):
            with self.assertRaises(host.ConfigError):
                host.check(changed)
        with patch("controller.host.Journal", side_effect=AssertionError("local fallback")):
            # A missing client refuses during the actual Controller opening.
            with self.assertRaises(JournalDown):
                host.build(cfg, self.store)
        self.assertFalse((self.root / "offhost").exists())
