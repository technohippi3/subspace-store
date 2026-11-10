"""Private purchase cases Y1 to Y8; fake RPCs, real SQLite and journals."""

import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch

from model.chain import Chain, Tx
from model.private_purchase import PrivatePurchase as Model
from runner import cli
from runner.cli import NotConfirmed, Runner
from service import __main__ as main
from service.app import Service
from service.journal import Journal, JournalDown
from service.ledger import Ledger, Refused, RestoreRequired, restore_from_journal
from service.private_fees import build_refund
from service.private_purchase import ConfigError, PrivatePurchase
from tests.service_twin import ModelChainView, recipient
from tests.test_controller_host import Stand, config as runner_config
from tests.test_runner import FakeController, FakeStore
from tests.test_service_api import Client, OPERATOR, SUBS


PRIVATE = PrivatePurchase("trial@space", recipient("private-buyer"), 1000, 20, 2)


def configured(network="mainnet"):
    return {"network": network,
            "private_attended_test": {k: v for k, v in vars(PRIVATE).items() if k != "network"}}


class Configuration(unittest.TestCase):
    def test_Y1_mainnet_opt_in_and_config_are_checked_before_effects(self):
        invalid = [None, {}, {"network": "mainnet"}, {"network": "signet"},
                   dict(configured(), private_attended_test=True)]
        for key, value in (("price_sats", True), ("price_sats", 1001),
                           ("handle", "Bad@space"), ("script_pubkey", "5120"),
                           ("max_fee_rate_sat_vb", 0), ("max_fee_rate_sat_vb", True),
                           ("refund_fee_rate_sat_vb", 21), ("refund_fee_rate_sat_vb", None)):
            c = configured()
            c["private_attended_test"][key] = value
            invalid.append(c)
        for c in invalid:
            with self.subTest(config=c), patch.object(main, "BitcoinRpc") as rpc:
                with self.assertRaises(ConfigError):
                    main.build(c)
                rpc.assert_not_called()
                with self.assertRaises(SystemExit):
                    cli.build(c)
        for host in ("0.0.0.0", "::", "192.0.2.1", "localhost", "not-an-ip"):
            with self.subTest(host=host), self.assertRaises(ConfigError):
                main.validate(dict(configured(), listen={"host": host}))
        self.assertIsNone(main.validate({"network": "regtest"}))
        self.assertEqual(main.validate(configured()), replace(PRIVATE, network="mainnet"))
        with tempfile.TemporaryDirectory() as d:
            for section, key in (("store", "url"), ("spaced", "url"),
                                 ("subs", "url"), ("subs", "write_url")):
                c = runner_config(d, write=False, **configured())
                c[section][key] = "http://192.0.2.1:9"
                with self.subTest(section=section, key=key), \
                        patch("controller.host.build") as build, self.assertRaises(SystemExit):
                    cli.build(c)
                build.assert_not_called()

    def test_Y2_mainnet_identity_and_index_must_be_ready(self):
        stand = Stand()
        r = stand.runner()
        r.network, r.private_purchase = "mainnet", replace(PRIVATE, network="mainnet")
        stand.btc["getblockchaininfo"].update(chain="main", initialblockdownload=False)
        stand.btc["getindexinfo"] = {"txindex": {"synced": True}}
        stand.spaced["getserverinfo"]["network"] = "mainnet"
        for which in stand.subs.values():
            which["spaced"]["network"] = "mainnet"
        stand.store["network"] = "main"
        r.store.status = lambda: {"chain": stand.store, "private_attended_test": vars(r.private_purchase)}
        self.assertTrue(r.networks()["ok"])
        stand.btc["getindexinfo"] = {}
        self.assertFalse(r.networks()["ok"])
        stand.btc["getindexinfo"] = {"txindex": {"synced": False}}
        self.assertFalse(r.networks()["ok"])
        stand.btc["getindexinfo"] = {"txindex": {"synced": True}}
        stand.btc["getblockchaininfo"]["initialblockdownload"] = True
        self.assertFalse(r.networks()["ok"])
        stand.btc["getblockchaininfo"]["initialblockdownload"] = False
        r.store.status = lambda: {"chain": stand.store}
        self.assertFalse(r.networks()["ok"])
        self.assertEqual(stand.calls, [])

    def test_Y2_service_checks_index_and_wallet_before_opening_ledger(self):
        c = dict(configured(), bitcoind={"url": "http://127.0.0.1:9", "cookie": "unused",
                                       "wallet": "unused"})
        for wallet_info in ({}, {"private_keys_enabled": False, "scanning": False},
                            {"private_keys_enabled": True, "scanning": {"progress": 0.5}}):
            node, wallet = Mock(), Mock()
            node.call.side_effect = lambda method, *args: {
                "getblockchaininfo": {"chain": "main", "initialblockdownload": False},
                "getindexinfo": {"txindex": {"synced": True}}}[method]
            wallet.call.return_value = wallet_info
            with patch.object(main, "BitcoinRpc", side_effect=[node, wallet]), \
                    patch.object(main, "Ledger") as ledger, self.assertRaises(ConfigError):
                main.build(c)
            ledger.assert_not_called()

    def test_Y3_private_issue_and_resume_enforce_explicit_fee_ceiling(self):
        for rate in (None, 0, -1, True, 2.5, "2", 21):
            controller = FakeController()
            r = Runner(FakeStore(), controller, private_purchase=PRIVATE)
            with self.subTest(rate=rate), self.assertRaises(NotConfirmed):
                r.issue("b1", rate, "b1")
            self.assertEqual(controller.calls, [])
        for rate in (1, 20):
            controller = FakeController()
            r = Runner(FakeStore(), controller, private_purchase=PRIVATE)
            with self.assertRaises(NotConfirmed):
                r.issue("b1", rate, "wrong")
            r.issue("b1", rate, "b1")
            self.assertEqual(controller.calls, [("issue", "b1", rate)])
        controller = FakeController()
        controller.batch = lambda bid: {"state": "issuing", "attempted": 0, "fee_rate": 21}
        controller.resume = Mock()
        with self.assertRaises(NotConfirmed):
            Runner(FakeStore(), controller, private_purchase=PRIVATE).resume("b1", "b1")
        controller.resume.assert_not_called()


class Allowance(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.journal = Journal(self.root / "journal")
        self.now = [0.0]
        self.chain = Chain()
        self.view = ModelChainView(self.chain)
        self.draws = 0

        def destination(oid):
            self.draws += 1
            script = recipient(f"private-destination-{self.draws}")
            return script, script

        self.view.new_destination = destination
        self.path = self.root / "store.db"
        self.ledger = self.open()
        self.addCleanup(lambda: self.ledger.close())
        self.ledger.list_name(PRIVATE.handle, 1000)
        self.model = Model(PRIVATE.handle, PRIVATE.script_pubkey)

    def open(self, private=PRIVATE, path=None):
        return Ledger(path or self.path, self.view, self.journal,
                      clock=lambda: self.now[0], private_purchase=private)

    def request(self):
        return self.ledger.request(PRIVATE.handle, PRIVATE.script_pubkey)[0]

    def test_Y4_one_invoice_survives_expiry_cancellation_restart_and_restore(self):
        first, second = self.request(), self.request()
        self.assertTrue(self.model.quote(first, PRIVATE.handle, PRIVATE.script_pubkey, 1000))
        invoice = self.ledger.quote(first)
        self.model.acknowledge()
        self.assertTrue(invoice["acknowledged"])
        for action in (lambda: None, self.expire, lambda: self.ledger.cancel(first),
                       self.restart, self.restore):
            action()
            with self.assertRaises(Refused):
                self.request()
            with self.assertRaises(Refused):
                self.ledger.quote(second)
            self.assertFalse(self.model.quote(second, PRIVATE.handle, PRIVATE.script_pubkey, 1000))
            self.assertEqual(self.ledger.quote(first)["address"], invoice["address"])
        self.assertEqual(self.ledger.db.execute(
            "select count(*) from orders where dest_script is not null").fetchone()[0], 1)
        self.assertEqual(self.draws, 1)

    def test_Y4_concurrent_http_quotes_consume_the_allowance_once(self):
        service = Service(self.ledger, self.view, OPERATOR, SUBS, 1000, poll_seconds=3600)
        service.serve("127.0.0.1", 0)
        self.addCleanup(service.shutdown)
        client = Client(service.server.server_address[1])
        links = []
        for _ in range(2):
            code, order = client.call("POST", "/requests",
                                      {"handle": PRIVATE.handle, "script_pubkey": PRIVATE.script_pubkey})
            self.assertEqual(code, 201)
            links.append(order["order_link"])
        with ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(lambda link: client.call("POST", link + "/quote"), links))
        self.assertEqual(sorted(code for code, _ in results), [200, 409])
        self.assertEqual(self.draws, 1)

    def expire(self):
        self.now[0] += 901
        self.ledger.observe()

    def restart(self):
        self.ledger.close()
        self.ledger = self.open()

    def restore(self):
        self.ledger.close()
        self.path = self.root / "restored.db"
        restore_from_journal(self.path, self.journal)
        self.model.restore()
        self.ledger = self.open()

    def test_Y4_late_payment_keeps_the_existing_rules(self):
        oid = self.request()
        self.ledger.quote(oid)
        self.expire()
        for change in (self.ledger.set_price, self.ledger.list_name):
            with self.assertRaises(Refused):
                change(PRIVATE.handle, 500)
        script = self.ledger.operator_view(oid)["dest_script"]
        self.chain.add(Tx("private-payment", (("coin", 0),), ((script, 1000),)))
        for _ in range(3):
            self.chain.mine()
        self.ledger.observe()
        self.assertEqual(self.ledger.operator_view(oid)["status"], "converted")
        self.restart()
        self.assertEqual(self.ledger.operator_view(oid)["price"], 1000)

    def test_Y4_only_the_pinned_request_and_price_can_be_quoted(self):
        with self.assertRaises(Refused):
            self.ledger.request(PRIVATE.handle, recipient("another-buyer"))
        oid = self.request()
        with self.assertRaises(Refused):
            self.ledger.set_price(PRIVATE.handle, 1001)
        # The quote also checks the stored price; it cannot rely solely on
        # the operator command checking it earlier.
        with self.ledger.tx():
            self.ledger._set_name(PRIVATE.handle, price=1001)
        with self.assertRaises(Refused):
            self.ledger.quote(oid)
        self.assertFalse(self.model.quote(oid, PRIVATE.handle, PRIVATE.script_pubkey, 1001))
        self.assertIsNone(self.ledger._setting("private_purchase_order"))

    def test_Y5_address_waits_for_allowance_and_invoice_acknowledgment(self):
        first, second = self.request(), self.request()
        with patch.object(self.journal, "append", side_effect=JournalDown("outage")):
            invoice = self.ledger.quote(first)
            self.assertFalse(invoice["acknowledged"])
            self.assertIsNone(invoice["address"])
            self.model.quote(first, PRIVATE.handle, PRIVATE.script_pubkey, 1000)
            self.assertFalse(self.model.instructions(first))
            self.restart()
            with self.assertRaises(Refused):
                self.ledger.quote(second)
        invoice = self.ledger.quote(first)
        self.model.acknowledge()
        self.assertTrue(invoice["acknowledged"])
        entry = next(e for e in self.journal.entries() if any(
            r["kind"] == "setting" and r["key"] == "private_purchase_order"
            for r in e.get("records", [])))
        self.assertTrue(any(r["kind"] == "order" and r["key"] == first
                            and r["state"]["dest_address"] == invoice["address"]
                            for r in entry["records"]))

    def test_Y6_changed_or_missing_config_and_stale_database_refuse_startup(self):
        oid = self.request()
        stale = self.root / "stale.db"
        with sqlite3.connect(stale) as db:
            self.ledger.db.backup(db)
        self.ledger.quote(oid)
        self.ledger.close()
        for p in (None, replace(PRIVATE, handle="another@space"),
                  replace(PRIVATE, network="mainnet"),
                  replace(PRIVATE, script_pubkey=recipient("other"))):
            with self.assertRaises(Refused):
                self.open(private=p)
        with self.assertRaises(RestoreRequired):
            self.open(path=stale)
        self.ledger = self.open()
        self.assertEqual(self.ledger._setting("private_purchase_order"), oid)

    def test_Y5_allowance_and_invoice_roll_back_together(self):
        oid = self.request()
        self.ledger.db.execute("create trigger stop_quote before update of dest_script on orders "
                               "begin select raise(abort, 'simulated stop'); end")
        with self.assertRaises(sqlite3.IntegrityError):
            self.ledger.quote(oid)
        self.assertIsNone(self.ledger._setting("private_purchase_order"))
        self.assertIsNone(self.ledger._order(oid)["dest_script"])
        self.ledger.db.execute("drop trigger stop_quote")
        self.assertTrue(self.ledger.quote(oid)["acknowledged"])

    def test_Y6_private_mode_cannot_hide_an_ordinary_journals_order_history(self):
        journal = Journal(self.root / "ordinary-journal")
        normal = Ledger(self.root / "ordinary.db", self.view, journal)
        stale = self.root / "ordinary-stale.db"
        try:
            normal.list_name(PRIVATE.handle, 1000)
            with sqlite3.connect(stale) as db:
                normal.db.backup(db)
            oid, _ = normal.request(PRIVATE.handle, PRIVATE.script_pubkey)
            normal.quote(oid)
        finally:
            normal.close()
        with self.assertRaisesRegex(Refused, "empty order history"):
            Ledger(stale, self.view, journal, private_purchase=PRIVATE)


class Refunds(unittest.TestCase):
    def test_Y7_signed_refund_is_sized_and_checked_again_before_send(self):
        ledger = Mock()
        ledger.available.return_value = 1000
        ledger.policy.excess_minimum_over_fee = 546
        builder = Mock()
        builder.view.node.call.return_value = {"vsize": 150}
        builder.build.side_effect = lambda led, oid, buyer, fee: ({"raw": "made-up"}, fee)
        tx, buyer, fee, charged = build_refund(builder, ledger, "o1", "cancellation", PRIVATE)
        self.assertEqual((buyer, fee, charged), (700, 300, 1000))
        self.assertEqual(builder.build.call_count, 2)
        ledger.private_purchase.config = PRIVATE
        ledger._attempts.return_value = [{"txid": "made-up"}]
        ledger._attempt.return_value = {"raw": "made-up", "fee": 3001}
        service = Service(ledger, builder.view, "operator-test", "subs-test", 1000)
        with self.assertRaises(Refused):
            service.broadcast("g1")
        ledger.broadcast.assert_not_called()
        builder.build.side_effect = lambda led, oid, buyer, fee: ({"raw": "made-up"}, 3001)
        with self.assertRaises(Refused):
            build_refund(builder, ledger, "o1", "cancellation", PRIVATE)

    def test_Y8_startup_reports_pending_refunds_without_sending(self):
        ledger = Mock()
        ledger.private_purchase.config = PRIVATE
        ledger.reconcile_attempts.return_value = ["made-up-tx"]
        ledger._attempt.return_value = {"gid": "g1"}
        service = Service(ledger, Mock(), "operator-test", "subs-test", 1000)
        service.start()
        ledger.rebroadcast.assert_not_called()
        self.assertEqual(service.startup["rebroadcast"], [])
        self.assertEqual(service.startup["pending_rebroadcast"], ["made-up-tx"])
        with self.assertRaises(Refused):
            service.serve("0.0.0.0", 0)


if __name__ == "__main__":
    unittest.main()
