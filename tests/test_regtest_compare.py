"""The regtest harness's comparisons, without the regtest stack.

Each comparison must disagree when any compared field differs, and a
required step that disagrees must fail the run with exit code 1. This tests
harness code only: it is neither model nor regtest evidence about the store.
"""

import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from regtest.harness import compare
from regtest.harness.report import Report

QUOTE_REG = {"quoted": True, "status": "quoted", "price_sats": 10_000, "address": "addr"}
QUOTE_MODEL = {"quoted": True, "status": "quoted", "price": 10_000}
FREEZE_REG = {"members": ["o2", "o1"], "state": "frozen"}
FREEZE_MODEL = {"ok": True, "members": ["o1", "o2"], "state": "frozen"}
COMMIT_REG = {"state": "committed_local", "root": "ab" * 32, "handles": 2, "members_on_root": 2}
COMMIT_MODEL = {"state": "committed_local", "members": ["o1", "o2"]}


class Comparisons(unittest.TestCase):
    def _each_field_matters(self, fn, reg, model, changes):
        self.assertTrue(fn(reg, model))
        for side, key, value in changes:
            with self.subTest(side=side, key=key, value=value):
                r, m = dict(reg), dict(model)
                (r if side == "regtest" else m)[key] = value
                self.assertFalse(fn(r, m))

    def test_quote_compares_outcome_status_and_price(self):
        self._each_field_matters(compare.same_quote, QUOTE_REG, QUOTE_MODEL, [
            ("model", "quoted", False),
            ("regtest", "status", "converted"),
            ("model", "status", None),
            ("regtest", "price_sats", 9_999),
        ])

    def test_freeze_compares_members_and_state(self):
        self._each_field_matters(compare.same_freeze, FREEZE_REG, FREEZE_MODEL, [
            ("model", "ok", False),
            ("regtest", "members", ["o1"]),
            ("model", "members", ["o1", "o3"]),
            ("regtest", "state", "staged"),
        ])

    def test_local_commit_compares_state_handles_and_readback(self):
        self._each_field_matters(compare.same_local_commit, COMMIT_REG, COMMIT_MODEL, [
            ("regtest", "state", "staged"),
            ("model", "state", "frozen"),
            ("regtest", "handles", 1),
            ("regtest", "members_on_root", 1),
            ("regtest", "root", None),
            ("regtest", "root", "ab"),
        ])

    def test_verification_follows_the_model_status(self):
        self.assertTrue(compare.same_verification(True, "verified"))
        self.assertTrue(compare.same_verification(False, "awaiting_anchor"))
        self.assertTrue(compare.same_verification(False, "not_final"))
        self.assertFalse(compare.same_verification(True, "awaiting_anchor"))
        self.assertFalse(compare.same_verification(True, "not_final"))
        self.assertFalse(compare.same_verification(False, "verified"))


class Verdict(unittest.TestCase):
    def _report(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        quiet = contextlib.redirect_stdout(io.StringIO())
        quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)
        return Report(Path(tmp.name) / "report.json")

    def test_a_required_mismatch_fails_the_run(self):
        r = self._report()
        r.step("s", None, "quote", QUOTE_REG, QUOTE_MODEL,
               match=compare.same_quote(QUOTE_REG, QUOTE_MODEL))
        self.assertEqual((r.verdict(), r.exit_code()), ("pass", 0))
        bad = dict(QUOTE_REG, status="converted")
        r.step("s", None, "quote", bad, QUOTE_MODEL, match=compare.same_quote(bad, QUOTE_MODEL))
        self.assertEqual((r.verdict(), r.exit_code()), ("fail", 1))
        self.assertEqual(len(r.failures()), 1)
        self.assertIn("Verdict: fail (1 required steps disagree)", r.markdown())

    def test_an_informational_mismatch_does_not(self):
        r = self._report()
        r.step("s", "L7", "in the mempool", {"in_mempool": False}, {"in_mempool": True},
               match=False, required=False)
        self.assertEqual((r.verdict(), r.exit_code()), ("pass", 0))

    def test_an_unfinished_run_is_an_error(self):
        r = self._report()
        r.meta["error"] = "did not finish"
        self.assertEqual((r.verdict(), r.exit_code()), ("error", 2))


if __name__ == "__main__":
    unittest.main()
