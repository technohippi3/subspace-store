"""The controller outside the regtest harness (PAYMENT-SPEC.md, "Checkout
and the attended runner").

The `test_A*` tests here are the runner cases A6 to A10: the runner built
from a host configuration alone, the snapshot's rule that subs is stopped
before anything is copied and answering again before work resumes, the
explicit refusal of the U1(b) attach without that capability, and the check
that every component is on the configured network and one chain before any
command. They run the
controller against recording stand-ins for subs, spaced and the store, so
they show what the controller calls and refuses, not what subs or the chain
does. They are neither model results nor regtest evidence.
"""

import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path

from controller import host
from controller.core import NO_ATTACH, Capabilities, Clients, Controller, Refused
from controller.journal import Journal
from controller.rpc import HttpError
from runner import cli
from runner.cli import NotConfirmed, Runner

ROOT = Path(__file__).resolve().parents[1]


DROP = object()  # an override that removes the key


def config(tmp, write=True, **over):
    """A complete host configuration over made-up local addresses and files."""
    tmp = Path(tmp)
    for f in ("token", "btc.cookie", "spaced.cookie") if write else ():
        (tmp / f).write_text("made-up-test-value\n")
    c = {
        "network": "regtest",
        "store": {"url": "http://127.0.0.1:9", "operator_token_file": str(tmp / "token"),
                  "db": str(tmp / "store.db"), "journal_dir": str(tmp / "offhost")},
        "controller": {"dir": str(tmp / "runner"), "journal_dir": str(tmp / "offhost"),
                       "journal_name": "runner", "operator_wallet": "made-up-wallet"},
        "bitcoind": {"url": "http://127.0.0.1:9", "cookie_file": str(tmp / "btc.cookie")},
        "spaced": {"url": "http://127.0.0.1:9", "cookie_file": str(tmp / "spaced.cookie")},
        "subs": {"url": "http://127.0.0.1:9", "data_dir": str(tmp / "subs"),
                 "stop_command": ["true"], "start_command": ["true"],
                 "capabilities": {"attach_txid": False}},
        "relay": {"url": "http://127.0.0.1:9"},
        "verifier": str(tmp / "verifier"),
    }
    for key, value in over.items():
        section, _, name = key.partition("__")
        if name:
            c[section] = dict(c[section])
            if value is DROP:
                c[section].pop(name, None)
            else:
                c[section][name] = value
        elif value is DROP:
            c.pop(section)
        else:
            c[section] = value
    return c


class FakeSubs:
    """subs as the controller sees it: /status answers while it runs.
    `after_stop` is how it answers after its stop: refused (stopped), or
    still running and answering with an HTTP error, or not answering in
    time."""

    def __init__(self, log):
        self.log = log
        self.running = True
        self.after_stop = "refused"
        self.comes_back = True    # answers again after its start
        self.posts = []

    def stop(self):
        self.log.append("stop")
        self.running = self.after_stop != "refused"

    def start(self):
        self.log.append("start")
        self.running = self.comes_back

    def client(self):
        subs = self

        class Client:
            def get(self, path, **kw):
                if path == "/status":
                    if not subs.running:
                        raise urllib.error.URLError(ConnectionRefusedError(111, "refused"))
                    if subs.log and subs.log[-1] == "stop":
                        if subs.after_stop == "http_503":
                            raise HttpError("GET", path, 503, "shutting down")
                        if subs.after_stop == "timeout":
                            raise urllib.error.URLError(TimeoutError("timed out"))
                    return {"spaces": []}
                raise AssertionError(path)

            def post(self, path, body=None, **kw):
                subs.posts.append((path, body))
                return {"attached": True}

        return Client()


class FakeRegistry:
    def __init__(self, tmp):
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        self.journal = Journal(tmp / "offhost", "store")


class Snapshot(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.log = []
        self.subs = FakeSubs(self.log)
        data = self.tmp / "subs"
        data.mkdir()
        (data / "state.json").write_text("{}")
        self.subs.data_dir = data
        orig_copy = __import__("shutil").copytree

        def copied(src, dst, **kw):
            self.log.append("copy" if self.subs.log[-1] != "stop" or not self.subs.running
                            else "copy while running")
            return orig_copy(src, dst, **kw)

        import controller.core as core
        core.shutil.copytree = copied
        self.addCleanup(setattr, core.shutil, "copytree", orig_copy)
        fake = self.subs.client
        self.c = Controller(self.tmp / "controller.db", Journal(self.tmp / "offhost", "runner"),
                            FakeRegistry(self.tmp), Clients(fake, fake, None, None), self.subs,
                            self.tmp / "verifier", self.tmp / "certs", "made-up-wallet",
                            ready_timeout=1)
        self.c.db.execute("insert into batches(bid, space, members, digest, state) "
                          "values ('b1', '@space', '[]', 'made-up-digest', 'proved')")

    def test_A7_a_snapshot_never_copies_a_running_subs_nor_resumes_before_it_answers(self):
        # After the stop, an answer of any kind, even an HTTP error, shows
        # subs still runs; a timeout leaves its shutdown uncertain. Neither
        # is copied.
        for after in ("answers", "http_503", "timeout"):
            with self.subTest(after_stop=after):
                self.subs.after_stop, self.subs.running = after, True
                self.log.clear()
                with self.assertRaises(Refused) as e:
                    self.c.checkpoint("b1")
                self.assertIn("shutdown isn't established", str(e.exception))
                self.assertEqual(self.log, ["stop"])
                self.assertEqual(self.c.batch("b1")["state"], "proved")

        self.subs.after_stop, self.subs.running, self.subs.comes_back = "refused", True, False
        self.log.clear()
        with self.assertRaises(Refused) as e:
            self.c.checkpoint("b1")
        self.assertIn("did not answer", str(e.exception))
        self.assertEqual(self.log, ["stop", "copy", "start"])
        self.assertEqual(self.c.batch("b1")["state"], "proved")

    def test_A8_a_snapshot_stops_copies_starts_then_checkpoints(self):
        snap = self.c.checkpoint("b1")
        self.assertEqual(self.log, ["stop", "copy", "start"])
        self.assertTrue(self.subs.running)
        self.assertEqual(self.c.batch("b1")["state"], "checkpointed")
        manifest = json.loads((Path(self.c.snapshot_dir) / Path(snap["dir"]).name
                               / "manifest.json").read_text())
        self.assertIn("subs/state.json", manifest["files"])


class Capability(unittest.TestCase):
    def test_A9_the_attach_is_refused_without_the_u1b_capability(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            for caps, refused in ((Capabilities(), True), (Capabilities(attach_txid=True), False)):
                with self.subTest(attach_txid=caps.attach_txid):
                    subs = FakeSubs([])
                    c = Controller(tmp / f"c-{caps.attach_txid}.db",
                                   Journal(tmp / "offhost", f"runner-{caps.attach_txid}"),
                                   FakeRegistry(tmp), Clients(subs.client, subs.client, None, None),
                                   subs, tmp / "verifier", tmp / "certs", "made-up-wallet", caps)
                    c.db.execute("insert into batches(bid, space, members, digest, state, txid) "
                                 "values ('b1', '@space', '[]', 'made-up-digest', 'final', "
                                 "'made-up-txid')")
                    for call in (lambda: c.attach_txid("b1"),
                                 lambda: c.attach_txid_value("b1", "made-up-other-txid")):
                        if refused:
                            with self.assertRaises(Refused) as e:
                                call()
                            self.assertEqual(str(e.exception), NO_ATTACH)
                        else:
                            call()
                    self.assertEqual(len(subs.posts), 0 if refused else 2)
                    if not refused:
                        self.assertEqual(subs.posts[0], ("/spaces/@space/commit/txid",
                                                         {"txid": "made-up-txid"}))


class Rpc:
    def __init__(self, answers):
        self.answers = answers

    def call(self, method, *params):
        a = self.answers[method]
        return a(*params) if callable(a) else a


class Stand:
    """Stand-ins for every component, all on one regtest chain unless a
    test changes one."""

    BEST = ("made-up-best-block", "made-up-spaced-tip")

    def __init__(self):
        self.btc = {"getblockchaininfo": {"chain": "regtest", "blocks": 200,
                                          "bestblockhash": "made-up-best-block"},
                    "getblockheader": self.header}
        self.spaced = {"getserverinfo": {"network": "regtest",
                                         "tip": {"hash": "made-up-spaced-tip", "height": 199}}}
        # Each subs endpoint, and the spaced behind it, as asked through it.
        self.subs = {which: {"wallet": "made-up-wallet",
                             "spaced": {"network": "regtest",
                                        "tip": {"hash": "made-up-spaced-tip", "height": 199}}}
                     for which in ("write", "read")}
        self.store = {"network": "regtest", "best_block_hash": "made-up-best-block",
                      "blocks": 200}
        self.calls = []

    def header(self, block_hash):
        if block_hash not in self.BEST:
            raise RuntimeError("Block not found")
        return {"confirmations": 1}

    def runner(self):
        stand = self

        class Subs:
            def __init__(self, which):
                self.which = which

            def get(self, path, **kw):
                assert path == "/rpc/endpoints", path
                return {"wallet": stand.subs[self.which]["wallet"]}

            def post(self, path, body=None, **kw):
                if path == "/rpc/spaced" and body == {"method": "getserverinfo", "params": []}:
                    return {"result": stand.subs[self.which]["spaced"]}
                # Anything else would be a write, such as /broadcast.
                stand.calls.append(("subs " + self.which, path))
                return {}

        class Controller:
            operator_wallet = "made-up-wallet"
            btc = Rpc(stand.btc)
            spaced = Rpc(stand.spaced)
            subs = Subs("write")
            subs_read = Subs("read")

            def batch(self, bid):
                return {"bid": bid, "state": "checkpointed", "txid": None}

            def issue(self, bid, fee_rate):
                stand.calls.append(("issue", bid))
                return bid

        class Store:
            def status(self):
                return {"chain": stand.store}

            def broadcast(self, gid, txid=None):
                stand.calls.append(("broadcast", gid))

        return Runner(Store(), Controller(), network="regtest")


class Networks(unittest.TestCase):
    def run_main(self, stand, *argv):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "runner.json"
            path.write_text(json.dumps({"network": "regtest"}))
            built = stand.runner()
            original = cli.build
            cli.build = lambda config, ask=None: built
            try:
                import io
                import contextlib
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    code = cli.main([str(path), *argv], ask=None)
            finally:
                cli.build = original
            return code, json.loads(out.getvalue())

    def test_A10_nothing_runs_unless_every_component_is_on_the_configured_network(self):
        def mainnet(s):
            s.btc["getblockchaininfo"] = dict(s.btc["getblockchaininfo"], chain="main")

        def spaced_mainnet(s):
            s.spaced["getserverinfo"] = dict(s.spaced["getserverinfo"], network="mainnet")

        def spaced_elsewhere(s):
            s.spaced["getserverinfo"] = dict(s.spaced["getserverinfo"],
                                             tip={"hash": "made-up-other-tip", "height": 10})

        def store_elsewhere(s):
            s.store = dict(s.store, best_block_hash="made-up-other-block")

        def no_store_chain(s):
            s.store = {}

        cases = {
            "bitcoind on main": mainnet,
            "spaced on mainnet": spaced_mainnet,
            "spaced on another chain": spaced_elsewhere,
            # The endpoint that broadcasts is checked on its own: here the
            # reads go to a regtest subs and the writes to a mainnet one.
            "the subs writes go to on mainnet":
                lambda s: s.subs["write"]["spaced"].update(network="mainnet"),
            "the subs reads go to on mainnet":
                lambda s: s.subs["read"]["spaced"].update(network="mainnet"),
            # Another regtest chain, the same wallet name, and a lower height:
            # only the block hash tells it apart.
            "the subs writes go to on another regtest chain, lower":
                lambda s: s.subs["write"]["spaced"].update(
                    tip={"hash": "made-up-other-regtest-tip", "height": 50}),
            "the subs reads go to on another regtest chain, lower":
                lambda s: s.subs["read"]["spaced"].update(
                    tip={"hash": "made-up-other-regtest-tip", "height": 50}),
            "subs writing with another wallet": lambda s: s.subs["write"].update(
                wallet="made-up-other"),
            "subs reading with another wallet": lambda s: s.subs["read"].update(
                wallet="made-up-other"),
            "the store on main": lambda s: s.store.update(network="main"),
            "the store on another chain": store_elsewhere,
            "a store that reports no chain": no_store_chain,
        }
        for what, change in cases.items():
            for argv, effect in ((("issue", "b1", "--confirm", "b1"), ("issue", "b1")),
                                 (("broadcast-refund", "g1", "--confirm", "g1"),
                                  ("broadcast", "g1"))):
                with self.subTest(what, command=argv[0]):
                    s = Stand()
                    change(s)
                    code, out = self.run_main(s, *argv)
                    self.assertEqual(code, 3)
                    self.assertIn("network check failed, nothing was done", out["refused"])
                    self.assertEqual(s.calls, [])
        # All on one regtest chain: the command runs.
        s = Stand()
        code, out = self.run_main(s, "issue", "b1", "--confirm", "b1")
        self.assertEqual((code, s.calls), (0, [("issue", "b1")]))
        # A component that doesn't answer stops everything too.
        s = Stand()
        s.spaced["getserverinfo"] = lambda: (_ for _ in ()).throw(ConnectionRefusedError())
        code, out = self.run_main(s, "issue", "b1", "--confirm", "b1")
        self.assertEqual((code, s.calls), (3, []))
        self.assertIn("didn't answer", out["refused"])


class Configuration(unittest.TestCase):
    def test_A6_the_runner_builds_from_configuration_without_the_harness(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "runner.json"
            path.write_text(json.dumps(config(d)))
            # A fresh interpreter: build the runner from the file and list
            # what it imported.
            code = ("import json, sys; from runner.cli import build; "
                    f"r = build(json.load(open({str(path)!r}))); "
                    "print(json.dumps({'harness': sorted(m for m in sys.modules "
                    "if m.startswith('regtest')), "
                    "'wallet': r.c.operator_wallet, "
                    "'caps': r.c.capabilities.as_dict()}))")
            p = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True,
                               text=True, timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            out = json.loads(p.stdout)
            self.assertEqual(out, {"harness": [], "wallet": "made-up-wallet",
                                   "caps": {"attach_txid": False}})

            from runner.cli import build
            for what, over in (("another network", {"network": "mainnet"}),
                               ("no network", {"network": DROP}),
                               ("no subs stop command", {"subs__stop_command": DROP}),
                               ("a shell string as the stop command",
                                {"subs__stop_command": "systemctl stop subs"}),
                               ("no stated capability", {"subs__capabilities": DROP}),
                               ("a capability that isn't true or false",
                                {"subs__capabilities": {"attach_txid": "yes"}}),
                               ("no operator wallet", {"controller__operator_wallet": DROP}),
                               ("no relay", {"relay": DROP}),
                               ("a null verifier", {"verifier": None}),
                               ("an empty verifier", {"verifier": ""}),
                               ("a numeric data directory", {"subs__data_dir": 5}),
                               ("an empty operator wallet", {"controller__operator_wallet": ""}),
                               ("a URL without a scheme", {"subs__url": "127.0.0.1:7777"}),
                               ("a URL of another scheme", {"bitcoind__url": "ftp://127.0.0.1"}),
                               ("a URL with credentials",
                                {"spaced__url": "http://user:made-up@127.0.0.1:7224"}),
                               ("a URL with a bad port", {"relay__url": "http://127.0.0.1:99999"}),
                               ("a negative timeout", {"subs__command_timeout": -1}),
                               ("a timeout as text", {"subs__ready_timeout": "120"}),
                               ("a timeout as true", {"subs__ready_timeout": True}),
                               ("an empty argument", {"subs__start_command": ["systemctl", ""]}),
                               ("a store path as a number", {"store__db": 3})):
                with self.subTest(what):
                    before = sorted(Path(d).iterdir())
                    with self.assertRaises(SystemExit):
                        build(config(d, **over))
                    self.assertEqual(sorted(Path(d).iterdir()), before)

    def test_the_example_configuration_is_complete_and_holds_no_credential(self):
        example = json.loads((ROOT / "deploy" / "runner.example.json").read_text())
        self.assertEqual(sorted(example), sorted(config("/nonexistent-made-up", write=False)))
        for section in ("store", "controller", "bitcoind", "spaced", "subs", "relay"):
            self.assertTrue(set(config("/nonexistent-made-up", write=False)[section]) <= set(example[section])
                            | {"write_url"}, section)
        text = json.dumps(example).lower()
        for word in ("password", "rpcpassword", "secret", "private", "seed", "xprv"):
            self.assertNotIn(word, text)
        self.assertEqual(example["network"], "regtest")


if __name__ == "__main__":
    unittest.main()
