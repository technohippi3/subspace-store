"""Controller observation and receipt boundaries with recording stand-ins."""
import copy
import tempfile
import unittest

from controller.core import Refused
from controller.journal import JournalDown
from runner.commitments import receipt
from runner.store import Refused as StoreRefused, TypeScriptStore
from tests.test_entry_release import World


class CommitmentTracking(unittest.TestCase):
    def world(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        w = World(tmp.name)
        self.addCleanup(lambda: w.c.close())
        w.c._save("b1", state="broadcast", attempted=1, intent=1, txid="c" * 64, delegate_in="d" * 64 + ":0")
        w.c.wait_synced = lambda: None
        w.c.capture_bytes = lambda bid: None
        self.facts = dict(txid="c" * 64, tipHeight=200, tipHash="e" * 64,
                          minedHeight=50, rootHeight=50, anchorHeight=194)
        w.c._commitment_observation = lambda b: copy.deepcopy(self.facts)
        self.calls = []
        self.revision = 0
        w.commitment_status = lambda b: dict(acknowledged=True, revision=self.revision,
                                             observation=dict(phase="final", covered=True))
        def report(b, previous, facts):
            self.calls.append(facts)
            self.revision += 1
            return dict(acknowledged=True, observation=dict(phase="final" if facts["rootHeight"] is not None else "mined"))
        w.report_commitment = report
        return w

    def test_A33_controller_journal_and_store_acknowledgments_precede_progress_and_retries_reobserve(self):
        w = self.world()
        w.journal.set_down(True)
        with self.assertRaises(JournalDown):
            w.c.watch("b1")
        self.assertEqual(self.calls, [])
        self.assertEqual(w.c.batch("b1")["state"], "broadcast")
        w.journal.set_down(False)
        report = w.report_commitment
        w.report_commitment = lambda *args: dict(report(*args), acknowledged=False)
        with self.assertRaisesRegex(Refused, "observation not acknowledged"):
            w.c.watch("b1")
        self.assertEqual(w.c.batch("b1")["state"], "broadcast")
        w.report_commitment = report
        self.assertEqual(w.c.watch("b1"), "final")
        self.assertEqual(w.c.certificate_status("b1"), "awaiting_certificate_verification")
        self.facts["rootHeight"] = None
        self.assertEqual(w.c.watch("b1"), "mined")
        self.assertEqual(w.c.watch("b1"), "mined")
        self.assertEqual(sum(a["kind"] == "finality_lost" for a in w.c.alerts()), 1)
        self.assertEqual(len(self.calls), 4)
        with self.assertRaisesRegex(Refused, "certificate callbacks"):
            w.c.verify_certificates("b1")

    def test_A34_observation_retries_changed_tips_and_requires_matching_root_height(self):
        w = self.world()
        del w.c._commitment_observation
        w.c.tx_position = lambda txid: (50, 150)
        w.c.onchain_commitment = lambda space, root: dict(state_root=root, block_height=51)
        w.c.root_anchors = lambda: [{"block": {"height": 194}}]
        class Rpc:
            changing = False
            reads = 0
            def call(self, method, *args):
                if method == "getserverinfo":
                    return {"tip": {"hash": "e" * 64}}
                self.reads += 1
                return dict(blocks=200, bestblockhash=("f" if self.changing and self.reads % 2 == 0 else "e") * 64)
        rpc = Rpc()
        w.c.clients.btc = lambda: rpc
        w.c.clients.spaced = lambda: rpc
        observed = w.c._commitment_observation(w.c.batch("b1"))
        self.assertIsNone(observed["rootHeight"])
        self.assertEqual(observed["minedHeight"], 50)
        rpc.changing = True
        rpc.reads = 0
        with self.assertRaisesRegex(Refused, "changed during"):
            w.c._commitment_observation(w.c.batch("b1"))
        self.assertEqual(rpc.reads, 6)

    def test_A35_malformed_or_inconsistent_observation_receipts_are_rejected(self):
        self.world()
        payload = dict(entry="1" * 32, root="a" * 64, oids=["o1", "o2"], delegate="d" * 64 + ":0",
                       expectedRevision=0, observation=self.facts)
        good = {k: payload[k] for k in ("entry", "root", "oids", "delegate")}
        good.update(revision=1, acknowledged=True, observation=dict(self.facts, phase="final", depth=150, covered=True))
        self.assertEqual(receipt(good, payload, StoreRefused), good)
        for change in (dict(revision=True), dict(revision=0), dict(acknowledged=1), dict(root="b" * 64),
                       dict(observation=None), dict(observation=dict(good["observation"], phase="mined")),
                       dict(observation=dict(good["observation"], covered=False)),
                       dict(observation=dict(good["observation"], depth=True)),
                       dict(observation=dict(good["observation"], tipHash="bad")),
                       dict(observation=dict(good["observation"], minedHeight=201))):
            with self.assertRaises(StoreRefused):
                receipt(dict(good, **change), payload, StoreRefused)
        typed = TypeScriptStore("http://127.0.0.1:9", "mock-token", "mock-db", "mock-journal")
        typed.op = lambda *args: good
        with self.assertRaisesRegex(StoreRefused, "transaction differs"):
            typed.commitment_status(dict(entry_key=payload["entry"], root=payload["root"], members=payload["oids"],
                                         delegate_in=payload["delegate"], txid="f" * 64))
