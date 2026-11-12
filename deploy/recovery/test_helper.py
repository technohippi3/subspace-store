"""Actual helper process tests; no host services or remote credentials."""
import base64
import fcntl
import hashlib
import json
import os
import stat
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import helper
import storage

HERE = Path(__file__).resolve().parent


def sha(data):
    return hashlib.sha256(data).hexdigest()


class HelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "offhost"
        self.root.mkdir(mode=0o700)
        self.command = [sys.executable, str(HERE / "helper.py"), "--root",
                        str(self.root), "--installation", "fixture-installation"]

    def tearDown(self):
        self.temp.cleanup()

    def request(self, operation, *, accepted=True, **values):
        request = {"version": 1, "op": operation, **values}
        proc = subprocess.run(self.command, input=json.dumps(request).encode(),
                              capture_output=True, timeout=30)
        self.assertEqual(proc.returncode, 0 if accepted else 2, proc.stdout)
        self.assertEqual(proc.stderr, b"")
        result = json.loads(proc.stdout)
        self.assertEqual(result["ok"], accepted)
        return result

    def append(self, sequence, data=b'{"entry":"fixture"}', stream="store", **options):
        return self.request("journal-append", stream=stream, sequence=sequence,
                            sha256=sha(data), data=base64.b64encode(data).decode(), **options)

    def upload(self, data):
        return self.request("blob-put", sha256=sha(data),
                            data=base64.b64encode(data).decode())

    def manifest(self):
        self.append(1)
        self.append(1, stream="controller")
        files = {}
        for path, data in {"registry.db": b"store database", "controller.db": b"controller database",
                           "manifest.json": b"{}", "subs/state": b"native state"}.items():
            self.upload(data)
            files[path] = {"size": len(data), "sha256": sha(data), "chunks": [sha(data)]}
        return {"format": 1, "kind": "checkpoint", "authentication": "fixture-authentication", "installation": "fixture-installation", "snapshot": "001-checkpoint",
                "journals": {s: {"sequence": 1, "sha256": sha(b'{"entry":"fixture"}')}
                             for s in ("store", "controller")}, "files": files}

    def test_both_journals_acknowledge_exact_retries_and_page(self):
        for stream in ("store", "controller"):
            self.append(1, stream=stream)
            self.append(1, stream=stream)
            self.append(2, b"second", stream=stream)
            result = self.request("journal-read", stream=stream, after=0, limit=1)
            self.assertEqual(result["head"], 2)
            self.assertEqual(base64.b64decode(result["entries"][0]["data"]), b'{"entry":"fixture"}')
            self.assertEqual(self.request("journal-head", stream=stream)["sha256"], sha(b"second"))
            self.assertEqual(len(list((self.root / stream).glob("*.json"))), 2)

    def test_conflict_gap_and_digest_failure_preserve_bytes(self):
        self.append(1, b"original")
        self.assertEqual(self.append(1, b"replacement", accepted=False)["code"], "immutable-conflict")
        self.assertEqual(self.append(3, accepted=False)["code"], "journal-gap")
        self.request("journal-append", stream="store", sequence=2, sha256="0" * 64,
                     data=base64.b64encode(b"payload").decode(), accepted=False)
        self.assertEqual((self.root / "store" / storage.filename(1)).read_bytes(), b"original")
        self.assertFalse((self.root / "store" / storage.filename(2)).exists())

    def test_truncated_or_duplicate_request_fails_without_payload_output(self):
        for data in (b'{"version":1,"op":"probe",',
                     b'{"version":1,"op":"probe","op":"secret-payload"}',
                     b"x" * (storage.MAX_REQUEST + 1)):
            proc = subprocess.run(self.command, input=data, capture_output=True, timeout=5)
            self.assertEqual(proc.returncode, 2)
            self.assertEqual(proc.stderr, b"")
            self.assertNotIn(b"secret-payload", proc.stdout)
            self.assertLess(len(proc.stdout), 100)

    def test_payload_and_pagination_are_bounded(self):
        self.append(1, b"x" * storage.MAX_OBJECT)
        self.append(2, b"x" * (storage.MAX_OBJECT + 1), accepted=False)
        self.request("journal-read", stream="store", after=0, limit=8193, accepted=False)
        self.request("journal-read", stream="store", after=True, limit=1, accepted=False)

    def test_root_stream_file_blob_and_lock_symlinks_refuse(self):
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (outside / "sentinel").write_bytes(b"must survive")
        (self.root / "store").symlink_to(outside, target_is_directory=True)
        self.append(1, accepted=False)
        (self.root / "store").unlink()
        self.append(1)
        target = self.root / "store" / storage.filename(1)
        target.unlink()
        target.symlink_to(outside / "sentinel")
        self.request("journal-read", stream="store", after=0, limit=1, accepted=False)
        (self.root / "blobs").symlink_to(outside, target_is_directory=True)
        self.request("blob-get", sha256="0" * 64, accepted=False)
        (self.root / ".protocol.lock").unlink()
        (self.root / ".protocol.lock").symlink_to(outside / "sentinel")
        self.request("probe", accepted=False)
        self.assertEqual((outside / "sentinel").read_bytes(), b"must survive")
        self.assertEqual(sorted(p.name for p in outside.iterdir()), ["sentinel"])
        root_link = Path(self.temp.name) / "root-link"
        root_link.symlink_to(self.root, target_is_directory=True)
        self.command[self.command.index("--root") + 1] = str(root_link)
        self.request("probe", accepted=False)

    def test_hardlink_fifo_and_corrupt_sequence_refuse_without_hanging(self):
        self.append(1)
        target = self.root / "store" / storage.filename(1)
        os.link(target, self.root / "extra-link")
        self.request("journal-head", stream="store", accepted=False)
        (self.root / "extra-link").unlink()
        target.unlink()
        os.mkfifo(target)
        self.request("journal-head", stream="store", accepted=False)
        target.unlink()
        (self.root / "store" / storage.filename(2)).write_bytes(b"gap")
        self.request("journal-read", stream="store", after=0, limit=1, accepted=False)

    def test_competing_helper_refuses_while_owner_holds_lock(self):
        self.request("probe")
        with (self.root / ".protocol.lock").open("rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            began = time.monotonic()
            self.assertEqual(self.append(1, accepted=False)["code"], "storage-busy")
            self.assertGreaterEqual(time.monotonic() - began, 1.9)
            self.assertLess(time.monotonic() - began, 5)
            self.assertFalse((self.root / "store").exists())
        self.append(1)

    def test_transient_contention_serializes_both_streams_before_publication(self):
        self.request("probe")
        with (self.root / ".protocol.lock").open("rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            children = []
            try:
                for stream in ("store", "controller"):
                    data = ("original-" + stream).encode()
                    request = {"version": 1, "op": "journal-append", "stream": stream,
                               "sequence": 1, "sha256": sha(data),
                               "data": base64.b64encode(data).decode()}
                    process = subprocess.Popen(self.command, stdin=subprocess.PIPE,
                                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    process.stdin.write(json.dumps(request).encode())
                    process.stdin.close()
                    process.stdin = None
                    children.append((process, stream, data))
                time.sleep(0.3)
                for process, stream, _ in children:
                    self.assertIsNone(process.poll(), stream)
                    self.assertFalse((self.root / stream).exists())
                fcntl.flock(lock, fcntl.LOCK_UN)
                for process, stream, data in children:
                    output, errors = process.communicate(timeout=5)
                    self.assertEqual(process.returncode, 0, output)
                    self.assertEqual(errors, b"")
                    self.assertTrue(json.loads(output)["ok"])
                    self.assertEqual((self.root / stream / storage.filename(1)).read_bytes(), data)
            finally:
                for process, _, _ in children:
                    if process.poll() is None:
                        process.kill()
                    process.communicate()

    def test_no_delete_overwrite_or_arbitrary_path_operation(self):
        self.append(1)
        for operation in ("delete", "journal-delete", "snapshot-delete", "shell"):
            self.request(operation, accepted=False)
        for stream in ("../outside", "/tmp/outside", "store/../../outside"):
            self.append(2, stream=stream, accepted=False)
        self.assertEqual((self.root / "store" / storage.filename(1)).read_bytes(), b'{"entry":"fixture"}')

    def test_snapshot_publishes_after_complete_digest_and_journal_validation(self):
        manifest = self.manifest()
        result = self.request("snapshot-commit", snapshot="001-checkpoint", manifest=manifest)
        again = self.request("snapshot-commit", snapshot="001-checkpoint", manifest=manifest)
        self.assertEqual(result, again)
        self.assertEqual(self.request("snapshot-get", snapshot="001-checkpoint"), result)
        self.assertEqual(self.request("snapshot-list")["snapshots"], ["001-checkpoint"])
        self.assertEqual(result["sha256"], sha(helper.encoded(manifest)))

    def test_incomplete_unsafe_changed_or_foreign_snapshot_never_publishes(self):
        for mutation in ("missing", "digest", "path", "journal", "identity"):
            manifest = self.manifest()
            if mutation == "missing":
                manifest["files"]["subs/state"]["chunks"] = ["0" * 64]
            if mutation == "digest":
                manifest["files"]["subs/state"]["sha256"] = "0" * 64
            if mutation == "path":
                manifest["files"]["subs/../escape"] = manifest["files"].pop("subs/state")
            if mutation == "journal":
                manifest["journals"]["store"]["sha256"] = "0" * 64
            if mutation == "identity":
                manifest["installation"] = "foreign"
            self.request("snapshot-commit", snapshot="001-checkpoint", manifest=manifest, accepted=False)
            self.assertEqual(self.request("snapshot-list")["snapshots"], [])

    def test_snapshot_bytes_are_immutable_and_multichunk_files_verify(self):
        manifest = self.manifest()
        data = b"x" * storage.MAX_OBJECT + b"tail"
        for chunk in (data[:storage.MAX_OBJECT], data[storage.MAX_OBJECT:]):
            self.upload(chunk)
        manifest["files"]["subs/large"] = {"size": len(data), "sha256": sha(data),
                                           "chunks": [sha(data[:storage.MAX_OBJECT]), sha(b"tail")]}
        self.request("snapshot-commit", snapshot="001-checkpoint", manifest=manifest)
        manifest["files"].pop("subs/large")
        self.request("snapshot-commit", snapshot="001-checkpoint", manifest=manifest, accepted=False)

    def test_installation_binding_rejects_reusing_the_directory(self):
        self.request("probe")
        self.command[-1] = "another-installation"
        self.request("probe", accepted=False)

    def test_shared_root_or_object_permissions_refuse(self):
        self.root.chmod(0o755)
        self.request("probe", accepted=False)
        self.root.chmod(0o700)
        self.append(1)
        (self.root / "store" / storage.filename(1)).chmod(0o640)
        self.request("journal-head", stream="store", accepted=False)

    def test_fsync_failure_never_acknowledges_and_retry_proves_durability(self):
        parent = storage.open_root(str(self.root))
        try:
            original = storage.os.fsync
            count = 0

            def fail_directory(fd):
                nonlocal count
                count += 1
                if count == 2:
                    raise OSError("fixture unavailable")
                return original(fd)

            with patch.object(storage.os, "fsync", side_effect=fail_directory):
                with self.assertRaises(OSError):
                    storage.publish(parent, "fixture", b"durable bytes")
            self.assertEqual((self.root / "fixture").read_bytes(), b"durable bytes")
            with patch.object(storage.os, "fsync", wraps=original) as calls:
                storage.publish(parent, "fixture", b"durable bytes")
                self.assertGreaterEqual(calls.call_count, 2)
            self.assertEqual(list(self.root.glob(".pending-*")), [])
        finally:
            os.close(parent)

    def test_read_and_head_recover_post_link_failure_only_after_directory_sync(self):
        parent=storage.open_root(str(self.root))
        try:
            directory=storage.directory(parent,'store');original=storage.os.fsync
            def fail_directory(fd):
                if stat.S_ISDIR(os.fstat(fd).st_mode):raise OSError('fixture directory sync failed')
                return original(fd)
            with patch.object(storage.os,'fsync',side_effect=fail_directory):
                with self.assertRaises(OSError):storage.publish(directory,storage.filename(1),b'linked but unacknowledged')
            os.close(directory)
            for request in ({'version':1,'op':'journal-head','stream':'store'},
                            {'version':1,'op':'journal-read','stream':'store','after':0,'limit':1024}):
                with patch.object(helper.os,'fsync',side_effect=fail_directory):
                    with self.assertRaises(OSError):helper.journal(parent,request)
                with patch.object(helper.os,'fsync',wraps=original) as calls:
                    result=helper.journal(parent,request);self.assertGreaterEqual(calls.call_count,2)
                self.assertEqual(result.get('sequence',result.get('head')),1)
            self.assertEqual((self.root/'store'/storage.filename(1)).read_bytes(),b'linked but unacknowledged')
        finally:os.close(parent)

    def test_8192_count_boundary_retains_bounded_pagination_and_refuses_8193_request(self):
        parent=storage.open_root(str(self.root));directory=storage.directory(parent,'store')
        try:
            for sequence in range(1,8194):
                fd=os.open(storage.filename(sequence),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600,dir_fd=directory)
                try:os.write(fd,b'fixture bytes')
                finally:os.close(fd)
            os.fsync(directory)
        finally:os.close(directory);os.close(parent)
        page=self.request('journal-read',stream='store',after=0,limit=8192)
        self.assertEqual(len(page['entries']),8192);self.assertEqual(page['head'],8193)
        self.assertEqual(len(self.request('journal-read',stream='store',after=8192,limit=8192)['entries']),1)
        self.request('journal-read',stream='store',after=0,limit=8193,accepted=False)

    def test_snapshot_get_and_list_do_not_recover_unsynced_descriptor_without_directory_sync(self):
        manifest=self.manifest();self.request('snapshot-commit',snapshot='001-checkpoint',manifest=manifest)
        parent=storage.open_root(str(self.root));original=helper.os.fsync
        try:
            for operation in ('snapshot-get','snapshot-list'):
                request={'version':1,'op':operation}
                if operation=='snapshot-get':request['snapshot']='001-checkpoint'
                def fail_descriptor_directory(fd):
                    if os.path.samefile('/proc/self/fd/'+str(fd),self.root/'snapshots'):raise OSError('fixture descriptor sync failed')
                    return original(fd)
                with patch.object(helper.os,'fsync',side_effect=fail_descriptor_directory):
                    with self.assertRaises(OSError):helper.snapshot(parent,request,'fixture-installation')
                helper.snapshot(parent,request,'fixture-installation')
        finally:os.close(parent)


if __name__ == "__main__":
    unittest.main()
