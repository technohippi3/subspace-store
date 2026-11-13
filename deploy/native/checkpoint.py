"""Maintenance-owned offline copy; every writer has exited before entry."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import socket
import urllib.parse
import base64

from common import atomic_json, command, json_file, paths, require, sync_directory
from release import digest_file


def subs_stopped(runner):
    for key in ("url", "write_url"):
        parsed = urllib.parse.urlsplit(runner["subs"].get(key, runner["subs"]["url"]))
        require(parsed.hostname in ("127.0.0.1", "::1") and parsed.port, "local-subs-required")
        try:
            with socket.create_connection((parsed.hostname, parsed.port), timeout=2):
                raise RuntimeError("subs still answers")
        except ConnectionRefusedError:
            continue
        except Exception:
            require(False, "subs-shutdown-not-established")


def recovery(config, release, request):
    settings = json_file(config["recoveryConfig"])
    secrets = json_file(config["secretsConfig"])
    role = Path(secrets["outputRoot"]) / "maintenance"
    settings["identityFile"] = str(role / "recovery-ssh-key")
    settings["encryptionKeyFile"] = str(role / "recovery-key")
    directory = Path(config["runtimeDirectory"])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix="recovery-config-", suffix=".json", dir=directory)
    try:
        with os.fdopen(fd, "w") as file:
            json.dump(settings, file)
        response = json.loads(command([str(Path(release) / "bin/node"), str(Path(release) / "client/client.mjs"), "--config", name],
                                      input=json.dumps(request).encode(), timeout=300,
                                      maximum=24 * 1024 * 1024 if request["op"] == "journal-read" else 4 * 1024 * 1024))
        require(response.get("ok") is True, "recovery-storage-unavailable")
        return response
    finally:
        Path(name).unlink(missing_ok=True)


def copy_file(source, destination):
    require(source.is_file() and not source.is_symlink() and source.stat().st_nlink == 1, "unsafe-checkpoint-source")
    require(source.stat().st_size <= 15 * 1024**3, "checkpoint-too-large")
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        with os.fdopen(fd, "rb", closefd=False) as source_file, destination.open("xb") as target:
            shutil.copyfileobj(source_file, target, 1024 * 1024)
            target.flush()
            os.fsync(target.fileno())
        destination.chmod(0o600)
    finally:
        os.close(fd)


def store_prefix(connection, config, release):
    rows = connection.execute("select seq,payload,acknowledged from outbox order by seq").fetchall()
    require(len(rows) <= 1_000_000 and all(row[0] == i + 1 and row[2] == 1 for i, row in enumerate(rows)), "checkpoint-journal-not-acknowledged")
    after, size = 0, 0
    while True:
        page = recovery(config, release, {"op": "journal-read", "stream": "store", "after": after, "limit": 8192})
        require(page["head"] == len(rows), "checkpoint-journal-prefix-mismatch")
        for item in page["entries"]:
            raw = base64.b64decode(item["data"], validate=True)
            size += len(raw)
            require(after < len(rows) and size <= 512 * 1024 * 1024 and item["sequence"] == after + 1 and
                    hashlib.sha256(raw).hexdigest() == item["sha256"] and raw == rows[after][1].encode(), "checkpoint-journal-bytes-mismatch")
            after += 1
        if after == len(rows):
            return after
        require(page["entries"], "checkpoint-journal-prefix-incomplete")


def controller_record(raw):
    """Bootstrap-owned data reader; never import or execute payload code."""
    framed = raw.startswith('SSCJ3 ')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'checkpoint-controller-protocol-duplicate')
            result[key] = value
        return result
    row = json.loads(raw[6:] if framed else raw, object_pairs_hook=unique if framed else None)
    if framed or isinstance(row, dict) and row.get('kind') == 'controller_protocol':
        require(framed and isinstance(row, dict) and set(row) == {'seq','kind','version','requires'} and
                row['kind'] == 'controller_protocol' and type(row['seq']) is int and row['seq'] >= 1 and
                type(row['version']) is int and row['version'] == 3 and row['requires'] == ['preparation_abort_v1'],
                'checkpoint-controller-protocol-unsupported')
    return row


def controller_prefix(connection, config, release):
    connection.row_factory = sqlite3.Row
    rows = connection.execute('select * from batches').fetchall()
    local = {}
    for row in rows:
        value = dict(row); value['members'] = json.loads(value['members'])
        local[value['bid']] = value
    latest, after, size, head = {}, 0, 0, None
    while True:
        page = recovery(config, release, {'op':'journal-read','stream':'controller','after':after,'limit':8192})
        require(type(page['head']) is int and 0 <= page['head'] <= 1_000_000 and (head is None or page['head'] == head), 'checkpoint-controller-prefix-changed')
        head = page['head']
        require(isinstance(page.get('entries'), list) and len(page['entries']) <= 8192, 'checkpoint-controller-prefix-bounds')
        page_size = 0
        for item in page['entries']:
            raw = base64.b64decode(item['data'], validate=True); size += len(raw)
            page_size += len(raw)
            require(after < head and page_size <= 16 * 1024 * 1024 and size <= 512 * 1024 * 1024 and
                type(item['sequence']) is int and item['sequence'] == after + 1 and
                hashlib.sha256(raw).hexdigest() == item['sha256'], 'checkpoint-controller-journal-bytes-mismatch')
            entry = controller_record(raw.decode('utf-8'))
            require(isinstance(entry, dict) and type(entry.get('seq')) is int and entry['seq'] == after + 1 and
                isinstance(entry.get('kind'), str), 'checkpoint-controller-journal-sequence-mismatch')
            if entry['kind'] == 'batch':
                batch = entry.get('batch'); require(isinstance(batch, dict) and isinstance(batch.get('bid'), str), 'checkpoint-controller-batch-invalid')
                latest[batch['bid']] = batch
            after += 1
        if after == head:
            require(latest == local, 'checkpoint-controller-database-unacknowledged')
            return after
        require(page['entries'] and after < head, 'checkpoint-controller-prefix-incomplete')


def checkpoint(config, release, name):
    runtime, runner = json_file(config["storeConfig"]), json_file(config["runnerConfig"])
    subs_stopped(runner)
    destination = paths(config)["checkpoints"] / name
    destination.mkdir(mode=0o700)
    store = Path(runtime["database"])
    controller = Path(runner["controller"]["dir"]) / "controller.db"
    require(store.is_file() and controller.is_file(), "checkpoint-databases-unavailable")
    positions = {}
    for stream in ("store", "controller"):
        positions[stream] = recovery(config, release, {"op": "journal-head", "stream": stream})["sequence"]
    with sqlite3.connect(store.resolve().as_uri() + "?mode=ro", uri=True) as connection:
        row = connection.execute("select version from store_meta where id=1").fetchone()
        require(row == (1,), "unsupported-store-schema")
        require(store_prefix(connection, config, release) == positions["store"], "checkpoint-journal-prefix-changed")
    with sqlite3.connect(controller.resolve().as_uri() + '?mode=ro', uri=True) as connection:
        require(controller_prefix(connection, config, release) == positions['controller'], 'checkpoint-controller-prefix-changed')
    for source, target in ((store, "registry.db"), (controller, "controller.db")):
        with sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True) as original, sqlite3.connect(destination / target) as saved:
            original.backup(saved)
            saved.execute('pragma journal_mode=delete')
        (destination / target).chmod(0o600)
        with (destination / target).open("rb") as file:
            os.fsync(file.fileno())
    source = Path(runner["subs"]["data_dir"])
    require(source.is_dir() and not source.is_symlink(), "unsafe-checkpoint-source")
    (destination / "subs").mkdir(mode=0o700)
    total = 0
    for path in sorted(source.rglob("*")):
        require(not path.is_symlink(), "unsafe-checkpoint-source")
        target = destination / "subs" / path.relative_to(source)
        if path.is_dir():
            target.mkdir(mode=0o700)
        else:
            total += path.stat().st_size
            require(total <= 15 * 1024**3, "checkpoint-too-large")
            copy_file(path, target)
    files = {p.relative_to(destination).as_posix(): digest_file(p) for p in destination.rglob("*") if p.is_file()}
    atomic_json(destination / "manifest.json", {"label": name, "store_journal": positions["store"],
                 "controller_journal": positions["controller"], "files": files})
    for path in sorted((p for p in destination.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        sync_directory(path)
    sync_directory(destination)
    subs_stopped(runner)
    response = recovery(config, release, {"op": "snapshot-put", "snapshot": name, "kind": "checkpoint", "directory": str(destination)})
    require(response.get("snapshot") == name, "checkpoint-not-acknowledged")
    return {"name": name, "sha256": response["sha256"], "storeJournal": positions["store"], "controllerJournal": positions["controller"]}
