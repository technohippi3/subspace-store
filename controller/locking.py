"""Lifetime ownership of a controller database on the local Linux host.

SQLite transactions protect individual writes. This lock also covers RPC
waits and the startup reconciliation between those transactions. The lock
file stays in place: unlinking it would let another process lock a new inode.
"""

import fcntl
import os
import sqlite3
from pathlib import Path


class ControllerBusy(Exception):
    pass


class LockedConnection(sqlite3.Connection):
    def __init__(self, database, **kwargs):
        database = Path(database).resolve()
        fd = os.open(str(database) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
        self._ownership = os.fdopen(fd, "rb")
        try:
            try:
                fcntl.flock(self._ownership, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as e:
                raise ControllerBusy("controller busy: another runner owns the database; "
                                     "wait for it to finish") from e
            super().__init__(database, **kwargs)
        except BaseException:
            self._ownership.close()
            raise

    def close(self):
        try:
            super().close()
        finally:
            # Closing, rather than explicitly unlocking, also preserves
            # ownership if a forked child still holds this descriptor.
            self._ownership.close()
