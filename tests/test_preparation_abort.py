"""Completed-owner abort, lost replies and stale database recovery."""
import shutil
import unittest

from controller.errors import Refused
from controller.preparation_history import PreparationBarrier, history
from tests import test_controller_preparation as preparation_fixture


class PreparationAbort(unittest.TestCase):
    world = preparation_fixture.ControllerPreparation.world

    def retain(self):
        w = self.world()
        w.seed("frozen")
        pending = w.set_pending
        def changed(oids):
            result = pending(oids)
            if oids:
                w.failed.add("o2")
                w.statuses["o2"] = "cancelled"
            return result
        w.set_pending = changed
        with self.assertRaisesRegex(Refused, "binding|batchable"):
            w.c.stage("b1")
        return w

    def test_abort_retires_ineligible_completed_owner_and_never_changes_native_handles(self):
        w = self.retain()
        with self.assertRaises(Refused): w.c.release_unsent("b1", ["o2"])
        result = w.c.abort_preparation("b1")
        self.assertEqual(result["state"], "rebuilt")
        self.assertEqual(w.pending_calls, [["o1", "o2"], []])
        self.assertIsNone(history(w.journal)[0])
        self.assertEqual((w.syncs, w.commits, w.rollbacks, w.parked), (0, 0, 0, []))
        self.assertEqual(len(w.c.batches()), 1)
        w.restart()
        self.assertEqual(w.c.abort_preparation("b1")["state"], "rebuilt")
        self.assertEqual(len(w.pending_calls), 2)

    def test_abort_progress_survives_each_journal_boundary_and_old_database(self):
        for boundary in ("preparation_abort", "clear-confirmed", "owner-cleared", "retired"):
            w = self.retain()
            w.c.db.execute("pragma wal_checkpoint(full)")
            shutil.copyfile(w.root / "controller.db", w.root / "older.db")
            append = w.journal.append
            def stop(kind, **data):
                seq = append(kind, **data)
                match = kind == boundary or boundary == "clear-confirmed" and kind == "preparation_effect" and data["phase"] == "confirmed" or \
                    boundary == "owner-cleared" and kind == "preparation_pending" and data["phase"] == "cleared" or \
                    boundary == "retired" and kind == "batch" and data["batch"]["state"] == "rebuilt"
                if match: raise ConnectionError("recording lost journal reply")
                return seq
            w.journal.append = stop
            with self.assertRaises(ConnectionError): w.c.abort_preparation("b1")
            w.journal.append = append
            w.c.close()
            shutil.copyfile(w.root / "older.db", w.root / "controller.db")
            w.c = w.open()
            for call in (lambda: w.c.stage("b1"), lambda: w.c.commit_local("b1"), lambda: w.c.release_unsent("b1", ["o2"])):
                with self.assertRaises(Refused): call()
            self.assertEqual(w.c.abort_preparation("b1")["state"], "rebuilt")
            self.assertEqual(w.pending_calls, [["o1", "o2"], []])

    def test_unanswered_request_including_http_error_cannot_be_aborted_or_retried(self):
        from controller.rpc import HttpError
        for operation in ("pending_set", "sync", "park", "unpark", "pending_clear"):
            w = self.world(); w.seed("frozen")
            barrier = PreparationBarrier(w.journal); b = w.c.batch("b1"); barrier.acquire(b)
            def refused(): raise HttpError("POST", "recording", 503, "recording failure")
            with self.assertRaises(HttpError): barrier.effect(b, operation, [], refused)
            with self.assertRaisesRegex(Refused, "unresolved"): w.c.abort_preparation("b1")
            self.assertEqual(w.pending_calls, [])
            self.assertIsNotNone(history(w.journal)[1])

    def test_lost_abort_clear_response_is_not_repeated_but_completed_false_can_resume(self):
        w = self.retain()
        def lost(oids):
            w.pending_calls.append(list(oids))
            raise ConnectionError("recording lost clear response")
        w.set_pending = lost
        with self.assertRaises(ConnectionError): w.c.abort_preparation("b1")
        with self.assertRaises(Refused): w.c.abort_preparation("b1")
        self.assertEqual(w.pending_calls, [["o1", "o2"], []])
        w = self.retain(); w.pending_ack = False
        with self.assertRaisesRegex(Refused, "not acknowledged"): w.c.abort_preparation("b1")
        self.assertIsNone(history(w.journal)[1])
        w.pending_ack = True
        self.assertEqual(w.c.abort_preparation("b1")["state"], "rebuilt")

    def test_abort_refuses_commit_send_foreign_binding_native_ahead_and_journal_outage(self):
        for fault in ("commit", "send-history", "prior-root-history", "script", "native-head", "journal", "foreign-issuance"):
            w = self.retain()
            if fault == "commit": w.journal.append("commit_local_intent", bid="b1", space="@space")
            elif fault == "send-history":
                w.journal.append("batch", batch=dict(w.c.batch("b1"), attempted=1))
                w.c._journal("b1")
            elif fault == "prior-root-history":
                w.journal.append("batch", batch=dict(w.c.batch("b1"), prior_root="a" * 64))
                w.c._journal("b1")
            elif fault == "script": w.info["n1"]["script_pubkey"] = "5120" + "f" * 64
            elif fault == "native-head": w.head, w.pending = "f" * 64, True
            elif fault == "journal": w.journal.set_down(True)
            elif fault == "foreign-issuance": w.statuses["o1"] = "issuing"
            with self.assertRaises(Exception): w.c.abort_preparation("b1")
            self.assertEqual(w.pending_calls, [["o1", "o2"]])
