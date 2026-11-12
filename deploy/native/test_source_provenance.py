"""Small local Git fixtures for native source and payload provenance guards."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from common import Refused
from release import safe_path
from source_provenance import EXTRA_INPUTS, REQUIRED, copied_path, snapshot, validate_payload


class SourceProvenanceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="subspace-source-provenance-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                           GIT_AUTHOR_NAME="subspace_store_coordinator",
                           GIT_AUTHOR_EMAIL="subspace-store-coordinator@localhost",
                           GIT_COMMITTER_NAME="subspace_store_coordinator",
                           GIT_COMMITTER_EMAIL="subspace-store-coordinator@localhost")
        environment_patch = patch.dict(os.environ, environment, clear=True)
        environment_patch.start()
        self.addCleanup(environment_patch.stop)
        self.repository = self.root / "repository"
        self.repository.mkdir()
        files = {"ts/package.json": "{}\n", "ts/package-lock.json": "{}\n",
                 "ts/src/main.ts": "export const fixture = true;\n",
                 "controller/application.py": "# controller fixture\n",
                 "runner/application.py": "# runner fixture\n",
                 "service/application.py": "# service fixture\n",
                 "deploy/native/application.py": "# native fixture\n",
                 "deploy/client/application.py": "# client fixture\n",
                 "deploy/recovery/application.py": "# recovery fixture\n"}
        for relative in EXTRA_INPUTS:
            files.setdefault(relative, "# tracked build input fixture\n")
        for relative, content in files.items():
            self.write(self.repository / relative, content)
        self.git("init", "--template=", "-q")
        self.git("add", ".")
        self.git("-c", "core.hooksPath=" + os.devnull, "-c", "commit.gpgsign=false",
                 "commit", "-qm", "Record source provenance fixture")

    def path(self, path):
        path = Path(path)
        self.assertTrue(path.parent.resolve().is_relative_to(self.root))
        self.assertTrue(path.resolve(strict=False).is_relative_to(self.root))
        return path

    def write(self, path, content):
        path = self.path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path(path).write_text(content)
        path.chmod(0o644)

    def write_json(self, path, value):
        self.write(path, json.dumps(value) + "\n")

    def git(self, *arguments):
        return subprocess.run(["git", "-C", str(self.repository), *arguments],
                              check=True, capture_output=True, timeout=10).stdout

    def payload(self, proof):
        destination = self.root / "payload"
        destination.mkdir()
        for relative in proof["repositoryInputs"]:
            target = copied_path(relative)
            if target is not None:
                output = self.path(destination / target)
                output.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(self.repository / relative, self.path(output))
        self.write_json(destination / "source-provenance.json", proof)
        self.write_json(destination / "native-artifacts.json",
                        {"version": 1, "artifacts": {name: {} for name in REQUIRED}})
        return destination

    def assert_refused(self, code, function, *arguments):
        with self.assertRaises(Refused) as raised:
            function(*arguments)
        self.assertEqual(raised.exception.code, code)

    def test_clean_snapshot_and_copied_payload_validate(self):
        proof = snapshot(self.repository)
        self.assertEqual(proof["sourceCommit"], self.git("rev-parse", "HEAD").decode().strip())
        expected = hashlib.sha256((self.repository / "ts/src/main.ts").read_bytes()).hexdigest()
        self.assertEqual(proof["repositoryInputs"]["ts/src/main.ts"], expected)
        self.assertEqual(proof["payloadInputs"]["app/ts/src/main.ts"], expected)
        self.assertIn("native/application.py", proof["payloadInputs"])
        self.assertTrue(all(not Path(path).is_absolute() for path in proof["repositoryInputs"]))
        self.assertIsNone(validate_payload(self.payload(proof), proof["sourceCommit"], safe_path))

    def test_dirty_or_ignored_untracked_copied_source_refuses(self):
        source = self.repository / "ts/src/main.ts"
        original = source.read_text()
        self.write(source, original + "// changed fixture\n")
        self.assert_refused("clean-source-commit-required", snapshot, self.repository)
        self.write(source, original)
        self.write(self.repository / ".git/info/exclude", "ignored-source.py\n")
        self.write(self.repository / "deploy/native/ignored-source.py", "# ignored fixture\n")
        self.assertEqual(self.git("status", "--porcelain=v1", "--untracked-files=all"), b"")
        self.assert_refused("untracked-copied-source-input", snapshot, self.repository)

    def test_changed_payload_or_wrong_source_commit_refuses(self):
        proof = snapshot(self.repository)
        destination = self.payload(proof)
        self.assert_refused("native-source-provenance-required", validate_payload,
                            destination, "0" * 40, safe_path)
        self.write(destination / "app/ts/src/main.ts", "export const fixture = false;\n")
        self.assert_refused("native-source-file-differs", validate_payload,
                            destination, proof["sourceCommit"], safe_path)

    def test_present_incomplete_or_extra_inventory_cannot_use_generic_path(self):
        generic = self.root / "generic"
        generic.mkdir()
        self.write(generic / "application.txt", "generic archive fixture\n")
        self.assertIsNone(validate_payload(generic, "0" * 40, safe_path))
        for variant in ("missing", "extra"):
            with self.subTest(inventory=variant):
                artifacts = {name: {} for name in REQUIRED}
                if variant == "missing":
                    del artifacts[sorted(REQUIRED)[0]]
                else:
                    artifacts["unexpected"] = {}
                self.write_json(generic / "native-artifacts.json", {"version": 1, "artifacts": artifacts})
                self.assert_refused("complete-native-profile-required", validate_payload,
                                    generic, "0" * 40, safe_path)


if __name__ == "__main__":
    unittest.main()
