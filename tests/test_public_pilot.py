"""Production runner contracts with recording peers; no funded network action."""
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from runner.cli import Runner, NotConfirmed, build
from runner.public_pilot import GENESIS, PublicPilot, ConfigError, public_config
from runner.recovery_bridge import RecoveryStore


class PublicWorld:
    def __init__(self):
        self.calls = []
        self.btc = dict(chain="main", blocks=200, headers=200, initialblockdownload=False, bestblockhash="b" * 64)
        self.spaced = dict(network="mainnet", tip=dict(hash="b" * 64, height=200))
        self.index = dict(txindex=dict(synced=True, best_block_height=200))
        self.wallet = dict(tip=200, scanning=False)
        self.status = dict(chain=dict(network="main", best_block_hash="b" * 64, blocks=200), production_ready=True,
                           installation_identity=dict(version=1, network="main", genesis=GENESIS["mainnet"],
                                                      wallet="merchant", descriptorHash="d" * 64),
                           seller=dict(explicit_limits=True, spaces=[dict(space="space")]))
        self.subs = [copy.deepcopy(self.spaced), copy.deepcopy(self.spaced)]
        self.genesis = GENESIS["mainnet"]
        self.version = 310200
        self.loaded = True
        self.batch = dict(bid="b1", space="@space", state="checkpointed", txid="c" * 64,
                          attempted=False, fee_rate=3, ancestors="[]")
        world = self

        class Peer:
            def __init__(self, spaced=False):
                self.spaced = spaced

            def call(self, method, *args):
                world.calls.append((method, args))
                if self.spaced:
                    return copy.deepcopy({"getserverinfo": world.spaced, "walletgetinfo": world.wallet}[method])
                return copy.deepcopy({"getblockchaininfo": world.btc, "getindexinfo": world.index,
                                      "getblockhash": world.genesis, "getnetworkinfo": dict(version=world.version),
                                      "getmempoolinfo": dict(loaded=world.loaded),
                                      "getblockheader": dict(confirmations=1), "getrawmempool": []}[method])

        class Subs:
            def __init__(self, index):
                self.index = index

            def get(self, path):
                return dict(wallet="operator-wallet")

            def post(self, path, body):
                if path != "/rpc/spaced":
                    raise AssertionError("unexpected mutation")
                return dict(result=world.subs[self.index])

        def sent(method, *args):
            world.calls.append((method, args))
            return "b1" if method in ("issue", "resume") else "c" * 64

        store = SimpleNamespace(bound_entries=True, status=lambda: copy.deepcopy(self.status),
                                broadcast=lambda *args: sent("broadcast-refund", *args))
        controller = SimpleNamespace(btc=Peer(), spaced=Peer(True), subs=Subs(0), subs_read=Subs(1),
                                     operator_wallet="operator-wallet", recovery_state=lambda: None,
                                     batch=lambda bid: copy.deepcopy(self.batch), issue=lambda *args: sent("issue", *args),
                                     resume=lambda *args: sent("resume", *args),
                                     rebroadcast_commitment=lambda *args: sent("rebroadcast", *args))
        self.runner = Runner(store, controller, network="mainnet", public_pilot=PublicPilot(1, "space", 2, 10))


class PublicPilotContracts(unittest.TestCase):
    def test_A58_explicit_typescript_public_pilot_is_separate_from_private_baseline(self):
        config = dict(network="mainnet", store=dict(implementation="typescript"),
                      public_pilot=dict(version=1, space="space", minimum_fee_rate_sat_vb=2, maximum_fee_rate_sat_vb=10))
        self.assertEqual(public_config(config), PublicPilot(1, "space", 2, 10))
        for change in (dict(store=dict(implementation="python")), dict(private_attended_test={}), dict(network="signet"),
                       dict(public_pilot={**config["public_pilot"], "extra": 1}),
                       dict(public_pilot={**config["public_pilot"], "version": True}),
                       dict(public_pilot={**config["public_pilot"], "space": "@space"}),
                       dict(public_pilot={**config["public_pilot"], "minimum_fee_rate_sat_vb": 11})):
            with self.subTest(change=change), patch("runner.store.configured_store") as opened:
                with self.assertRaises(SystemExit):
                    build({**config, **change})
                opened.assert_not_called()
        with self.assertRaises(NotConfirmed):
            Runner(SimpleNamespace(), SimpleNamespace(), network="mainnet")
        self.assertIsNone(public_config(dict(network="regtest")))

    def test_A59_public_readiness_requires_index_wallet_installation_limits_and_same_tip_at_all_peers(self):
        self.assertTrue(PublicWorld().runner.networks()["ok"])
        changes = [lambda w: w.status.update(production_ready=False),
                   lambda w: w.status["seller"].update(explicit_limits=False),
                   lambda w: w.status["seller"]["spaces"].append(dict(space="other")),
                   lambda w: w.status["installation_identity"].update(descriptorHash="bad"),
                   lambda w: w.status["installation_identity"].update(network="regtest"),
                   lambda w: setattr(w, "genesis", GENESIS["regtest"]),
                   lambda w: setattr(w, "version", 310100), lambda w: setattr(w, "loaded", False),
                   lambda w: w.index["txindex"].update(synced=False),
                   lambda w: w.index["txindex"].update(best_block_height=199),
                   lambda w: w.wallet.update(tip=199), lambda w: w.wallet.update(scanning=True),
                   lambda w: w.spaced["tip"].update(height=199),
                   lambda w: w.subs[0]["tip"].update(hash="e" * 64),
                   lambda w: w.subs[1]["tip"].update(height=199),
                   lambda w: w.status["chain"].update(best_block_hash="e" * 64)]
        for change in changes:
            w = PublicWorld()
            change(w)
            self.assertFalse(w.runner.networks()["ok"])
            with self.assertRaises(NotConfirmed):
                w.runner.issue("b1", 3, "b1")
            self.assertFalse(any(c[0] in ("issue", "resume", "rebroadcast", "broadcast-refund") for c in w.calls))

    def test_A60_public_issue_resume_rebroadcast_and_refund_keep_fee_and_exact_confirmation_guards(self):
        w = PublicWorld()
        for rate in (None, 0, 1, 11, True):
            with self.assertRaises(NotConfirmed):
                w.runner.issue("b1", rate, "b1")
        with self.assertRaises(NotConfirmed):
            w.runner.issue("b1", 3, "other")
        w.batch["space"] = "@other"
        with self.assertRaises(NotConfirmed):
            w.runner.issue("b1", 3, "b1")
        w.batch["space"] = "@space"
        w.runner.issue("b1", 3, "b1")
        self.assertEqual([c for c in w.calls if c[0] == "issue"], [("issue", ("b1", 3))])
        w.batch["state"] = "issuing"
        w.batch["fee_rate"] = None
        with self.assertRaises(NotConfirmed):
            w.runner.resume("b1", "b1")
        w.batch["fee_rate"] = 3
        with self.assertRaises(NotConfirmed):
            w.runner.resume("b1", "other")
        w.runner.resume("b1", "b1")
        w.batch["state"] = "broadcast_uncertain"
        w.batch["fee_rate"] = 11
        with self.assertRaises(NotConfirmed):
            w.runner.rebroadcast("b1", "b1")
        w.batch["fee_rate"] = 3
        with self.assertRaises(NotConfirmed):
            w.runner.rebroadcast("b1", "other")
        w.runner.rebroadcast("b1", "b1")
        for confirm, txid in (("other", "c" * 64), ("group", None)):
            with self.assertRaises(NotConfirmed):
                w.runner.broadcast_refund("group", confirm, txid)
        w.runner.broadcast_refund("group", "group", "c" * 64)
        self.assertEqual(len([c for c in w.calls if c[0] == "broadcast-refund"]), 1)

    def test_A61_explicit_parent_network_binds_offline_recovery_and_cannot_grant_normal_send_capabilities(self):
        inventory = dict(version=1, store="mock", sourceSequence=1, sequence=2, tipHeight=200,
                         tipHash="b" * 64, orders=[dict(id="o1", handle="n@space", recipient="mock", status="requested")], entries=[], spaces=[])
        store = RecoveryStore(inventory, network="main")
        self.assertEqual(store.status()["chain"]["network"], "main")
        r = Runner(store, SimpleNamespace(), network="mainnet", recovery_only=True)
        for action in (lambda: r.issue("b1", 3, "b1"), lambda: r.resume("b1", "b1"),
                       lambda: r.rebroadcast("b1", "b1"), lambda: r.broadcast_refund("g", "g", "c" * 64),
                       lambda: r.prepare("@space"), lambda: r.refund("o1", cause="merchant"),
                       lambda: r.publish("b1"), lambda: r.cancel("o1")):
            with self.assertRaisesRegex(NotConfirmed, "offline recovery"):
                action()
        self.assertFalse(store.journal_ok("o1"))
        with self.assertRaises(NotConfirmed):
            Runner(SimpleNamespace(), SimpleNamespace(), network="mainnet", recovery_only=True)
        from runner.recover_store import main
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "runner.json"
            config.write_text(json.dumps(dict(network="regtest", store=dict(implementation="typescript", db="unused", journal_dir="unused"))))
            request = dict(inventory=inventory, network="main", database="unused", journalDirectory="unused", core={})
            with patch("runner.recover_store.check"), patch("runner.recover_store.build") as construct, \
                    patch("runner.recover_store.sys.argv", ["recover", str(config)]), \
                    patch("runner.recover_store.sys.stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps(request).encode()))):
                with self.assertRaisesRegex(Exception, "configuration differ"):
                    main()
                construct.assert_not_called()
