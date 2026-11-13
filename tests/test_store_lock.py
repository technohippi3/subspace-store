"""H12: real store process ownership, independent of SQLite transactions."""

import selectors
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from service.journal import MemoryJournal
from service.ledger import Ledger, restore_from_journal
from service.locking import StoreBusy


CHILD = '''
import sys
from pathlib import Path
from service.journal import MemoryJournal
from service.ledger import Ledger, restore_from_journal
from service.locking import StoreBusy
root = Path(sys.argv[1])
if sys.argv[2] == "hold":
    store = Ledger(root / "store.db", None, MemoryJournal())
    print("owned", flush=True)
    sys.stdin.read()
    store.close()
else:
    def forbidden_journal():
        (root / "journal-touched").touch()
        raise AssertionError("journal accessed before ownership")
    import sqlite3
    def forbidden_database(*args, **kwargs):
        (root / "database-touched").touch()
        raise AssertionError("database accessed before ownership")
    sqlite3.connect = forbidden_database
    try:
        if sys.argv[2] == "restore":
            restore_from_journal(root / "store.db", forbidden_journal)
        else:
            Ledger(root / "store.db", None, forbidden_journal)
    except StoreBusy as error:
        print(str(error), flush=True)
        raise SystemExit(3)
    raise AssertionError("second writer admitted")
'''


class StoreOwnership(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / 'store.db'

    def command(self, mode):
        return [sys.executable, '-c', CHILD, str(self.root), mode]

    def test_H12_busy_start_and_restore_touch_neither_database_nor_journal(self):
        store = Ledger(self.path, None, MemoryJournal())
        self.addCleanup(store.close)
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        for mode in ('open', 'restore'):
            result = subprocess.run(self.command(mode), capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 3, result.stderr)
            self.assertIn('store busy', result.stdout)
            self.assertEqual({p.name: p.read_bytes() for p in self.root.iterdir()}, before)

    def test_H12_process_death_and_normal_exit_release_ownership(self):
        for killed in (True, False):
            with self.subTest(killed=killed):
                child = subprocess.Popen(self.command('hold'), stdin=subprocess.PIPE,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    with selectors.DefaultSelector() as ready:
                        ready.register(child.stdout, selectors.EVENT_READ)
                        self.assertTrue(ready.select(timeout=10), 'child did not acquire ownership')
                    self.assertEqual(child.stdout.readline().strip(), 'owned')
                    with self.assertRaises(StoreBusy):
                        Ledger(self.path, None, MemoryJournal())
                    if killed:
                        child.kill()
                    child.communicate(timeout=10)
                    if not killed:
                        self.assertEqual(child.returncode, 0)
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.communicate(timeout=10)
                Ledger(self.path, None, MemoryJournal()).close()

    def test_H12_failed_start_direct_close_and_path_alias_release_correctly(self):
        with patch.object(Ledger, 'audit_recipients', side_effect=RuntimeError('startup')):
            with self.assertRaisesRegex(RuntimeError, 'startup'):
                Ledger(self.path, None, MemoryJournal())
        store = Ledger(self.path, None, MemoryJournal())
        alias = self.root / 'alias.db'
        alias.symlink_to(self.path)
        with self.assertRaises(StoreBusy):
            Ledger(alias, None, MemoryJournal())
        store.db.close()
        Ledger(alias, None, MemoryJournal()).close()
        self.assertTrue(Path(str(self.path) + '.lock').exists())

    def test_H12_failed_journal_open_releases_before_database_creation(self):
        def unavailable():
            raise OSError('journal unavailable')
        with self.assertRaisesRegex(OSError, 'journal unavailable'):
            Ledger(self.path, None, unavailable)
        self.assertFalse(self.path.exists())
        Ledger(self.path, None, MemoryJournal()).close()
