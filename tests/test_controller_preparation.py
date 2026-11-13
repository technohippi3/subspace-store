"""Actual Python preparation with public recording facts, no chain or lock claims."""
import hashlib
import json
import shutil
from pathlib import Path
import tempfile
import unittest
from controller.errors import Refused
from controller.journal import Journal
from controller.preparation_history import PreparationBarrier, history
from tests.test_entry_release import World


class PreparationWorld(World):
    def __init__(self, directory):
        super().__init__(directory)
        # This preparation fixture starts before any local commitment. Discard
        # the parent release fixture's synthetic checkpointed seed history.
        self.journal.path.write_text("")
        self.chain = self.head = None
        self.pending = False
        self.pending_ack = True
        self.pending_calls, self.commits, self.syncs = [], 0, 0
        self.lose_commit = False
        self.pipeline_change = lambda row: row
        self.pages_change = lambda row: row
        for value in self.info.values():
            value["commitment_root"] = None
        self.seed("staged")

    def seed(self, phase):
        full = sorted((self.order(oid)["name"], self.order(oid)["recipient_spk"], oid) for oid in ("o1", "o2"))
        self.c._save("b1", state=phase, root=None, entry_key=None, digest=hashlib.sha256(json.dumps(full).encode()).hexdigest())

    def set_pending(self, oids):
        self.pending_calls.append(list(oids))
        return self.pending_ack

    def converted_orders(self):
        return [oid for oid in ("o1", "o2") if self.order(oid)["status"] == "converted"]

    def get(self, path):
        if path.endswith("/pipeline"):
            return self.pipeline_change(super().get(path))
        if "/handles?" in path:
            from urllib.parse import parse_qs, urlsplit
            query = parse_qs(urlsplit(path).query)
            rows = [super(PreparationWorld, self).get("/handles/" + name) for name in sorted(self.info)
                    if (self.info[name]["commitment_root"] is None) == (query["filter"][0] == "staged")]
            return self.pages_change(dict(handles=rows, total=len(rows), page=1, per_page=100, total_pages=1 if rows else 0))
        return super().get(path)

    def post(self, path, body=None):
        if path == "/registry/sync":
            self.syncs += 1
            return dict(success=True, pulled=0, staged=0, errors=[])
        if path.endswith("/commit"):
            self.commits += 1
            self.head, self.pending = "c" * 64, True
            members = [value for value in self.info.values() if value["commitment_root"] is None and not value["parked"]]
            for value in members:
                value["commitment_root"] = self.head
            if self.lose_commit:
                raise ConnectionError("recording lost local commitment response")
            return dict(space="@space", prev_root=None, root=self.head, handles_committed=len(members), is_initial=True)
        if path.endswith("/park"):
            super().post(path, body)
            return dict(updated=len(body["handles"]))
        return super().post(path, body)


class ControllerPreparation(unittest.TestCase):
    def world(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        world = PreparationWorld(directory.name)
        self.addCleanup(lambda: world.c.close())
        return world

    def test_finalized_unpublished_prior_pipeline_allows_staging_as_pinned_subs_reports(self):
        w = self.world()
        w.seed("frozen")
        w.chain = w.head = "b" * 64
        w.c._save("b1", prior_root=w.chain)
        w.pipeline_change = lambda row: dict(row, has_pending=False, current_step="published", unpublished=1,
            steps=dict(local="complete", proving="skipped", broadcast="complete", confirmed="complete",
                       finalized="complete", published="in_progress"))
        w.c.stage("b1")
        self.assertEqual(w.c.batch("b1")["state"], "staged")

    def test_pending_false_is_completed_but_unknown_response_keeps_global_owner(self):
        w = self.world()
        w.seed("frozen")
        w.pending_ack = False
        with self.assertRaisesRegex(Refused, "not acknowledged"):
            w.c.stage("b1")
        owner, unresolved, _ = history(w.journal)
        self.assertEqual(owner["bid"], "b1")
        self.assertIsNone(unresolved)
        self.assertEqual(w.syncs, 0)
        w.pending_ack = True
        w.c.stage("b1")
        self.assertIsNone(history(w.journal)[0])
        self.assertEqual(w.c.batch("b1")["state"], "staged")

        ambiguous = self.world()
        ambiguous.seed("frozen")
        barrier = PreparationBarrier(ambiguous.journal)
        barrier.acquire(ambiguous.c.batch("b1"))
        def unknown():
            raise ConnectionError("recording unanswered pending request")
        with self.assertRaises(ConnectionError):
            barrier.effect(ambiguous.c.batch("b1"), "pending_set", [], unknown, pending=True)
        for operation in (lambda: ambiguous.c.stage("b1"), lambda: ambiguous.c.commit_local("b1"),
                          lambda: ambiguous.c.release_unsent("b1", ["o2"]), lambda: ambiguous.c._send("b1")):
            with self.assertRaisesRegex(Refused, "preparation|reconciliation"):
                operation()
        self.assertEqual((ambiguous.commits, ambiguous.rollbacks, ambiguous.parked), (0, 0, []))

    def test_commit_response_loss_and_old_copies_never_repeat_or_retire_unknown_local_root(self):
        w = self.world()
        database, journal = w.root / "controller.db", w.journal.path
        w.c.close()
        shutil.copyfile(database, w.root / "older.db")
        shutil.copyfile(journal, w.root / "older.jsonl")
        w.c = w.open()
        w.lose_commit = True
        with self.assertRaises(ConnectionError):
            w.c.commit_local("b1")
        with self.assertRaisesRegex(Refused, "already requested|ambiguous"):
            w.c.commit_local("b1")
        self.assertEqual(w.commits, 1)
        w.c.close()
        shutil.copyfile(w.root / "older.db", database)
        shutil.copyfile(w.root / "older.jsonl", journal)
        w.journal = Journal(w.root / "journal", "controller")
        w.c = w.open()
        for operation in (lambda: w.c.commit_local("b1"), lambda: w.c.stage("b1"), lambda: w.c.release_unsent("b1", ["o2"])):
            with self.assertRaisesRegex(Refused, "ahead|ambiguous"):
                operation()
        self.assertEqual(w.c.batch("b1")["state"], "staged")
        self.assertEqual((len(w.c.batches()), w.commits, w.rollbacks), (1, 1, 0))

    def test_malformed_null_boolean_and_missing_native_facts_cannot_create_a_first_commit(self):
        for invalid in ({}, False, 0, []):
            w = self.world()
            w.c.onchain_commitment = lambda space, value=invalid: value
            with self.assertRaisesRegex(Refused, "prior root"):
                w.c.commit_local("b1")
            self.assertEqual(w.commits, 0)
        for field in ("root", "txid", "commitment_idx"):
            w = self.world()
            w.pipeline_change = lambda row, field=field: {key: value for key, value in row.items() if key != field}
            with self.assertRaisesRegex(Refused, "pipeline"):
                w.c.commit_local("b1")
            self.assertEqual(w.commits, 0)
        w = self.world()
        w.pages_change = lambda row: dict(row, total_pages=True)
        with self.assertRaisesRegex(Refused, "pagination"):
            w.c.commit_local("b1")
        self.assertEqual(w.commits, 0)

    def test_disappeared_same_invocation_commit_intent_and_retained_send_evidence_refuse_before_effect(self):
        w = self.world()
        append = w.journal.append
        def disappear(kind, **data):
            result = append(kind, **data)
            if kind == "commit_local_intent":
                lines = w.journal.path.read_text().splitlines()
                w.journal.path.write_text("\n".join(lines[:-1]) + "\n")
            return result
        w.journal.append = disappear
        with self.assertRaisesRegex(Refused, "exact live"):
            w.c.commit_local("b1")
        self.assertEqual(w.commits, 0)
        for fields in (dict(ancestors="[]"), dict(recovery_paused=1), dict(raw=""), dict(txid="")):
            candidate = self.world()
            candidate.c._save("b1", **fields)
            with self.assertRaisesRegex(Refused, "ambiguous"):
                candidate.c.commit_local("b1")
            self.assertEqual(candidate.commits, 0)

    def test_down_after_effect_intent_cannot_make_a_pending_request_or_be_retried(self):
        w = self.world()
        w.seed("frozen")
        append = w.journal.append
        def lose_after_intent(kind, **data):
            result = append(kind, **data)
            if kind == "preparation_effect" and data["phase"] == "intent":
                w.journal.set_down(True)
            return result
        w.journal.append = lose_after_intent
        with self.assertRaises(Exception):
            w.c.stage("b1")
        self.assertEqual(w.pending_calls, [])
        w.journal.set_down(False)
        w.journal.append = append
        with self.assertRaisesRegex(Refused, "reconciliation"):
            w.c.stage("b1")
        self.assertEqual(w.pending_calls, [])

    def test_rootless_release_refuses_retained_local_and_historical_send_evidence(self):
        for fields in (dict(txid="d" * 64), dict(raw="00"), dict(ancestors="[]"), dict(attempted=1), dict(state="broadcast")):
            for historical in (False, True):
                w = self.world()
                clean = w.c.batch("b1")
                if historical:
                    w.journal.append("batch", batch=dict(clean, **fields))
                    w.journal.append("batch", batch=clean)
                else:
                    w.c._save("b1", **fields)
                with self.assertRaisesRegex(Refused, "may have escaped|possible send"):
                    w.c.release_unsent("b1", ["o2"])
                self.assertEqual(len(w.c.batches()), 1)
                self.assertNotEqual(w.c.batch("b1")["state"], "rebuilt")
                self.assertEqual(w.rollbacks, 0)
                self.assertEqual(w.commits, 0)
                self.assertEqual(w.pending_calls, [])
