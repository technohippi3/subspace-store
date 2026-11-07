"""The off-host journals, simulated by a directory outside the host's state.

Two journals, as in CONTROLLER-DESIGN.md: the store's (orders, `issuing`
marks) and the controller's (batches, intents, answers). An append is
acknowledged only after the line is written, fsynced and read back with a
matching SHA-256. A file named `<journal>.down` in the off-host directory
simulates an outage of that journal: appends fail and nothing is
acknowledged.

On a regtest run the off-host directory is `.run/<run>/offhost/`, and the
host's own state is `.run/<run>/host/`. A host loss deletes the host
directory and keeps this one.
"""

import hashlib
import json
import os
from pathlib import Path


class JournalDown(Exception):
    pass


class Journal:
    def __init__(self, offhost_dir, name):
        self.dir = Path(offhost_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.name = name
        self.path = self.dir / f"{name}.jsonl"

    def down(self):
        return (self.dir / f"{self.name}.down").exists()

    def set_down(self, down):
        flag = self.dir / f"{self.name}.down"
        if down:
            flag.touch()
        else:
            flag.unlink(missing_ok=True)

    def append(self, kind, **data):
        """Append one entry and return its sequence number once acknowledged."""
        if self.down():
            raise JournalDown(f"{self.name} journal unavailable")
        seq = len(self.entries()) + 1
        entry = {"seq": seq, "kind": kind, **data}
        line = json.dumps(entry, sort_keys=True)
        digest = hashlib.sha256(line.encode()).hexdigest()
        with open(self.path, "a") as f:
            f.write(line + "\n")
            f.flush()
            os.fsync(f.fileno())
        # Confirmation is per object: read the entry back and compare digests.
        back = self.path.read_text().splitlines()[seq - 1]
        if hashlib.sha256(back.encode()).hexdigest() != digest:
            raise JournalDown(f"{self.name} journal read-back mismatch at {seq}")
        return seq

    def entries(self):
        if not self.path.exists():
            return []
        return [json.loads(l) for l in self.path.read_text().splitlines() if l]

    def acknowledged(self, predicate):
        """True if some acknowledged entry satisfies `predicate`."""
        return any(predicate(e) for e in self.entries())

    def position(self):
        return len(self.entries())
