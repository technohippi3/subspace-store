"""Bound controller observations with recording RPCs, not chain evidence."""
import copy
import tempfile
import unittest

from controller.errors import Refused
from runner.cli import NotConfirmed, Runner
from runner.store import TypeScriptStore, Refused as ClientRefused
from tests.test_entry_release import World


class Supersession(unittest.TestCase):
    def world(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        w = World(temporary.name); self.addCleanup(lambda: w.c.close())
        w.c._save("b1", state="broadcast", txid="c" * 64, raw="00", attempted=1, intent=1, delegate_in="d" * 64 + ":0")
        w.c.wait_synced = lambda: None; w.c.capture_bytes = lambda bid: None
        self.calls, self.rpc_calls = [], []
        self.status = dict(entry="1" * 32, proof=None, acknowledged=True, conflicted=False)
        w.supersession_status = lambda b: copy.deepcopy(self.status)
        self.report = dict(txid="c" * 64, tipHeight=200, tipHash="e" * 64, minedHeight=None, rootHeight=None, anchorHeight=200)
        self.revision = 0
        w.c._commitment_observation = lambda b: copy.deepcopy(self.report)
        w.commitment_status = lambda b: dict(acknowledged=True, revision=self.revision, observation=dict(self.report, phase="broadcast"))
        def observe(b, revision, facts):
            self.revision += 1
            return dict(acknowledged=True, observation=dict(facts, phase="broadcast"))
        w.report_commitment = observe
        self.conf = 6; self.root = None; self.valid_input = True; self.active = True
        owner = self
        class Rpc:
            def call(self, method, *params):
                owner.rpc_calls.append(method)
                if method == "getblockchaininfo": return dict(blocks=200, bestblockhash="e" * 64)
                if method == "getserverinfo": return dict(tip=dict(hash="e" * 64))
                if method == "decoderawtransaction": return dict(txid="c" * 64, vin=[dict(txid="d" * 64, vout=0)], vout=[dict(scriptPubKey=dict(hex="6a20" + "a" * 64))])
                if method == "getrawtransaction": return dict(txid="f" * 64, blockhash="b" * 64, vin=[dict(txid=("d" if owner.valid_input else "9") * 64, vout=0)])
                if method == "getblockheader": return dict(height=195, confirmations=owner.conf)
                if method == "getblockhash": return ("b" if owner.active else "9") * 64
                raise AssertionError(method)
        rpc = Rpc(); w.c.clients.btc = lambda: rpc; w.c.clients.spaced = lambda: rpc
        w.c.onchain_commitment = lambda *args: self.root
        def accept(b, proof):
            self.assertEqual(w.journal.entries()[-1]["kind"], "supersession_decision")
            self.calls.append(copy.deepcopy(proof))
            self.status["proof"] = dict(version=1, entry=b["entry_key"], active=True, **{k:v for k,v in proof.items() if k != "originalRaw"})
            return copy.deepcopy(self.status)
        w.accept_supersession = accept
        return w

    def test_A47_owner_confirmation_and_settled_exact_conflict_are_required_without_creating_a_transaction(self):
        w = self.world()
        with self.assertRaises(NotConfirmed): Runner(w, w.c).supersede("b1", "f" * 64)
        self.assertEqual(self.calls, [])
        for attribute, value in (("conf",5), ("root",{}), ("valid_input",False), ("active",False)):
            saved = getattr(self,attribute); setattr(self,attribute,value)
            with self.subTest(attribute=attribute), self.assertRaises(Refused): w.c.record_supersession("b1", "f" * 64)
            setattr(self,attribute,saved)
        result = Runner(w,w.c).supersede("b1", "f" * 64, "b1")
        self.assertTrue(result["proof"]["active"]); self.assertEqual(w.c.batch("b1")["state"], "superseded")
        self.assertEqual(len(self.calls),1); self.assertFalse(any("send" in method or "sign" in method for method in self.rpc_calls))

    def test_A48_journal_outage_or_lost_callback_reply_never_advances_controller_without_acknowledged_proof(self):
        w = self.world(); w.journal.set_down(True)
        with self.assertRaisesRegex(Refused,"preparation journal unavailable"): w.c.record_supersession("b1","f" * 64)
        self.assertEqual(self.calls,[]); w.journal.set_down(False)
        original = w.accept_supersession
        def lose(*args): original(*args); raise ConnectionError("lost callback reply")
        w.accept_supersession = lose
        with self.assertRaises(ConnectionError): w.c.record_supersession("b1","f" * 64)
        self.assertEqual(w.c.batch("b1")["state"], "broadcast")
        w.accept_supersession = original
        w.c.record_supersession("b1","f" * 64)
        self.assertEqual(len(self.calls),1); self.assertEqual(w.c.batch("b1")["state"],"superseded")

    def test_A49_reversal_is_journaled_once_and_conflicting_members_refuse_watch_and_rebroadcast(self):
        w = self.world(); w.c.record_supersession("b1","f" * 64)
        self.status["proof"]["active"] = False
        self.assertEqual(w.c.watch("b1"),"broadcast"); self.assertEqual(w.c.watch("b1"),"broadcast")
        self.assertEqual(sum(a["kind"]=="supersession_reversed" for a in w.c.alerts()),1)
        self.status["conflicted"] = True
        w.journal.set_down(True)
        with self.assertRaisesRegex(Refused,"preparation journal unavailable"): w.c.watch("b1")
        w.journal.set_down(False)
        with self.assertRaisesRegex(Refused,"manual recovery"): w.c.watch("b1")
        with self.assertRaisesRegex(Refused,"manual recovery"): w.c.rebroadcast_commitment("b1")
        self.assertEqual(w.c.acknowledged("b1")["state"],"broadcast")

    def test_A50_client_rejects_unbound_or_malformed_proof_receipts_and_never_uses_anonymous_transitions(self):
        w = self.world(); w.c.record_supersession("b1","f" * 64); b=w.c.batch("b1")
        client=TypeScriptStore("http://127.0.0.1:9","mock-token","mock-db","mock-journal")
        calls=[]
        good=copy.deepcopy(self.status)
        client.op=lambda method,path,body: calls.append((path,body)) or good
        self.assertTrue(client.supersession_status(b)["proof"]["active"])
        for key,value in (("revision",True),("txid","9"*64),("height",199),("originalRaw","00")):
            malformed=copy.deepcopy(self.status); malformed["proof"][key]=value
            client.op=lambda *args: malformed
            with self.subTest(key=key), self.assertRaises(ClientRefused): client.supersession_status(b)
        self.assertTrue(all("transition" not in p for p,_ in calls))


if __name__ == "__main__": unittest.main()
