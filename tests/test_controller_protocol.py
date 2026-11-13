"""Mandatory history blocks actual old file/remote controllers before effects."""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

from controller.journal_protocol import PREFIX, decode_record, require_abort_protocol
from controller.recovery_backend import RemoteJournal
from tests import test_controller_preparation as preparation_fixture
from tests.legacy_controller_source import REVISIONS, ROOT, export_revision
from tests.test_recovery_backend import Backend


class ControllerProtocol(unittest.TestCase):
    world = preparation_fixture.ControllerPreparation.world

    def test_actual_legacy_controllers_refuse_file_and_remote_history_with_older_database(self):
        with tempfile.TemporaryDirectory() as temporary:
            for revision in REVISIONS:
                source = pathlib.Path(temporary) / revision
                export_revision(source, revision, "controller")
                for mode in ("file", "remote"):
                    w = self.world(); w.c.close()
                    old = w.root / "older.db"; shutil.copyfile(w.root / "controller.db", old)
                    def run():
                        result = subprocess.run([sys.executable, str(ROOT / "tests/legacy_controller_process.py"), str(source), str(old), str(w.journal.path), mode],
                                                capture_output=True, text=True, timeout=20)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        return json.loads(result.stdout)
                    self.assertEqual(run(), dict(opened=True, calls=[]), (revision, mode))
                    require_abort_protocol(w.journal)
                    result = run()
                    self.assertEqual(result, dict(opened=False, error="JSONDecodeError", calls=[]), (revision, mode))
                    self.assertTrue(any(row["kind"] == "controller_protocol" for row in w.journal.entries()))
                    w.c = w.open()

    def test_remote_floor_is_opaque_immutable_and_recoverable_after_lost_append_reply(self):
        backend = Backend(); journal = RemoteJournal(backend)
        request = backend.request
        lost = False
        def lose_after(data):
            nonlocal lost
            result = request(data)
            if data["op"] == "journal-append" and not lost:
                lost = True
                raise ConnectionError("recording lost append reply")
            return result
        backend.request = lose_after
        with self.assertRaises(ConnectionError): require_abort_protocol(journal)
        self.assertTrue(backend.streams["controller"][0].startswith(PREFIX.encode()))
        restarted = RemoteJournal(backend)
        require_abort_protocol(restarted)
        self.assertEqual(len(backend.streams["controller"]), 1)
        self.assertEqual(restarted.position(), 1)

    def test_framed_unknown_features_versions_and_unframed_floor_refuse(self):
        good = dict(seq=1, kind="controller_protocol", version=3, requires=["preparation_abort_v1"])
        for value in (dict(good, version=4), dict(good, requires=["unknown"]), dict(good, extra=True), dict(good, seq=True)):
            with self.assertRaises(ValueError): decode_record(PREFIX + json.dumps(value))
        with self.assertRaises(ValueError): decode_record(json.dumps(good))
        with self.assertRaisesRegex(ValueError, "duplicate"):
            decode_record(PREFIX + json.dumps(good)[:-1] + ',"version":3}')

    def test_existing_unframed_abort_history_is_upgraded_before_controller_serves(self):
        w = self.world(); w.seed("frozen")
        from controller.preparation_history import PreparationBarrier
        b = w.c.batch("b1"); barrier = PreparationBarrier(w.journal); barrier.acquire(b)
        barrier.effect(b, "pending_set", [], lambda: True, pending=True)
        w.c.abort_preparation("b1")
        rows = [row for row in w.journal.entries() if row["kind"] != "controller_protocol"]
        for seq, row in enumerate(rows, 1): row["seq"] = seq
        w.journal.path.write_text("".join(json.dumps(row) + "\n" for row in rows))
        w.restart()
        self.assertEqual(w.journal.entries()[-1]["kind"], "controller_protocol")
        self.assertEqual(w.c.abort_preparation("b1")["state"], "rebuilt")
