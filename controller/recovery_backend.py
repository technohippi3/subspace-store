"""Python controller transport boundary; no local mirror authorizes writes."""
import base64
from contextlib import closing
import hashlib
import json
from pathlib import Path
import subprocess
import os
import selectors
import signal
import sqlite3
import tempfile
import time
from .journal_protocol import encode_record, decode_record

try:
    from controller.journal import JournalDown
except ImportError:
    class JournalDown(Exception):
        pass


JOURNAL_PAGE_ENTRIES = 8192
JOURNAL_PAGE_BYTES = 16 * 1024 * 1024
STORE_COPY_ATTEMPTS = 8
STORE_COPY_SECONDS = 30


class StoreAcknowledgmentsPending(JournalDown):
    """A valid copied outbox has a locally unacknowledged suffix."""


class RecoveryBackend:
    def __init__(self, config, client, node):
        self.command = [str(node), str(client), "--config", str(config)]

    def request(self, request):
        try:
            encoded = json.dumps(request).encode()
            if len(encoded) > 24 * 1024 * 1024:
                raise ValueError()
            process = subprocess.Popen(self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, start_new_session=True)
            try:
                limit = 300 if request.get("op", "").startswith("snapshot-") else 30
                deadline = time.monotonic() + limit
                output = bytearray()
                offset = 0
                with selectors.DefaultSelector() as selector:
                    for pipe in (process.stdin, process.stdout):
                        os.set_blocking(pipe.fileno(), False)
                    selector.register(process.stdin, selectors.EVENT_WRITE)
                    selector.register(process.stdout, selectors.EVENT_READ)
                    while selector.get_map():
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise TimeoutError()
                        for key, event in selector.select(remaining):
                            if event & selectors.EVENT_WRITE:
                                offset += os.write(key.fd, encoded[offset:offset + 65536])
                                if offset == len(encoded):
                                    selector.unregister(key.fileobj)
                                    key.fileobj.close()
                            if event & selectors.EVENT_READ:
                                data = os.read(key.fd, 65536)
                                if not data:
                                    selector.unregister(key.fileobj)
                                    key.fileobj.close()
                                else:
                                    output.extend(data)
                                    if len(output) > 24 * 1024 * 1024:
                                        raise ValueError()
                process.wait(timeout=max(0.001, deadline - time.monotonic()))
            except BaseException:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                raise
            if process.returncode or len(output) > 24 * 1024 * 1024:
                raise ValueError()
            result = json.loads(output)
            if result.get("ok") is not True:
                raise ValueError()
            return result
        except Exception:
            raise JournalDown("off-host recovery operation unavailable") from None

    def upload_snapshot(self, directory, name, kind="checkpoint"):
        result = self.request({"op": "snapshot-put", "snapshot": name, "kind": kind, "directory": str(directory)})
        if result.get("snapshot") != name or not isinstance(result.get("sha256"), str):
            raise JournalDown("off-host checkpoint not acknowledged")
        return result

    def materialize_snapshot(self, name, directory):
        return self.request({"op": "snapshot-get", "snapshot": name, "directory": str(directory)})

    def list_snapshots(self):
        return self.request({"op": "snapshot-list"})["snapshots"]


class RemoteJournal:
    def __init__(self, backend, stream="controller"):
        if stream not in ("store", "controller"):
            raise JournalDown("unsupported journal")
        self.backend, self.stream = backend, stream
        self.pending = None

    @property
    def path(self):
        raise JournalDown("remote journal has no local authorization path")

    @property
    def dir(self):
        raise JournalDown("remote journal requires an explicit checkpoint staging path")

    def down(self):
        try:
            self.position()
            return False
        except JournalDown:
            return True

    def entries(self):
        result, after, size, head = [], 0, 0, None
        while True:
            page = self.backend.request({"op": "journal-read", "stream": self.stream, "after": after, "limit": JOURNAL_PAGE_ENTRIES})
            current = page.get("head")
            if type(current) is not int or not 0 <= current <= 1_000_000 or head is not None and current != head or not isinstance(page.get("entries"), list) or len(page["entries"]) > JOURNAL_PAGE_ENTRIES:
                raise JournalDown("journal prefix changed or exceeds replay bounds")
            head = current
            page_size = 0
            for item in page["entries"]:
                raw = base64.b64decode(item["data"], validate=True)
                size += len(raw)
                page_size += len(raw)
                if page_size > JOURNAL_PAGE_BYTES or size > 512 * 1024 * 1024 or len(result) >= 1_000_000 or item["sequence"] != after + 1 or hashlib.sha256(raw).hexdigest() != item["sha256"]:
                    raise JournalDown("journal replay bounds or digest mismatch")
                value = decode_record(raw.decode("utf-8"))
                if value.get("seq") != item["sequence"]:
                    raise JournalDown("journal sequence mismatch")
                result.append(value)
                after += 1
            if after == page["head"]:
                return result
            if not page["entries"] or after > page["head"]:
                raise JournalDown("journal prefix changed")

    def position(self):
        # A count-only remote head does not acknowledge an earlier prefix.
        return len(self.entries())

    def append(self, kind, **data):
        request_data = {"kind": kind, **data}
        if self.pending is not None and self.pending[0] != request_data:
            raise JournalDown("previous journal acknowledgment remains unresolved")
        if self.pending is None:
            sequence = self.position() + 1
            raw = encode_record({"seq": sequence, **request_data}).encode()
            self.pending = (request_data, sequence, raw)
        _, sequence, raw = self.pending
        result = self.backend.request({"op": "journal-append", "stream": self.stream, "sequence": sequence,
            "sha256": hashlib.sha256(raw).hexdigest(), "data": base64.b64encode(raw).decode()})
        if result.get("sequence") != sequence or result.get("sha256") != hashlib.sha256(raw).hexdigest():
            raise JournalDown("journal acknowledgment mismatch")
        self.pending = None
        return sequence

    def acknowledged(self, predicate):
        return any(predicate(entry) for entry in self.entries())


def reference(value):
    """References only; configuration never contains private credential bytes."""
    if not isinstance(value, dict) or set(value) != {"version", "node", "client", "config"} or type(value["version"]) is not int or value["version"] != 1:
        raise ValueError("invalid recovery backend reference")
    paths = [value[key] for key in ("node", "client", "config")]
    if any(not isinstance(p, str) or not p or len(p) > 4096 or "\0" in p or not Path(p).is_absolute() for p in paths) or len(set(paths)) != 3:
        raise ValueError("invalid recovery backend paths")
    return dict(value)


def configured(config):
    if "recovery_backend" not in config:
        return None
    ref = reference(config["recovery_backend"])
    return RecoveryBackend(ref["config"], ref["client"], ref["node"])


def acknowledged_store_position(connection, backend, *, exact_head=True, position=None):
    """Prove the copied SQLite outbox against actual decrypted remote bytes.

    A stopped maintenance checkpoint requires the exact head. An ordinary
    online checkpoint can copy a prefix while the paused seller still records
    unrelated observations; its snapshot claims only that copied prefix.
    """
    meta = connection.execute("select version from store_meta where id=1").fetchone()
    if not meta or meta[0] != 1:
        raise JournalDown("unsupported store schema")
    expected = connection.execute("select seq,payload,acknowledged from outbox order by seq").fetchall()
    if len(expected) > 1_000_000 or any(row[0] != i + 1 or type(row[2]) is not int or row[2] not in (0, 1)
                                      for i, row in enumerate(expected)) or position is not None and position != len(expected):
        raise JournalDown("store journal acknowledgments are not a complete prefix")
    pending = False
    for row in expected:
        if row[2] == 0:
            pending = True
        elif pending:
            raise JournalDown("store journal acknowledgment markers have a hole")
    if pending:
        raise StoreAcknowledgmentsPending("store journal acknowledgments are not a complete prefix")
    after, size, head = 0, 0, None
    while True:
        page = backend.request({"op": "journal-read", "stream": "store", "after": after, "limit": JOURNAL_PAGE_ENTRIES})
        current = page.get("head")
        if type(current) is not int or not len(expected) <= current <= 1_000_000 or not isinstance(page.get("entries"), list) or len(page["entries"]) > JOURNAL_PAGE_ENTRIES or exact_head and current != len(expected) or head is not None and current < head:
            raise JournalDown("store remote journal prefix differs from database")
        head = current
        page_size = 0
        for item in page["entries"]:
            raw = base64.b64decode(item["data"], validate=True)
            size += len(raw)
            page_size += len(raw)
            if page_size > JOURNAL_PAGE_BYTES or size > 512 * 1024 * 1024 or item["sequence"] != after + 1 or hashlib.sha256(raw).hexdigest() != item["sha256"]:
                raise JournalDown("store remote journal bytes differ from acknowledged database")
            if after < len(expected) and raw != expected[after][1].encode():
                raise JournalDown("store remote journal bytes differ from acknowledged database")
            after += 1
            if after == len(expected):
                return len(expected)
        if not expected:
            return 0
        if not page["entries"]:
            raise JournalDown("store remote journal prefix incomplete")


def copy_acknowledged_store(connection, backend, destination):
    """Select a fresh complete local copy, then prove its exact remote prefix."""
    destination = Path(destination)
    attempts = Path(tempfile.mkdtemp(prefix="store-copies-", dir=destination.parent.parent))
    deadline = time.monotonic() + STORE_COPY_SECONDS

    def progress(*_):
        if time.monotonic() >= deadline:
            raise JournalDown("store checkpoint copy deadline exceeded")

    for attempt in range(STORE_COPY_ATTEMPTS):
        progress()
        candidate = attempts / f"{attempt + 1:03d}.db"
        candidate.touch(mode=0o600, exist_ok=False)
        out = sqlite3.connect(candidate)
        try:
            connection.backup(out, pages=256, progress=progress, sleep=0.05)
            out.execute("pragma journal_mode=delete")
        finally:
            out.close()
        candidate.chmod(0o600)
        progress()
        try:
            with closing(sqlite3.connect(candidate.resolve().as_uri() + "?mode=ro", uri=True)) as copied:
                position = acknowledged_store_position(copied, backend, exact_head=False)
        except StoreAcknowledgmentsPending:
            if attempt + 1 == STORE_COPY_ATTEMPTS:
                raise
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise JournalDown("store checkpoint copy deadline exceeded") from None
            time.sleep(min(0.1 * 2 ** attempt, 1.0, remaining))
            continue
        os.replace(candidate, destination)
        return position
    raise JournalDown("store checkpoint copy attempts exhausted")


def acknowledged_controller_position(connection, backend, *, position=None):
    """The complete authenticated prefix must reproduce every copied batch."""
    entries = RemoteJournal(backend).entries()
    if position is None:
        position = len(entries)
    if type(position) is not int or not 0 <= position <= len(entries):
        raise JournalDown("controller snapshot exceeds remote history")
    latest = {}
    for entry in entries[:position]:
        if entry.get("kind") == "batch":
            batch = entry.get("batch")
            if not isinstance(batch, dict) or not isinstance(batch.get("bid"), str):
                raise JournalDown("invalid controller batch history")
            latest[batch["bid"]] = batch
    connection.row_factory = __import__("sqlite3").Row
    actual = {}
    for row in connection.execute("select * from batches"):
        batch = dict(row)
        batch["members"] = json.loads(batch["members"])
        actual[batch["bid"]] = batch
    if actual != latest:
        raise JournalDown("controller snapshot differs from exact remote prefix")
    return position


def validate_snapshot_prefixes(directory, manifest, backend):
    import sqlite3
    directory = Path(directory)
    if any(type(manifest.get(key)) is not int or manifest[key] < 0 for key in ("store_journal", "controller_journal")):
        raise JournalDown("invalid snapshot journal prefix")
    with sqlite3.connect((directory / "registry.db").resolve().as_uri() + "?mode=ro", uri=True) as db:
        acknowledged_store_position(db, backend, exact_head=False, position=manifest.get("store_journal"))
    with sqlite3.connect((directory / "controller.db").resolve().as_uri() + "?mode=ro", uri=True) as db:
        acknowledged_controller_position(db, backend, position=manifest.get("controller_journal"))


def sync_snapshot(directory):
    """Finish the owned staging files before publishing their encrypted set."""
    directory = Path(directory)
    paths = list(directory.rglob("*"))
    if any(path.is_symlink() for path in paths):
        raise JournalDown("checkpoint staging symlink refused")
    for path in paths:
        if path.is_file():
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    for path in sorted([directory, *(p for p in paths if p.is_dir())], key=lambda p: len(p.parts), reverse=True):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
