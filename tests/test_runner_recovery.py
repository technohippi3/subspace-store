"""The runner's recovery commands and the controller's reconciliation after
a host loss (CONTROLLER-DESIGN.md, "Restore and reconciliation";
PAYMENT-SPEC.md, "Checkout and the attended runner").

The `test_A*` tests here are the runner cases A11 to A18. They run the
runner and the controller against recording stand-ins for subs, spaced,
bitcoind and the store, so they show what the controller calls, refuses
and records, not what subs or the chain does. They are neither model
results nor regtest evidence; the regtest rehearsal is scenario 11
(`regtest/run-recovery.sh`).
"""

import contextlib
import hashlib
import io
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path

from controller.core import RESTORE_REQUIRED, Capabilities, Clients, Controller, Refused
from controller.journal import Journal
from controller.rpc import HttpError
from runner import cli
from runner.cli import NotConfirmed, Runner

ROOT = Path(__file__).resolve().parents[1]

# The controller's schema at commit 5226810, before `ancestors` and the
# recoveries table.
SCHEMA_5226810 = """
create table if not exists batches (
  bid text primary key, space text not null, members text not null,
  digest text not null, state text not null, prior_root text, root text,
  delegate_in text, fee_rate integer, txid text, mined_height integer,
  intent integer not null default 0, attempted integer not null default 0,
  supersedes text, answer text, raw text, recovery_paused integer not null default 0
);
create table if not exists alerts (n integer primary key, kind text, bid text, detail text);
"""

# A process killed in the middle of the replay, after its second insert and
# before the transaction commits.
KILLED_REPLAY = """
import os, sys
from pathlib import Path
from controller.core import Controller
from controller.journal import Journal
inserted = []
insert = Controller._insert_batch
def die_after_two(self, row):
    insert(self, row)
    inserted.append(row["bid"])
    if len(inserted) == 2:
        os._exit(9)
Controller._insert_batch = die_after_two
tmp = Path(sys.argv[1])
c = Controller(tmp / "controller.db", Journal(tmp / "offhost", "runner"), None, None, None,
               tmp / "verifier", tmp / "certs", "made-up-wallet")
c.restore_from_journal()
"""


class Crash(BaseException):
    """A process stopping at this point: nothing after it runs."""

ROOT_B1 = "aa" * 32
ROOT_B2 = "bb" * 32
ROOT_C = "cc" * 32
ROOT_D = "dd" * 32


class Rpc:
    def __init__(self, answers):
        self.answers = answers
        self.calls = []

    def call(self, method, *params):
        self.calls.append((method, params))
        a = self.answers[method]
        return a(*params) if callable(a) else a


class World:
    """subs, spaced, bitcoind and the store as the controller sees them,
    with made-up identifiers only."""

    def __init__(self, tmp):
        self.tmp = tmp
        self.log = []
        self.posts = []
        self.subs_running = False
        # subs' readback: handle -> commitment_root, per space; and each
        # space's pipeline.
        self.handles = {}
        self.pipelines = {}
        # spaced: each space's on-chain commitment root.
        self.chain = {}
        # bitcoind: txid -> block height (mined) or None (mempool), and the
        # transactions each one spends from.
        self.txs = {}
        self.vins = {}
        self.tip = 500
        self.btc = Rpc({"getrawmempool": lambda: [t for t, h in self.txs.items() if h is None],
                        "getrawtransaction": self.rawtx, "getblockheader": self.header,
                        "getblockcount": lambda: self.tip,
                        "sendrawtransaction": self.send})
        self.spaced = Rpc({"getcommitment": self.commitment,
                           "getdelegation": lambda space: None,
                           "walletlisttransactions": lambda *a: []})
        self.store = Store(self)

    def rawtx(self, txid, verbose=False):
        if txid not in self.txs:
            raise RuntimeError("No such mempool or blockchain transaction")
        if not verbose:
            return "02" + txid
        h = self.txs[txid]
        return {"txid": txid, "hex": "02" + txid, "vout": [],
                "vin": [{"txid": p, "vout": 0} for p in self.vins.get(txid, [])],
                **({"blockhash": f"block-{h}"} if h is not None else {})}

    def header(self, block_hash):
        h = int(block_hash.split("-")[1])
        return {"height": h, "confirmations": self.tip - h + 1}

    def send(self, raw):
        self.log.append(("sendrawtransaction", raw))
        self.txs[raw[2:]] = None
        return raw[2:]

    def commitment(self, space, root=None):
        r = self.chain.get(space)
        if r is None or (root is not None and root != r):
            return None
        return {"state_root": r}

    def subs_client(self):
        world = self

        class Client:
            def get(self, path, **kw):
                if path == "/status":
                    if not world.subs_running:
                        raise urllib.error.URLError(ConnectionRefusedError(111, "refused"))
                    return {"spaces": []}
                if not world.subs_running:
                    raise urllib.error.URLError(ConnectionRefusedError(111, "refused"))
                parts = path.split("/")
                if path.endswith("/pipeline"):
                    return world.pipelines.get(parts[2], {"root": None, "txid": None})
                if "/commit/status" in path:
                    return {"status": "none"}
                if parts[3] == "handles" and len(parts) == 5:
                    root = world.handles.get(parts[2], {}).get(parts[4], "absent")
                    if root == "absent":
                        raise HttpError("GET", path, 404, "not found")
                    return {"name": parts[4], "commitment_root": root}
                raise AssertionError(path)

            def post(self, path, body=None, **kw):
                world.posts.append((path, body))
                world.log.append(("subs", path))
                return {"txid": (body or {}).get("txid")}

        return Client()

    # The subs process control

    @property
    def data_dir(self):
        return self.tmp / "subs"

    def stop(self):
        self.log.append("stop")
        self.subs_running = False

    def start(self):
        self.log.append("start")
        self.subs_running = True


class Store:
    """The store's operator API and its read-only database."""

    def __init__(self, world):
        self.world = world
        self.db = sqlite3.connect(":memory:", check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("create table orders (oid text, status text)")
        self.orders = {}
        self.journal = Journal(world.tmp / "offhost", "store")
        self.startup = {"rebroadcast": [], "at": 1.0}

    def add(self, oid, name, status):
        self.orders[oid] = {"name": name, "status": status, "recipient_spk": "5120" + "ef" * 32}
        self.db.execute("insert into orders values (?, ?)", (oid, status))

    def order(self, oid):
        return dict(self.orders[oid], journaled_status=self.orders[oid]["status"])

    def acknowledged_status(self, oid):
        return self.orders[oid]["status"]

    def restore_issuing(self, oid):
        self.world.log.append(("restore_issuing", oid))
        self.orders[oid]["status"] = "issuing"

    def unissue(self, oid):
        self.world.log.append(("unissue", oid))
        self.orders[oid]["status"] = "converted"

    def unready(self, oid):
        self.orders[oid]["status"] = "issuing"

    def observe(self):
        pass

    def issuing_recheck_ok(self, oid):
        return True

    def journal_ok(self, oid):
        return True

    def status(self):
        return {"startup": self.startup, "chain": {}}


def batch_row(bid, space, members, state, root=None, prior=None, txid=None, raw=None,
              intent=0):
    return {"bid": bid, "space": space, "members": members, "digest": "made-up-digest",
            "state": state, "prior_root": prior, "root": root, "delegate_in": "made-up:0",
            "fee_rate": 1, "txid": txid, "mined_height": None, "intent": intent,
            "attempted": 0, "supersedes": None, "answer": None, "raw": raw,
            "recovery_paused": 0}


class Recovery(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.w = World(self.tmp)
        self.journal = Journal(self.tmp / "offhost", "runner")
        self.snapshots = self.tmp / "offhost" / "snapshots"

    def controller(self, caps=Capabilities(attach_txid=True), name="controller.db"):
        client = self.w.subs_client
        return Controller(self.tmp / name, self.journal, self.w.store,
                          Clients(client, client, lambda: self.w.spaced, lambda: self.w.btc),
                          self.w, self.tmp / "verifier", self.tmp / "certs", "made-up-wallet",
                          caps, snapshot_dir=self.snapshots, ready_timeout=1)

    def runner(self, c, ask=None):
        r = Runner(self.w.store, c, ask=ask)
        r.require_networks = lambda subs=True: self.w.log.append(("networks", subs))
        return r

    def snapshot(self, name="003-b3", files=None):
        d = self.snapshots / name
        (d / "subs").mkdir(parents=True)
        files = files or {"subs.db": b"made-up subs database", "spaces/x.sdb": b"made-up tree"}
        manifest = {"label": name, "files": {}}
        for rel, data in files.items():
            p = d / "subs" / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            manifest["files"]["subs/" + rel] = hashlib.sha256(data).hexdigest()
        (d / "manifest.json").write_text(json.dumps(manifest))
        return d

    def journal_batches(self, *rows):
        for row in rows:
            self.journal.append("batch", batch=row)

    def lost_host(self):
        """The in-flight states of the rehearsal, journaled, and the
        restored store and subs as they are after the loss."""
        st = self.w.store
        for oid, name, status in (("o1", "one@a", "fulfilled"), ("o3", "three@b", "converted"),
                                  ("o4", "four@c", "issuing"), ("o5", "five@a", "issuing"),
                                  ("o6", "six@d", "converted")):
            st.add(oid, name, status)
        self.journal_batches(
            batch_row("b1", "@a", ["o1"], "final", ROOT_B1, txid="made-up-txid-1", raw="02t1"),
            batch_row("b2", "@b", ["o3"], "checkpointed", ROOT_B2),
            batch_row("b3", "@c", ["o4"], "issuing", ROOT_C, intent=1),
            batch_row("b4", "@a", ["o5"], "broadcast", "ee" * 32, prior=ROOT_B1,
                      txid="made-up-txid-4", raw="02made-up-txid-4", intent=1),
            batch_row("b5", "@d", ["o6"], "committed_local", ROOT_D))
        # The snapshot holds b2's, b3's and b4's local commitments, not b5's.
        self.w.handles = {"@a": {"one": ROOT_B1, "five": "ee" * 32}, "@b": {"three": ROOT_B2},
                          "@c": {"four": ROOT_C}, "@d": {}}
        self.w.pipelines = {"@a": {"root": "ee" * 32, "txid": None},
                            "@b": {"root": ROOT_B2, "txid": None},
                            "@c": {"root": ROOT_C, "txid": None},
                            "@d": {"root": None, "txid": None}}
        self.w.chain = {"@a": ROOT_B1}
        self.w.txs = {"made-up-txid-1": 100}

    # A11

    def test_A11_resume_and_rebroadcast_need_the_batch_id_confirmed(self):
        c = self.controller()
        for row in (batch_row("b1", "@a", ["o1"], "issuing", ROOT_B1, intent=1),
                    batch_row("b2", "@a", ["o2"], "broadcast", ROOT_B2, txid="made-up-txid",
                              raw="02made-up-txid", intent=1)):
            cols = ", ".join(k for k in row)
            vals = tuple(json.dumps(v) if k == "members" else v for k, v in row.items())
            c.db.execute(f"insert into batches({cols}) values ({', '.join('?' * len(row))})",
                         vals)
        sent = []
        c.resume = lambda bid: sent.append(("resume", bid)) or bid
        c.rebroadcast_commitment = lambda bid: sent.append(("rebroadcast", bid)) or "made-up-txid"
        for command, bid in (("resume", "b1"), ("rebroadcast", "b2")):
            for given, ask in ((None, None), ("b9", None), (None, lambda p: "b9"), ("", None),
                               (bid.upper(), None)):
                with self.subTest(command=command, given=given, asked=ask is not None):
                    with self.assertRaises(NotConfirmed) as e:
                        getattr(self.runner(c, ask), command)(bid, given)
                    self.assertIn("nothing was sent", str(e.exception))
                    self.assertEqual(sent, [])
        # Only a batch issuing and never sent resumes, and only a batch with a
        # known txid is rebroadcast; both refused before anything is asked.
        c.db.execute("update batches set attempted = 1 where bid = 'b1'")
        asked = []
        with self.assertRaises(NotConfirmed):
            self.runner(c, asked.append).resume("b1", "b1")
        with self.assertRaises(NotConfirmed):
            self.runner(c, asked.append).rebroadcast("b1", "b1")
        self.assertEqual((sent, asked), ([], []))
        c.db.execute("update batches set attempted = 0 where bid = 'b1'")
        self.runner(c).resume("b1", "b1")
        self.runner(c, lambda p: "b2\n").rebroadcast("b2")
        self.assertEqual(sent, [("resume", "b1"), ("rebroadcast", "b2")])

    # A12

    def test_A12_restore_never_overwrites_and_checks_the_snapshot_first(self):
        self.journal_batches(batch_row("b1", "@a", [], "final", ROOT_B1))

        def attempt(prepare):
            for p in (self.tmp / "controller.db", self.tmp / "subs", self.snapshots):
                if p.is_dir():
                    shutil.rmtree(p)
                elif p.exists():
                    p.unlink()
            self.w.log.clear()
            c = self.controller()
            prepare(c)
            state = c.recovery_state()
            before = (sorted(str(p) for p in self.tmp.rglob("*")), c.batches())
            with self.assertRaises(NotConfirmed) as e:
                self.runner(c).restore()
            after = (sorted(str(p) for p in self.tmp.rglob("*")), c.batches())
            self.assertEqual(after, before)
            self.assertNotIn("stop", self.w.log)
            self.assertNotIn("start", self.w.log)
            # Nothing replayed: a restore required stays required.
            self.assertEqual(c.recovery_state(), state)
            return str(e.exception)

        def holds_batches(c):
            self.snapshot()
            c._insert_batch(batch_row("b1", "@a", [], "final", ROOT_B1))
            c.db.execute("delete from recoveries")

        def subs_not_empty(c):
            self.snapshot()
            (self.tmp / "subs").mkdir()
            (self.tmp / "subs" / "subs.db").write_bytes(b"made-up newer state")

        def changed_file(c):
            d = self.snapshot()
            (d / "subs" / "subs.db").write_bytes(b"made-up altered")

        def missing_file(c):
            d = self.snapshot()
            (d / "subs" / "spaces" / "x.sdb").unlink()

        def extra_file(c):
            d = self.snapshot()
            (d / "subs" / "stray.db").write_bytes(b"made-up stray")

        self.assertIn("already holds every journaled batch", attempt(holds_batches))
        self.assertIn("isn't empty", attempt(subs_not_empty))
        self.assertIn("no coordinated snapshot", attempt(lambda c: None))
        for prepare in (changed_file, missing_file, extra_file):
            with self.subTest(prepare.__name__):
                self.assertIn("doesn't match its manifest", attempt(prepare))
        # A journal with no batches: nothing to restore.
        shutil.rmtree(self.tmp / "offhost")
        self.journal = Journal(self.tmp / "offhost", "runner")
        self.assertIn("nothing to restore", attempt(lambda c: self.snapshot()))
        # subs still answering after its stop: nothing copied.
        self.journal_batches(batch_row("b1", "@a", [], "final", ROOT_B1))
        shutil.rmtree(self.snapshots)
        self.snapshot()
        (self.tmp / "controller.db").unlink()
        c = self.controller()
        self.w.subs_running = True
        self.w.stop = lambda: self.w.log.append("stop")
        with self.assertRaises(NotConfirmed) as e:
            self.runner(c).restore()
        self.assertIn("nothing was copied", str(e.exception))
        self.assertFalse((self.tmp / "subs").exists() and any((self.tmp / "subs").iterdir()))

    # A13

    def test_A13_restore_copies_the_latest_snapshot_then_reconciles(self):
        self.lost_host()
        # The latest by sequence number, not by name: 010 after 009.
        self.snapshot("009-b9", {"subs.db": b"made-up older"})
        self.snapshot("010-b10")
        c = self.controller()
        out = self.runner(c).restore()
        # Copied only once subs was stopped and refused connections, and the
        # network check ran before the copy and again with subs running.
        self.assertEqual([x for x in self.w.log if x in ("stop", "start")
                          or (isinstance(x, tuple) and x[0] == "networks")][:4],
                         [("networks", False), "stop", "start", ("networks", True)])
        self.assertEqual((self.tmp / "subs" / "subs.db").read_bytes(), b"made-up subs database")
        self.assertEqual(out["snapshot"], "010-b10")
        states = {b["bid"]: b["state"] for b in c.batches()}
        self.assertEqual(states, {"b1": "final", "b2": "checkpointed",
                                  "b3": "broadcast_uncertain", "b4": "broadcast",
                                  "b5": "rebuilt"})
        # The rebuilt batch is journaled, and its member is still paid.
        self.assertEqual(c.acknowledged("b5")["state"], "rebuilt")
        self.assertEqual(self.w.store.orders["o6"]["status"], "converted")
        # The uncertain one was read back, and nothing was found: nothing
        # was adopted, sent or rolled back.
        self.assertIsNone(c.batch("b3")["txid"])
        self.assertFalse([x for x in self.w.log if x in (("subs", "/spaces/@c/broadcast"),
                                                       ("subs", "/spaces/@c/rollback-local"))])
        self.assertFalse([x for x in self.w.log if x[0] == "sendrawtransaction"])
        self.assertEqual([b for b, v in out["recovery"]["batches"].items()
                          if v["verdict"] == "waiting"], ["b3", "b4"])
        # The next snapshot is numbered after every one already there, by
        # whichever process takes it.
        self.assertTrue(c.snapshot("b6")["dir"].endswith("011-b6"))

    # A14

    def test_A14_issuance_waits_until_the_restore_is_reconciled(self):
        self.lost_host()
        self.snapshot()
        c = self.controller()
        r = self.runner(c)
        out = r.restore()
        sent = []
        c.issue = lambda bid, fee: sent.append(("issue", bid)) or bid
        c.resume = lambda bid: sent.append(("resume", bid)) or bid
        report = out["recovery"]
        self.assertFalse(report["ready"])
        self.assertTrue(any("rebroadcast the journaled bytes" in w for w in report["waiting"]))
        self.assertTrue(any("b3" in w and "uncertain" in w for w in report["waiting"]))
        self.assertTrue(any("@a" in w and "once it is mined" in w for w in report["waiting"]))
        self.assertEqual(report["spaces"]["@b"]["root"],
                         "one local commitment ahead of the chain (b2, checkpointed)")
        self.assertEqual(report["spaces"]["@d"]["root"], "matches the chain")
        with self.assertRaises(NotConfirmed) as e:
            r.issue("b2", 1, "b2")
        self.assertIn("isn't reconciled yet, nothing was sent", str(e.exception))
        self.assertEqual(sent, [])
        # b4's journaled bytes are rebroadcast (the runner allows it while
        # the restore waits), a block mines it and b3's commitment, the
        # readback adopts b3's, and both txids are attached.
        r.rebroadcast("b4", "b4")
        self.assertIn(("sendrawtransaction", "02made-up-txid-4"), self.w.log)
        self.assertFalse(r.recovery()["ready"])
        self.w.txs.update({"made-up-txid-4": 501, "made-up-txid-3": 501})
        self.w.tip = 501
        self.w.chain.update({"@a": "ee" * 32, "@c": ROOT_C})
        c.wallet_spend_with_root = lambda outpoint, root: [
            {"txid": "made-up-txid-3", "root_seen": True}] if root == ROOT_C else []
        self.assertTrue(c.readback("b3")["adopted"])
        waiting = r.recovery()["waiting"]
        self.assertEqual(sorted(waiting), ["@a: attach b4's adopted txid to subs",
                                           "@c: attach b3's adopted txid to subs"])
        with self.assertRaises(NotConfirmed):
            r.issue("b2", 1, "b2")
        for bid, space in (("b4", "@a"), ("b3", "@c")):
            r.attach_txid(bid)
            self.w.pipelines[space]["txid"] = c.batch(bid)["txid"]
        self.assertTrue(r.recovery()["ready"])
        self.assertIsNone(c.restore_pending())
        r.issue("b2", 1, "b2")
        self.assertEqual(sent, [("issue", "b2")])

    def test_A15_a_commitment_s_unconfirmed_ancestors_are_journaled_and_sent_first(self):
        st = self.w.store
        st.add("o5", "five@a", "issuing")
        c = self.controller()
        row = batch_row("b4", "@a", ["o5"], "broadcast", "ee" * 32, txid="made-up-t4",
                        intent=1)
        cols = ", ".join(row)
        c.db.execute(f"insert into batches({cols}) values ({', '.join('?' * len(row))})",
                     tuple(json.dumps(v) if k == "members" else v for k, v in row.items()))
        self.journal_batches(row)
        # t4 spends from t3 (another space's commitment, unconfirmed) and a
        # confirmed t0; t3 spends from t2, unconfirmed too.
        self.w.txs = {"made-up-t0": 400, "made-up-t2": None, "made-up-t3": None,
                      "made-up-t4": None}
        self.w.vins = {"made-up-t4": ["made-up-t3", "made-up-t0"],
                       "made-up-t3": ["made-up-t2"], "made-up-t2": ["made-up-t0"]}
        self.assertTrue(c.capture_bytes("b4"))
        journaled = c.acknowledged("b4")
        self.assertEqual(json.loads(journaled["ancestors"]),
                         [["made-up-t2", "02made-up-t2"], ["made-up-t3", "02made-up-t3"]])
        self.assertEqual(journaled["raw"], "02made-up-t4")

        def sent():
            return [x[1] for x in self.w.log if x[0] == "sendrawtransaction"]
        # A fresh node: nothing of it in its mempool. Parents go first, each
        # as journaled, then the commitment.
        for t in ("made-up-t2", "made-up-t3", "made-up-t4"):
            del self.w.txs[t]
        c.rebroadcast_commitment("b4")
        self.assertEqual(sent(), ["02made-up-t2", "02made-up-t3", "02made-up-t4"])
        # A node that has the first ancestor already: it isn't sent again.
        self.w.log.clear()
        for t in ("made-up-t3", "made-up-t4"):
            del self.w.txs[t]
        c.rebroadcast_commitment("b4")
        self.assertEqual(sent(), ["02made-up-t3", "02made-up-t4"])
        # Ancestors that aren't the journaled ones: refused, nothing sent.
        self.w.log.clear()
        for t in ("made-up-t3", "made-up-t4"):
            del self.w.txs[t]
        c.db.execute("update batches set ancestors = ? where bid = 'b4'",
                     (json.dumps([["made-up-t3", "02made-up-other"]]),))
        with self.assertRaises(Exception) as e:
            c.rebroadcast_commitment("b4")
        self.assertIn("nothing sent", str(e.exception))
        self.assertEqual(sent(), [])

    def run_main(self, c, *argv):
        """The runner's command line over this controller and store."""
        r = self.runner(c)
        path = self.tmp / "runner.json"
        path.write_text(json.dumps({"network": "regtest"}))
        original = cli.build
        cli.build = lambda config, ask=None: r
        try:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = cli.main([str(path), *argv], ask=None)
        finally:
            cli.build = original
        return code, json.loads(out.getvalue())

    def everything_refused(self, c):
        """Every command but status and restore refused, with nothing sent
        or written."""
        before = (c.batches(), list(self.w.log), list(self.w.posts))
        for argv in (("prepare", "@a"), ("issue", "b1", "--confirm", "b1"),
                     ("resume", "b1", "--confirm", "b1"), ("rebroadcast", "b1", "--confirm", "b1"),
                     ("readback", "b1"), ("attach-txid", "b1"), ("watch", "b1"),
                     ("certify", "b1"), ("publish", "b1"), ("cancel", "o1"), ("refund", "o1"),
                     ("broadcast-refund", "g1", "--confirm", "g1")):
            with self.subTest(command=argv[0]):
                code, out = self.run_main(c, *argv)
                self.assertEqual(code, 3, out)
                self.assertIn("restore required", out["refused"])
        self.assertEqual((c.batches(), self.w.log, self.w.posts), before)

    # A16

    def test_A16_a_database_without_its_journaled_batches_needs_a_restore(self):
        self.lost_host()
        # A fresh, empty database beside the journal.
        c = self.controller()
        self.assertEqual(c.recovery_state(), "required")
        self.assertEqual(c.missing_batches(), ["b1", "b2", "b3", "b4", "b5"])
        # Recorded in the database: it survives a restart.
        c.db.close()
        c = self.controller()
        self.assertEqual(c.recovery_state(), "required")
        self.assertEqual(c.db.execute("select count(*) from recoveries").fetchone()[0], 1)
        # No batch id is given out again, which would supersede the
        # journal's uncertain b3, and nothing else writes or sends.
        for call in (lambda: c.freeze("@a"), lambda: c.issue("b3"), lambda: c.resume("b3"),
                     lambda: c.watch("b4"), lambda: c.rebroadcast_commitment("b4"),
                     lambda: c.attach_txid("b4"), lambda: c.verify_certificates("b1"),
                     lambda: c.checkpoint("b2"), lambda: c.rollback_local("b2")):
            with self.assertRaises(Refused) as e:
                call()
            self.assertEqual(str(e.exception), RESTORE_REQUIRED)
        self.assertEqual(c.batches(), [])
        self.everything_refused(c)
        report = self.runner(c).recovery()
        self.assertFalse(report["ready"])
        self.assertEqual(report["state"], "required")
        self.assertIn("missing: b1, b2, b3, b4, b5", report["waiting"][0])
        self.assertIsNotNone(c.restore_pending())
        # A database that holds some of them, not all, needs one too.
        c.db.close()
        (self.tmp / "controller.db").unlink()
        c = self.controller()
        c._insert_batch(batch_row("b1", "@a", ["o1"], "final", ROOT_B1))
        c.db.execute("delete from recoveries")
        c.db.close()
        c = self.controller()
        self.assertEqual((c.recovery_state(), c.missing_batches()),
                         ("required", ["b2", "b3", "b4", "b5"]))
        # A restore clears it; the database then holds every journaled batch.
        self.snapshot()
        self.runner(c).restore()
        self.assertEqual(c.missing_batches(), [])
        self.assertEqual(c.recovery_state(), "reconciling")

    # A17

    def test_A17_an_interrupted_restore_leaves_nothing_half_done_and_resumes(self):
        self.lost_host()
        self.snapshot()
        # 1. Killed in the middle of the replay: the transaction never
        # committed, so nothing of it is there after the restart.
        p = subprocess.run([sys.executable, "-c", KILLED_REPLAY, str(self.tmp)], cwd=ROOT,
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 9, p.stderr)
        c = self.controller()
        self.assertEqual((c.batches(), c.recovery_state()), ([], "required"))
        self.everything_refused(c)
        # 2. Stopped in the replay again, by the runner this time, after
        # subs' files were moved in and recorded.
        inserted = []
        insert = Controller._insert_batch

        def stop_after_one(self_, row):
            insert(self_, row)
            inserted.append(row["bid"])
            raise Crash()
        Controller._insert_batch = stop_after_one
        try:
            with self.assertRaises(Crash):
                self.runner(c).restore()
        finally:
            Controller._insert_batch = insert
        self.assertEqual(inserted, ["b1"])
        c.db.close()
        c = self.controller()
        self.assertEqual((c.batches(), c.recovery_state()), ([], "required"))
        self.assertIsNotNone(c.restore_pending()["subs_at"])
        self.assertFalse(self.runner(c).recovery()["ready"])
        with self.assertRaises(NotConfirmed):
            self.runner(c).issue("b2", 1, "b2")
        # 3. Stopped during reconciliation, after the replay committed: the
        # batches are all there, and still nothing else runs.
        self.w.log.clear()
        readback = Controller.readback

        def stop(self_, bid):
            raise Crash()
        Controller.readback = stop
        try:
            with self.assertRaises(Crash):
                self.runner(c).restore()
        finally:
            Controller.readback = readback
        self.assertNotIn("stop", self.w.log)  # subs wasn't copied again
        c.db.close()
        c = self.controller()
        self.assertEqual(len(c.batches()), 5)
        self.assertEqual(c.recovery_state(), "incomplete")
        report = self.runner(c).recovery()
        self.assertFalse(report["ready"])
        self.assertIn("the restore is incomplete", report["waiting"][0])
        self.assertIsNotNone(c.restore_pending())
        self.everything_refused(c)
        # 4. Run again, it neither copies subs nor replays: it reconciles.
        replay = Controller._replay
        Controller._replay = lambda self_, n: self.fail("replayed twice")
        try:
            out = self.runner(c).restore()
        finally:
            Controller._replay = replay
        self.assertEqual((out["resumed_from"], out["subs_copied"], out["replayed"]),
                         ("incomplete", False, False))
        self.assertNotIn("stop", self.w.log)
        self.assertEqual(c.recovery_state(), "reconciling")
        self.assertEqual({b["bid"]: b["state"] for b in c.batches()},
                         {"b1": "final", "b2": "checkpointed", "b3": "broadcast_uncertain",
                          "b4": "broadcast", "b5": "rebuilt"})
        # A subs directory that already holds exactly the snapshot's files
        # (moved in, not yet recorded) is taken as copied; anything else in
        # it refuses.
        c.db.close()
        (self.tmp / "controller.db").unlink()
        c = self.controller()
        self.w.subs_running = False
        self.w.log.clear()
        out = self.runner(c).restore()
        self.assertFalse(out["subs_copied"])
        self.assertEqual(c.recovery_state(), "reconciling")

    # A18

    def test_A18_a_database_from_the_earlier_schema_is_migrated(self):
        db = sqlite3.connect(self.tmp / "controller.db")
        db.executescript(SCHEMA_5226810)
        db.execute("insert into batches(bid, space, members, digest, state, root, txid, intent) "
                   "values ('b1', '@a', '[\"o5\"]', 'made-up-digest', 'broadcast', ?, "
                   "'made-up-t4', 1)", ("ee" * 32,))
        db.execute("insert into alerts(kind, bid, detail) values ('made-up', 'b1', '')")
        db.commit()
        db.close()
        # Its journal entry, from before the column too.
        row = batch_row("b1", "@a", ["o5"], "broadcast", "ee" * 32, txid="made-up-t4", intent=1)
        self.assertNotIn("ancestors", row)
        self.journal_batches(row)
        c = self.controller()
        cols = {r["name"] for r in c.db.execute("pragma table_info(batches)")}
        self.assertIn("ancestors", cols)
        self.assertEqual({r["name"] for r in c.db.execute("pragma table_info(recoveries)")},
                         {"n", "snapshot", "restored_at", "subs_at", "replayed_at",
                          "reconciled_at", "ready_at"})
        b = c.batch("b1")
        self.assertEqual((b["state"], b["txid"], b["members"], b["ancestors"]),
                         ("broadcast", "made-up-t4", ["o5"], None))
        self.assertEqual(len(c.alerts()), 1)
        self.assertIsNone(c.recovery_state())
        # Capturing the bytes, which issuance does right after its broadcast,
        # works on the migrated table.
        self.w.txs = {"made-up-t0": 400, "made-up-t3": None, "made-up-t4": None}
        self.w.vins = {"made-up-t4": ["made-up-t3", "made-up-t0"]}
        self.assertTrue(c.capture_bytes("b1"))
        self.assertEqual(json.loads(c.acknowledged("b1")["ancestors"]),
                         [["made-up-t3", "02made-up-t3"]])
        # Opening it again changes nothing, and a replay of the older
        # journal entry fits the migrated table.
        c.db.close()
        c = self.controller()
        self.assertEqual(c.batch("b1")["raw"], "02made-up-t4")
        c._replay(None)
        self.assertEqual(c.batch("b1")["raw"], "02made-up-t4")

    def test_A14_a_store_not_yet_reconciled_and_a_missing_capability(self):
        self.lost_host()
        self.snapshot()
        self.w.txs.update({"made-up-txid-4": 490})
        self.w.chain.update({"@a": "ee" * 32})
        c = self.controller(caps=Capabilities(attach_txid=False))
        r = self.runner(c)
        r.restore()
        self.w.store.startup = {}
        report = r.recovery()
        self.assertIn("the store hasn't reconciled its refund attempts", report["waiting"])
        # Without the U1(b) capability the space is paused, not waiting: subs
        # can't be told, and the restore isn't held up for it.
        self.assertTrue(report["spaces"]["@a"]["attach"].startswith("paused: "))
        self.assertTrue(any(p.startswith("@a:") for p in report["paused"]))
        self.assertFalse(any(w.startswith("@a:") for w in report["waiting"]))


if __name__ == "__main__":
    unittest.main()
