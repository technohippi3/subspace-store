"""Shipped controller release boundaries with recording stand-ins, not a chain."""
import copy
import json
import tempfile
import unittest
from pathlib import Path

from controller.core import Clients, Controller, Refused
from controller.journal import Journal, JournalDown
from runner.store import Refused as StoreRefused, TypeScriptStore
from runner.cli import NotConfirmed, Runner


class World:
    def __init__(self, directory):
        self.root = Path(directory)
        self.journal = Journal(self.root / "journal", "controller")
        self.closed = 0
        self.rollbacks = 0
        self.parked = []
        self.failed = set()
        self.lost_rollback = False
        self.bound_entries = True
        self.statuses = {}
        self.chain, self.head, self.pending = None, "a" * 64, True
        self.info = {f"n{i}": dict(script_pubkey="5120" + str(i).rjust(64, "0"), commitment_root="a" * 64, parked=False)
                     for i in (1, 2)}
        self.c = self.open()
        self.c.db.execute("insert into batches(bid,space,members,digest,state,root,entry_key) "
                          "values('b1','@space',?,'mock-digest','checkpointed',?,?)",
                          (json.dumps(["o1", "o2"]), "a" * 64, "1" * 32))
        self.c._journal("b1")

    def open(self):
        result = Controller(self.root / "controller.db", self.journal, self,
                          Clients(lambda: self, lambda: self, lambda: None, lambda: None),
                          None, self.root / "verifier", self.root / "work", "mock-wallet")
        result.onchain_commitment = lambda space: None if self.chain is None else dict(state_root=self.chain)
        return result

    def restart(self):
        self.c.close()
        self.c = self.open()

    def order(self, oid):
        return dict(name=f"n{oid[1:]}@space", recipient_spk="5120" + oid[1:].rjust(64, "0"), status=self.statuses.get(oid, "converted"))

    def observe(self):
        pass

    def supersession_status(self, batch):
        return dict(proof=None, acknowledged=True, conflicted=False)

    def batch_entry_ok(self, oid):
        return oid not in self.failed

    def close_entry(self, batch):
        assert self.c.acknowledged(batch["bid"])["state"] == "releasing"
        self.closed += 1
        return dict(found=True, phase="closed", acknowledged=True)

    def entry_status(self, batch):
        return dict(found=True, phase="closed", acknowledged=True)

    def get(self, path):
        if path.endswith("/pipeline"):
            return dict(root=self.head, txid="d" * 64 if self.chain == self.head and self.head else None,
                        has_pending=self.pending, commitment_idx=0 if self.head else None, staged_count=0,
                        steps={key: "complete" if self.head else "pending" for key in ("local", "proving", "broadcast", "confirmed", "finalized", "published")})
        name = path.rsplit("/", 1)[1]
        value = self.info[name]
        return dict(value, name=name, status="committed" if value["commitment_root"] else "staged",
                    commitment_idx=0 if value["commitment_root"] else None, publish_status=None)

    def post(self, path, body=None):
        if path.endswith("/rollback-local"):
            self.rollbacks += 1
            for info in self.info.values():
                info["commitment_root"] = None
            if self.lost_rollback:
                raise ConnectionError("lost rollback reply")
        elif path.endswith("/park"):
            self.parked.extend(body["handles"])
            for name in body["handles"]:
                self.info[name]["parked"] = body["parked"]
        else:
            raise AssertionError(path)


class EntryRelease(unittest.TestCase):
    def world(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        w = World(tmp.name)
        self.addCleanup(lambda: w.c.close())
        return w

    def test_A27_release_requires_controller_journal_and_exact_local_root_and_scripts(self):
        for fault in ("journal", "script", "foreign-root", "mixed-root", "older-precommit"):
            with self.subTest(fault=fault):
                w = self.world()
                if fault == "journal":
                    w.journal.set_down(True)
                elif fault == "script":
                    w.info["n1"]["script_pubkey"] = "foreign-script"
                elif fault == "older-precommit":
                    w.c._save("b1", journal=False, state="frozen", root=None, entry_key=None)
                else:
                    w.info["n1"]["commitment_root"] = "b" * 64 if fault == "foreign-root" else None
                with self.assertRaises(Refused):
                    w.c.release_unsent("b1", ["o2"])
                self.assertEqual(w.rollbacks, 0)
                self.assertEqual(w.closed, 0 if fault in ("journal", "older-precommit") else 1)
                self.assertEqual(len(w.c.batches()), 1)

    def test_A28_lost_rollback_response_uses_readback_and_never_rolls_back_twice(self):
        w = self.world()
        w.lost_rollback = True
        with self.assertRaises(ConnectionError):
            w.c.release_unsent("b1", ["o2"])
        self.assertEqual(w.c.batch("b1")["state"], "rebuilding")
        w.restart()
        self.assertEqual(w.c.resume("b1"), "b2")
        self.assertEqual(w.rollbacks, 1)
        self.assertEqual(w.c.resume("b1"), "b2")
        self.assertEqual(len(w.c.batches()), 2)
        self.assertEqual(w.c.batch("b2")["members"], ["o1"])
        w.c._save("b2", journal=False, digest="corrupt-digest")
        with self.assertRaisesRegex(Refused, "successor differs"):
            w.c.resume("b1")

    def test_A29_precommit_release_does_not_roll_back_a_previous_root_and_legacy_rollback_still_runs(self):
        w = self.world()
        w.chain = w.head = "a" * 64
        w.pending = False
        w.info["old"] = dict(w.info["n1"])
        w.info["n1"]["commitment_root"] = w.info["n2"]["commitment_root"] = None
        w.c._save("b1", root=None, prior_root="a" * 64, entry_key=None, state="frozen")
        self.assertEqual(w.c.rebuild("b1", ["o2"]), "b2")
        self.assertEqual((w.closed, w.rollbacks), (0, 0))
        self.assertEqual(w.info["old"]["commitment_root"], "a" * 64)
        w.bound_entries = False
        w.c.rollback_local("b2")
        self.assertEqual(w.c.batch("b2")["state"], "rebuilt")
        self.assertEqual(w.rollbacks, 1)
        interrupted = self.world()
        interrupted.c._save("b1", root=None, entry_key=None, state="staged")
        interrupted.journal.append("commit_local_intent", bid="b1", space="@space")
        with self.assertRaisesRegex(Refused, "no confirmed root"):
            interrupted.c.rebuild("b1", ["o2"])
        self.assertEqual((interrupted.closed, interrupted.rollbacks), (0, 0))
        self.assertEqual(len(interrupted.c.batches()), 1)

    def test_A30_failed_set_only_grows_and_an_original_retry_cannot_create_another_successor(self):
        w = self.world()
        w.failed = {"o1"}
        self.assertIsNone(w.c.release_unsent("b1", ["o2"]))
        self.assertEqual(json.loads(w.c.batch("b1")["release_failed"]), ["o1", "o2"])
        self.assertIsNone(w.c.release_unsent("b1", ["o2"]))
        self.assertEqual(w.c.db.execute("select count(*) from alerts where kind='every_member_failed'").fetchone()[0], 1)
        self.assertEqual(len(w.c.batches()), 1)

    def test_A31_release_recovery_merges_failed_members_and_never_downgrades_closed_progress(self):
        for state in ("releasing", "rebuilding"):
            with self.subTest(state=state):
                w = self.world()
                w.c._save("b1", state="releasing", release_failed=json.dumps(["o2"]))
                w.c._save("b1", journal=False, state=state, release_failed=json.dumps(["o1"]))
                w.restart()
                self.assertEqual(w.c.batch("b1")["state"], state)
                self.assertEqual(json.loads(w.c.batch("b1")["release_failed"]), ["o1", "o2"])
                self.assertIsNone(w.c.resume("b1"))
                self.assertEqual(w.rollbacks, 1)

    def test_B5_guard_ack_loss_and_intervening_failures_or_reset_never_count_one_parent_twice(self):
        w = self.world()
        w.c.tip = lambda: 10
        append = w.journal.append

        def lose_guard_reply(kind, **data):
            result = append(kind, **data)
            if kind == "rebuild_guard":
                raise JournalDown("simulated lost guard acknowledgment")
            return result

        w.journal.append = lose_guard_reply
        with self.assertRaises(JournalDown):
            w.c._note_failed_rebuild("b1")
        w.journal.append = append
        w.restart()
        w.c.tip = lambda: 10
        w.c._note_failed_rebuild("b2")
        self.assertEqual(w.c._rebuild_policy()["count"], 2)
        before = w.journal.path.read_bytes()
        w.c._note_failed_rebuild("b1")
        self.assertEqual(w.journal.path.read_bytes(), before)
        w.c._reset_rebuild_guard()
        w.restart()
        w.c.tip = lambda: 10
        w.c._note_failed_rebuild("b1")
        self.assertEqual(w.c._rebuild_policy()["count"], 0)
        w.c._note_failed_rebuild("b3")
        self.assertEqual(w.c._rebuild_policy()["count"], 1)
        self.assertEqual([row["last_bid"] for row in w.c._rebuild_guard_rows()].count("b1"), 1)

        # Previously inflated history remains evidence; this repair does not
        # rewrite counts or retroactively remove a recorded pause.
        append("rebuild_guard", version=1, count=3, last_bid="b1", paused_at=10, paused_bid="b1")
        retained = w.journal.path.read_bytes()
        w.c._note_failed_rebuild("b1")
        self.assertEqual(w.journal.path.read_bytes(), retained)
        self.assertTrue(w.c._paused_rebuild("b1"))

    def test_O26_forgotten_entry_identity_cannot_roll_back_foreign_issuance_or_unknown_status(self):
        for rootless, status in ((rootless, status) for rootless in (False, True)
                                 for status in ("issuing", "ready", "fulfilled", "unknown", None)):
            with self.subTest(rootless=rootless, status=status):
                w = self.world()
                # A close of the new absent ID succeeds, but the foreign entry
                # still owns its issuing order, just as the real HTTP store does.
                w.c._save("b1", entry_key=None)
                if rootless:
                    w.c._save("b1", root=None, state="frozen")
                w.statuses["o1"] = status
                with self.assertRaisesRegex(Refused, "foreign issuance|unknown order"):
                    w.c.release_unsent("b1", ["o2"])
                self.assertEqual((w.rollbacks, w.parked), (0, []))
                self.assertEqual(len(w.c.batches()), 1)
                self.assertNotEqual(w.c.batch("b1")["state"], "rebuilt")
                self.assertEqual(w.c.alerts(), [])
                self.assertEqual(w.info["n1"]["commitment_root"], "a" * 64)

    def test_A32_attended_runner_reports_all_failed_issue_and_resumes_release_with_confirmation(self):
        w = self.world()
        runner = Runner(w, w.c)
        w.failed = {"o1", "o2"}
        with self.assertRaises(NotConfirmed):
            runner.issue("b1", confirm="wrong-batch")
        self.assertEqual((w.closed, w.rollbacks), (0, 0))
        result = runner.issue("b1", confirm="b1")
        self.assertEqual((result["bid"], result["state"], result["txid"]), ("b1", "rebuilt", None))
        with self.assertRaises(NotConfirmed):
            runner.resume("b1", confirm="wrong-batch")
        self.assertEqual(runner.resume("b1", confirm="b1"), result)
        self.assertEqual(w.rollbacks, 1)

    def test_A24_arm_response_rejects_impossible_or_mismatched_delegate_and_permission(self):
        payload = dict(entry="1" * 32, root="a" * 64, oids=["o1"], delegate="d" * 64 + ":0")
        good = dict(payload, found=True, phase="armed", acknowledged=True, batchable=True, granted=True)
        for override in (dict(delegate="d" * 64 + ":4294967296"), dict(delegate="d" * 64 + ":00"),
                         dict(phase="closed"), dict(acknowledged=False), dict(granted=1)):
            bad = copy.deepcopy(good)
            bad.update(override)
            with self.assertRaises(StoreRefused):
                TypeScriptStore._entry_response(bad, payload, arm=True)
