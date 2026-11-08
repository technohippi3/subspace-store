"""The store's off-host journal.

An append is acknowledged only after the line is written, fsynced and read
back with a matching SHA-256. While the journal is unavailable, appends fail
and nothing is acknowledged; the ledger keeps a backlog and writes it again
once the journal is back.

Here the off-host journal is a directory the operator places on another
volume or host mount. A file named `store.down` in it marks an outage, for
tests. A separate store with per-object confirmation is later work
(docs/SERVICE.md).
"""

import hashlib
import json
import os
from pathlib import Path


class JournalDown(Exception):
    pass


class Journal:
    def __init__(self, directory, name="store"):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / f"{name}.jsonl"
        self.flag = self.dir / f"{name}.down"
        self._count = None

    def available(self):
        return not self.flag.exists()

    def set_available(self, available):
        if available:
            self.flag.unlink(missing_ok=True)
        else:
            self.flag.touch()

    def _lines(self):
        if not self.path.exists():
            return []
        return self.path.read_text().splitlines()

    def append(self, kind, **data):
        """Append one entry. Returns its sequence number once acknowledged."""
        if not self.available():
            raise JournalDown("store journal unavailable")
        if self._count is None:
            self._count = len(self._lines())
        seq = self._count + 1
        line = json.dumps({"seq": seq, "kind": kind, **data}, sort_keys=True)
        digest = hashlib.sha256(line.encode()).hexdigest()
        with open(self.path, "a") as f:
            f.write(line + "\n")
            f.flush()
            os.fsync(f.fileno())
        with open(self.path, "rb") as f:
            f.seek(-(len(line.encode()) + 1), os.SEEK_END)
            back = f.read().decode().rstrip("\n")
        if hashlib.sha256(back.encode()).hexdigest() != digest:
            self._count = None
            raise JournalDown(f"store journal read-back mismatch at {seq}")
        self._count = seq
        return seq

    def entries(self):
        return [json.loads(l) for l in self._lines() if l]


class MemoryJournal:
    """The same contract in memory, for the model twin tests."""

    def __init__(self):
        self._entries = []
        self.up = True

    def available(self):
        return self.up

    def set_available(self, available):
        self.up = available

    def append(self, kind, **data):
        if not self.up:
            raise JournalDown("store journal unavailable")
        self._entries.append({"seq": len(self._entries) + 1, "kind": kind,
                              **json.loads(json.dumps(data))})
        return len(self._entries)

    def entries(self):
        return list(self._entries)
