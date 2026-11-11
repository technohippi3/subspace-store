"""Lifetime ownership of a store database, including startup and restore.

Leave the lock file in place. Unlinking it permits another writer to lock
another inode. Closing the last descriptor (also after process death)
releases ownership; a forked child retains it until its descriptor closes.
"""

import fcntl
import os
import sqlite3
from pathlib import Path


class StoreBusy(Exception):
    pass


class Ownership:
    def __init__(self, database):
        path = str(Path(database).resolve()) + ".lock"
        self.file = os.fdopen(os.open(path, os.O_CREAT | os.O_RDWR, 0o600), "rb")
        try:
            fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException as error:
            self.file.close()
            if isinstance(error, BlockingIOError):
                raise StoreBusy("store busy: another process owns the database") from error
            raise

    def close(self):
        self.file.close()


class OwnedConnection(sqlite3.Connection):
    def __init__(self, *args, ownership, **kwargs):
        self.ownership = ownership
        super().__init__(*args, **kwargs)

    def close(self):
        try:
            super().close()
        finally:
            self.ownership.close()
