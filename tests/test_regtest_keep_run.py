"""`regtest/keep-run.sh` never overwrites or removes kept evidence.

It runs the real script in a temporary copy of the regtest tree, so no
repository evidence is touched. Harness tooling only: neither model nor
regtest evidence about the store.
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "regtest" / "keep-run.sh"


class KeepRun(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.regtest = self.root / "regtest"
        (self.regtest / "runs").mkdir(parents=True)
        (self.regtest / "evidence").mkdir()
        shutil.copy(SCRIPT, self.regtest / "keep-run.sh")

    def run_dir(self, run, label="one", extra=""):
        d = self.regtest / ".run" / run
        (d / "certs" / "001-b1").mkdir(parents=True, exist_ok=True)
        report = {"steps": [{"step": f"recipient request for {label}@test10000",
                             "regtest": {"dir": f"{self.root}/regtest/.run/{run}/offhost" + extra}}]}
        (d / "report.json").write_text(json.dumps(report))
        (d / "report.md").write_text(f"| request | {label}@test10000 |\n")
        (d / "certs" / "001-b1" / f"{label}@test10000.message.bin").write_bytes(b"\x00msg")
        (d / "certs" / "001-b1" / "anchors.json").write_text("[]")
        return d

    def keep(self, run):
        return subprocess.run(["bash", str(self.regtest / "keep-run.sh"), run],
                              capture_output=True, text=True, env=dict(os.environ))

    def kept(self, run):
        files = [self.regtest / "runs" / f"{run}.json", self.regtest / "runs" / f"{run}.md"]
        files += sorted((self.regtest / "evidence" / run).rglob("*"))
        return {str(f.relative_to(self.regtest)): f.read_bytes() for f in files if f.is_file()}

    def test_a_valid_run_is_kept_with_paths_made_relative(self):
        self.run_dir("r1")
        out = self.keep("r1")
        self.assertEqual(out.returncode, 0, out.stderr)
        kept = self.kept("r1")
        self.assertIn("evidence/r1/001-b1/one@test10000.message.bin", kept)
        self.assertNotIn(str(self.root).encode(), kept["runs/r1.json"])

    def test_the_runner_verifications_are_kept_and_checked_too(self):
        d = self.run_dir("r2")
        (d / "runner" / "certs" / "001-b1").mkdir(parents=True)
        (d / "runner" / "certs" / "001-b1" / "two@test10000.message.bin").write_bytes(b"\x00m")
        out = self.keep("r2")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("evidence/r2/runner/001-b1/two@test10000.message.bin", self.kept("r2"))
        # The same checks apply to them: a stray label refuses the whole run.
        d = self.run_dir("r3")
        (d / "runner" / "certs" / "001-b1").mkdir(parents=True)
        (d / "runner" / "certs" / "001-b1" / "stray@test10000.message.bin").write_bytes(b"m")
        self.assertNotEqual(self.keep("r3").returncode, 0)
        self.assertEqual(self.kept("r3"), {})

    def test_an_existing_run_is_never_replaced(self):
        self.run_dir("r1")
        self.assertEqual(self.keep("r1").returncode, 0)
        before = self.kept("r1")
        # The reproduction from review: retry the same id with a bad label.
        self.run_dir("r1", label="zz9")
        out = self.keep("r1")
        self.assertEqual(out.returncode, 3)
        self.assertIn("already kept", out.stderr)
        self.assertEqual(self.kept("r1"), before)
        # A plain retry of a good run is refused too.
        self.run_dir("r1")
        self.assertEqual(self.keep("r1").returncode, 3)
        self.assertEqual(self.kept("r1"), before)

    def test_a_failing_run_publishes_nothing_and_leaves_others(self):
        self.run_dir("good")
        self.assertEqual(self.keep("good").returncode, 0)
        before = self.kept("good")
        for run, kw in (("badlabel", {"label": "zz9"}),
                        ("badpath", {"extra": "/home/somewhere"})):
            with self.subTest(run=run):
                self.run_dir(run, **kw)
                out = self.keep(run)
                self.assertEqual(out.returncode, 1, out.stderr)
                self.assertEqual(self.kept(run), {})
                self.assertFalse((self.regtest / "evidence" / run).exists())
        self.assertEqual(self.kept("good"), before)
        self.assertEqual(list(self.regtest.glob(".keep-run.*")), [])

    def test_a_symbolic_link_is_refused(self):
        d = self.run_dir("linked")
        (d / "certs" / "001-b1" / "link").symlink_to("/etc/hostname")
        self.assertEqual(self.keep("linked").returncode, 1)
        self.assertEqual(self.kept("linked"), {})

    def test_run_ids_cannot_escape(self):
        self.run_dir("r1")
        for run in ("../r1", "a/b", "..", ".hidden", "r1/../r1", "", "r..1"):
            with self.subTest(run=run):
                out = self.keep(run)
                self.assertNotEqual(out.returncode, 0)
        self.assertEqual(sorted(p.name for p in (self.regtest / "runs").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
