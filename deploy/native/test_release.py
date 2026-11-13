import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from common import Refused, public_directory
from release import build, extract, verify, SCHEMAS


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "application.txt").write_text("fixture application")
        self.private, self.public = self.keys("trusted")

    def tearDown(self):
        self.temporary.cleanup()

    def keys(self, name):
        private, public = self.root / (name + ".key"), self.root / (name + ".pub")
        subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(private)], check=True, capture_output=True)
        private.chmod(0o600)
        subprocess.run(["openssl", "pkey", "-in", str(private), "-pubout", "-out", str(public)], check=True, capture_output=True)
        public.chmod(0o644)
        return private, public

    def make(self, output="release"):
        directory = self.root / output
        manifest = build(self.source, directory, "fixture-v1", "1" * 40, self.private, [])
        return directory, manifest

    def validate(self, directory, public=None):
        return verify(directory / "fixture-v1.manifest.json", directory / "fixture-v1.manifest.sig",
                      directory / "fixture-v1.tar.gz", public or self.public)

    def test_signed_archive_extracts_only_verified_exact_bytes(self):
        directory, manifest = self.make()
        verified = self.validate(directory)
        destination = self.root / "installed"
        extract(directory / "fixture-v1.tar.gz", destination, verified)
        self.assertEqual((destination / "application.txt").read_text(), "fixture application")
        self.assertEqual(manifest["schemas"], SCHEMAS)

    def test_corrupt_archive_wrong_signature_and_unknown_signer_refuse(self):
        directory, manifest = self.make()
        artifact = directory / "fixture-v1.tar.gz"
        original = artifact.read_bytes()
        artifact.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
        with self.assertRaisesRegex(Refused, ""):
            self.validate(directory)
        artifact.write_bytes(original)
        _, other = self.keys("unknown")
        with self.assertRaises(Refused):
            self.validate(directory, other)
        file = directory / "fixture-v1.manifest.json"
        file.write_text(file.read_text().replace("fixture-v1", "fixture-v2"))
        with self.assertRaises(Refused):
            self.validate(directory)

    def test_restrictive_umask_preserves_public_release_traversal_and_private_ancestors(self):
        nested = self.source / "native" / "nested"
        nested.mkdir(parents=True)
        (nested / "public.py").write_text("fixture")
        directory, _ = self.make()
        verified = self.validate(directory)
        self.root.chmod(0o700)
        previous = os.umask(0o077)
        try:
            public_directory(self.root / "new" / "releases", parents=True)
            destination = self.root / "new" / "releases" / "installed"
            extract(directory / "fixture-v1.tar.gz", destination, verified)
        finally:
            os.umask(previous)
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        for path in [self.root / "new", destination.parent, destination,
                     destination / "native", destination / "native" / "nested"]:
            self.assertEqual(path.stat().st_mode & 0o777, 0o755)
        self.assertEqual((destination / "native/nested/public.py").stat().st_mode & 0o777, 0o644)
        private = self.root / "private"
        private.mkdir(mode=0o700)
        public_directory(private, exist_ok=True)
        self.assertEqual(private.stat().st_mode & 0o777, 0o700)
        link = self.root / "link"
        link.symlink_to(private)
        with self.assertRaises(Refused):
            public_directory(link, exist_ok=True)

    def test_extraction_rejects_manifest_path_escape_and_incomplete_archive(self):
        directory, _ = self.make()
        manifest = self.validate(directory)
        manifest["files"]["../escape"] = manifest["files"]["application.txt"]
        with self.assertRaises(Refused):
            extract(directory / "fixture-v1.tar.gz", self.root / "incomplete", manifest)
        self.assertFalse((self.root / "escape").exists())

    def test_builder_rejects_symlinks_signing_key_and_private_state_inputs(self):
        (self.source / "outside").symlink_to(self.private)
        with self.assertRaises(Refused):
            self.make()
        (self.source / "outside").unlink()
        (self.source / "wallet.db").write_bytes(b"fixture")
        with self.assertRaises(Refused):
            self.make("another")

    def test_identical_sources_create_identical_artifact_digests(self):
        _, first = self.make("first")
        _, second = self.make("second")
        self.assertEqual(first["artifact"], second["artifact"])


if __name__ == "__main__":
    unittest.main()
