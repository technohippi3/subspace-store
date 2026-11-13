"""Verification/callback boundaries with a recording verifier, not cryptography."""
import hashlib
import json
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from controller.core import Refused
from runner.cli import Runner
from runner.store import Refused as StoreRefused, TypeScriptStore
from tests.test_entry_release import World


class Certificates(unittest.TestCase):
    def world(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        w = World(tmp.name)
        self.addCleanup(lambda: w.c.close())
        w.c._save("b1", members=json.dumps(["o1"]), state="final", mined_height=50, attempted=1, intent=1)
        w.c.watch = lambda bid: "final"
        w.c.root_anchors = lambda: [{"block": {"height": 210}}]
        self.facts = dict(txid="a" * 64, tipHeight=210, tipHash="b" * 64, minedHeight=50, rootHeight=50, anchorHeight=210)
        w.commitment_status = lambda b: dict(revision=1, acknowledged=True, observation=dict(self.facts, phase="final", depth=160, covered=True))
        w.c._commitment_observation = lambda b: dict(self.facts)
        w.get = lambda path, raw=False: b"mock certificate"
        self.calls = []
        w.accept_certificate = lambda *args: self.calls.append(args) or dict(acknowledged=True)
        self.answer = dict(verified=True, zones=[dict(handle="n1@space", script_pubkey=w.order("o1")["recipient_spk"], sovereignty="sovereign"),
                                               dict(handle="@space", commitment_root="a" * 64, commitment_height=50)])
        return w

    def verifier(self):
        return patch("controller.certificates.subprocess.run", return_value=SimpleNamespace(stdout=json.dumps(self.answer), stderr="", returncode=0))

    def test_A36_verified_bytes_and_the_current_observation_are_bound_before_the_callback(self):
        w = self.world()
        with self.verifier():
            result = w.c.verify_certificates("b1")
        self.assertTrue(result["o1"]["stored"])
        self.assertEqual(self.calls[0][1:], (1, "o1", "a" * 64, 50, b"mock certificate"))
        event = next(e for e in w.journal.entries() if e["kind"] == "certificate_verification")
        self.assertEqual(event["digest"], hashlib.sha256(b"mock certificate").hexdigest())
        self.assertNotIn("message", event)

    def test_A37_journal_outage_changed_chain_and_unconfirmed_callback_withhold_delivery(self):
        w = self.world()
        with self.verifier():
            w.journal.set_down(True)
            with self.assertRaisesRegex(Refused, "preparation journal unavailable"):
                w.c.verify_certificates("b1")
            self.assertEqual(self.calls, [])
            w.journal.set_down(False)
            original = dict(self.facts)
            w.c._commitment_observation = lambda b: dict(original, tipHash="c" * 64)
            with self.assertRaisesRegex(Refused, "chain changed"):
                w.c.verify_certificates("b1")
            self.assertEqual(self.calls, [])
            w.c._commitment_observation = lambda b: original
            w.accept_certificate = lambda *args: dict(acknowledged=False)
            with self.assertRaisesRegex(Refused, "not acknowledged"):
                w.c.verify_certificates("b1")

    def test_A38_certificate_client_rejects_mismatched_hash_length_revision_and_binding_without_fallback(self):
        store = TypeScriptStore("http://127.0.0.1:9", "mock-token", "mock-db", "mock-journal")
        batch = dict(entry_key="1" * 32, root="a" * 64, members=["o1"], delegate_in="d" * 64 + ":0")
        message = b"mock certificate"
        good = dict(oid="o1", entry=batch["entry_key"], revision=1, certificateRoot=batch["root"], certificateHeight=50,
                    hash=hashlib.sha256(message).hexdigest(), length=len(message), acknowledged=True)
        for change in (dict(hash="b" * 64), dict(length=99), dict(revision=True), dict(entry="2" * 32), dict(acknowledged=1)):
            calls = []
            store.op = lambda method, path, body: calls.append(path) or dict(good, **change)
            with self.assertRaises(StoreRefused):
                store.accept_certificate(batch, 1, "o1", batch["root"], 50, message)
            self.assertEqual(calls, ["/operator/certificates"])

    def test_A39_attended_certify_does_not_repeat_an_anonymous_delivery_after_a_bound_callback(self):
        w = self.world()
        w.post = lambda *args: {}
        w.deliver_certificate = lambda *args: self.fail("anonymous delivery")
        w.c.verify_certificates = lambda bid: {"o1": dict(handle="n1@space", ok=True, checks={}, stored=True)}
        result = Runner(w, w.c).certify("b1")
        self.assertTrue(result["members"]["o1"]["delivered"])
