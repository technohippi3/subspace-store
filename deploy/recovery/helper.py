#!/usr/bin/env python3
"""One bounded request on stdin, one scrubbed JSON response on stdout.

Install as an SSH forced command with a fixed administrator-owned root and
installation ID. It deliberately implements no shell, delete or overwrite.
"""
import argparse
import base64
import fcntl
import hashlib
import json
import os
import stat
import sys
import time

from storage import (MAX_OBJECT, MAX_REQUEST, MAX_PAGE, SAFE_ID, Refused, decode,
                     digest, directory, entries, exact, filename, integer,
                     open_root, publish, read, require)


def acquire_protocol_lock(lock):
    """Serialize ordinary store/controller overlap within a fixed deadline."""
    deadline = time.monotonic() + 2
    while True:
        require(time.monotonic() < deadline, "storage-busy")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            remaining = deadline - time.monotonic()
            require(remaining > 0, "storage-busy")
            time.sleep(min(0.01, remaining))


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def journal(root, request):
    operation = request["op"]
    require(request.get("stream") in ("store", "controller"))
    parent = directory(root, request["stream"])
    try:
        names = entries(parent)
        if operation == "journal-append":
            exact(request, "version op stream sequence sha256 data")
            sequence = integer(request["sequence"], 1)
            data = decode(request["data"], request["sha256"])
            require(sequence <= len(names) + 1, "journal-gap")
            publish(parent, filename(sequence), data)
            return {"sequence": sequence, "sha256": request["sha256"]}
        if operation == "journal-read":
            exact(request, "version op stream after limit")
            after = integer(request["after"])
            limit = integer(request["limit"], 1, MAX_PAGE)
            require(after <= len(names), "journal-gap")
            result = []
            total = 0
            for name in names[after:after + limit]:
                data = read(parent, name)
                if result and total + len(data) > 8 * MAX_OBJECT:
                    break
                total += len(data)
                result.append({"sequence": int(name[:-5]),
                               "sha256": hashlib.sha256(data).hexdigest(),
                               "data": base64.b64encode(data).decode("ascii")})
            os.fsync(parent)
            return {"entries": result, "head": len(names)}
        exact(request, "version op stream")
        require(operation == "journal-head")
        sha = hashlib.sha256(read(parent, names[-1])).hexdigest() if names else None
        os.fsync(parent)
        return {"sequence": len(names), "sha256": sha}
    finally:
        os.close(parent)


def blob(root, request):
    operation = request["op"]
    exact(request, "version op sha256 data" if operation == "blob-put"
          else "version op sha256")
    sha = digest(request["sha256"])
    parent = directory(root, "blobs")
    try:
        if operation == "blob-put":
            data = decode(request["data"], sha)
            publish(parent, sha, data)
            return {"sha256": sha, "size": len(data)}
        require(operation == "blob-get")
        data = read(parent, sha)
        require(hashlib.sha256(data).hexdigest() == sha, "digest-mismatch")
        os.fsync(parent)
        return {"sha256": sha, "data": base64.b64encode(data).decode("ascii")}
    finally:
        os.close(parent)


def safe_path(path):
    require(isinstance(path, str) and len(path) <= 4096)
    parts = path.split("/")
    require(len(parts) <= 128 and all(SAFE_ID.fullmatch(p) and p not in (".", "..")
                                    for p in parts), "unsafe-path")
    require(path in ("registry.db", "controller.db", "manifest.json",
                     "core-wallet.backup", "spaced-wallet.export") or
            (len(parts) > 1 and parts[0] == "subs"), "unsafe-path")


def validate_manifest(root, manifest, installation, snapshot):
    exact(manifest, "format kind installation snapshot journals files authentication")
    require(isinstance(manifest["authentication"], str) and
            1 <= len(manifest["authentication"]) <= 256)
    require(manifest["format"] == 1 and manifest["installation"] == installation and
            manifest["snapshot"] == snapshot, "snapshot-identity")
    exact(manifest["journals"], "store controller")
    for stream, position in manifest["journals"].items():
        exact(position, "sequence sha256")
        sequence = integer(position["sequence"])
        parent = directory(root, stream)
        try:
            names = entries(parent)
            require(sequence <= len(names), "snapshot-journal-gap")
            expected = hashlib.sha256(read(parent, filename(sequence))).hexdigest() if sequence else None
            require(position["sha256"] == expected, "snapshot-journal-mismatch")
            os.fsync(parent)
        finally:
            os.close(parent)
    files = manifest["files"]
    required = ({"registry.db", "controller.db", "manifest.json"}
                if manifest["kind"] == "checkpoint" else
                {"core-wallet.backup", "spaced-wallet.export", "manifest.json"})
    require(manifest["kind"] in ("checkpoint", "wallet-backups"))
    require(isinstance(files, dict) and 3 <= len(files) <= 4096 and
            required <= set(files))
    parent = directory(root, "blobs")
    total = 0
    try:
        for path, item in files.items():
            safe_path(path)
            exact(item, "size sha256 chunks")
            size = integer(item["size"], 0, 16 * 1024**3)
            total += size
            require(total <= 16 * 1024**3, "snapshot-too-large")
            require(isinstance(item["chunks"], list) and
                    len(item["chunks"]) == (size + MAX_OBJECT - 1) // MAX_OBJECT)
            expected = digest(item["sha256"])
            hasher = hashlib.sha256()
            seen = 0
            for i, sha in enumerate(item["chunks"]):
                data = read(parent, digest(sha))
                require(hashlib.sha256(data).hexdigest() == sha and
                        len(data) == min(MAX_OBJECT, size - seen), "snapshot-blob-mismatch")
                hasher.update(data)
                seen += len(data)
            require(hasher.hexdigest() == expected, "snapshot-file-mismatch")
        os.fsync(parent)
    finally:
        os.close(parent)


def snapshot(root, request, installation):
    operation = request["op"]
    if operation == "snapshot-list":
        exact(request, "version op")
        parent = directory(root, "snapshots")
        try:
            names = []
            with os.scandir(parent) as objects:
                for item in objects:
                    if item.name.startswith(".pending-"):
                        continue
                    require(len(names) < 4096 and item.name.endswith(".json") and
                            SAFE_ID.fullmatch(item.name[:-5]) and
                            item.is_file(follow_symlinks=False), "unsafe-object")
                    names.append(item.name[:-5])
            os.fsync(parent)
            return {"snapshots": sorted(names)}
        finally:
            os.close(parent)
    exact(request, "version op snapshot manifest" if operation == "snapshot-commit"
          else "version op snapshot")
    name = request["snapshot"]
    require(isinstance(name, str) and SAFE_ID.fullmatch(name) and name not in (".", ".."))
    parent = directory(root, "snapshots")
    try:
        if operation == "snapshot-commit":
            data = encoded(request["manifest"])
            require(len(data) <= MAX_OBJECT, "oversize-object")
            validate_manifest(root, request["manifest"], installation, name)
            publish(parent, name + ".json", data)
        else:
            require(operation == "snapshot-get")
            data = read(parent, name + ".json")
            validate_manifest(root, json.loads(data, object_pairs_hook=unique), installation, name)
            os.fsync(parent)
        return {"sha256": hashlib.sha256(data).hexdigest(),
                "manifest": json.loads(data, object_pairs_hook=unique)}
    finally:
        os.close(parent)


def dispatch(root, request, installation):
    require(isinstance(request, dict) and request.get("version") == 1 and
            isinstance(request.get("op"), str))
    operation = request["op"]
    if operation in ("journal-append", "journal-read", "journal-head"):
        return journal(root, request)
    if operation in ("blob-put", "blob-get"):
        return blob(root, request)
    if operation in ("snapshot-commit", "snapshot-get", "snapshot-list"):
        return snapshot(root, request, installation)
    exact(request, "version op")
    require(operation == "probe")
    boot = open("/proc/sys/kernel/random/boot_id", encoding="ascii").read().strip()
    return {"installation": installation, "protocol": 1,
            "bootIdSha256": hashlib.sha256(boot.encode()).hexdigest()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--installation", required=True)
    args = parser.parse_args()
    root = None
    lock = None
    try:
        require(SAFE_ID.fullmatch(args.installation))
        data = sys.stdin.buffer.read(MAX_REQUEST + 1)
        require(len(data) <= MAX_REQUEST, "oversize-request")
        request = json.loads(data, object_pairs_hook=unique)
        root = open_root(args.root)
        lock = os.open(".protocol.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW |
                       os.O_CLOEXEC | os.O_NONBLOCK, 0o600, dir_fd=root)
        info = os.fstat(lock)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0, "unsafe-object")
        acquire_protocol_lock(lock)
        publish(root, ".installation", (args.installation + "\n").encode("ascii"))
        response = {"ok": True, "installation": args.installation,
                    **dispatch(root, request, args.installation)}
        print(json.dumps(response, sort_keys=True, separators=(",", ":")))
        return 0
    except (Exception, RecursionError) as error:
        code = (error.code if isinstance(error, Refused) else
                "not-found" if isinstance(error, FileNotFoundError) else
                "storage-unavailable")
        print(json.dumps({"ok": False, "code": code}))
        return 2
    finally:
        if lock is not None:
            os.close(lock)
        if root is not None:
            os.close(root)


if __name__ == "__main__":
    sys.exit(main())
