"""Root changes around proving, restart and arming, with recording native facts."""
import json
import tempfile
import unittest

from controller.errors import Refused
from tests.native_facts import local_pipeline
from tests.test_entry_release import World


class NativeBinding(unittest.TestCase):
    def world(self, state):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        w = World(tmp.name)
        self.addCleanup(lambda: w.c.close())
        get = w.get
        w.get = lambda path: local_pipeline(w.head) if path.endswith("/pipeline") else get(path)
        w.c._save("b1", state=state, intent=int(state == "issuing"),
                  delegate_in="d" * 64 + ":0", fee_rate=1)
        w.arms, w.sends = 0, 0
        w.armed = False
        w.entry_status = lambda b: dict(found=True, acknowledged=True, batchable=True,
                                       phase="armed" if w.armed else "open", delegate=b["delegate_in"] if w.armed else None)
        def arm(b):
            w.arms += 1
            w.armed = True
            return dict(granted=True, acknowledged=True)
        w.arm_entry = arm
        def post(path, body, **kwargs):
            self.assertTrue(path.endswith("/broadcast"))
            w.sends += 1
            return json.dumps({"txid": "e" * 64})
        w.post = post
        w.c.capture_bytes = lambda bid: None
        return w

    def test_prove_refuses_an_absent_or_foreign_head_even_when_members_keep_the_batch_root(self):
        for root in (None, "b" * 64):
            w = self.world("committed_local")
            w.head = root
            w.pending = root is not None
            with self.assertRaisesRegex(Refused, "head differs"):
                w.c.prove("b1", timeout=1, poll=0)
            self.assertEqual(w.c.batch("b1")["state"], "committed_local")
            self.assertEqual(w.sends, 0)

    def test_checkpoint_refuses_root_loss_after_restart_and_keeps_proved_state(self):
        w = self.world("proved")
        def snapshot(label):
            w.head, w.pending = None, False
            return {"dir": "recording-snapshot"}
        w.c.snapshot = snapshot
        with self.assertRaisesRegex(Refused, "head differs"):
            w.c.checkpoint("b1")
        self.assertEqual(w.c.batch("b1")["state"], "proved")
        self.assertEqual(w.c.acknowledged("b1")["state"], "proved")

    def test_send_checks_latest_head_scripts_and_members_before_consuming_the_arm(self):
        for fault in ("head", "script", "member-root", "parked", "head-during-members"):
            w = self.world("issuing")
            if fault == "head": w.head = "b" * 64
            elif fault == "script": w.info["n1"]["script_pubkey"] = "5120" + "f" * 64
            elif fault == "member-root": w.info["n1"]["commitment_root"] = None
            elif fault == "parked": w.info["n1"]["parked"] = True
            else:
                get = w.get
                def changing(path):
                    result = get(path)
                    if "/handles/" in path: w.head = "b" * 64
                    return result
                w.get = changing
            with self.assertRaisesRegex(Refused, "native local commitment"):
                w.c._send("b1")
            self.assertEqual((w.arms, w.sends, w.c.batch("b1")["attempted"]), (0, 0, 0))

    def test_root_loss_after_arm_retains_uncertainty_without_a_broadcast_or_second_arm(self):
        w = self.world("issuing")
        arm = w.arm_entry
        def changed(b):
            result = arm(b)
            w.head, w.pending = None, False
            return result
        w.arm_entry = changed
        with self.assertRaisesRegex(Refused, "head differs"):
            w.c._send("b1")
        self.assertEqual(w.c.batch("b1")["state"], "broadcast_uncertain")
        with self.assertRaises(Refused): w.c._send("b1")
        self.assertEqual((w.arms, w.sends), (1, 0))

    def test_matching_native_binding_allows_proving_checkpoint_and_one_send(self):
        w = self.world("committed_local")
        w.c.prove("b1", timeout=1, poll=0)
        self.assertEqual(w.c.batch("b1")["state"], "proved")
        w.c.snapshot = lambda label: {"dir": "recording-snapshot"}
        w.c.checkpoint("b1")
        w.c._save("b1", state="issuing", intent=1)
        w.c._send("b1")
        self.assertEqual((w.arms, w.sends, w.c.batch("b1")["state"]), (1, 1, "broadcast"))
