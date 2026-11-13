"""Preflight-tool tests over fake reads, not host or mainnet acceptance."""

import copy
import json
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from service.private_purchase import private_config
from tests.test_controller_host import config
from tests.test_private_purchase import configured
from tools import private_preflight as preflight


class Reads:
    def __init__(self, store):
        self.calls = []
        self.chain = {"chain": "main", "blocks": 100, "headers": 100,
                      "initialblockdownload": False}
        self.index = {"txindex": {"synced": True}}
        self.wallet = {"private_keys_enabled": True, "scanning": False}
        self.wallets = ["test-store"]
        self.store = {"private_attended_test": vars(private_config(store)),
                      "chain": {"network": "main", "best_block_hash": "made-up-tip"},
                      "journal_backlog": 0}

    def call(self, component, method, *args):
        self.calls.append((component, method, args))
        assert method in preflight.READS[component]
        return {"getblockchaininfo": self.chain, "getindexinfo": self.index,
                "getwalletinfo": self.wallet, "listwallets": self.wallets,
                "listwalletdir": {"wallets": [{"name": n} for n in self.wallets]},
                "getserverinfo": {"network": "mainnet", "tip": {"hash": "made-up-tip"}},
                "walletgetinfo": {"tip": 100}, "getblockheader": {"confirmations": 1}}[method]

    def status(self):
        return self.store

    def subs(self, url):
        return {"wallet": "made-up-wallet"}, {
            "network": "mainnet", "tip": {"hash": "made-up-tip"}}


class Preflight(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.runner = config(self.root, **configured())
        self.store = dict(configured(), listen={"host": "127.0.0.1", "port": 9},
                          db=str(self.root / "store.db"), journal_dir=str(self.root / "offhost"),
                          bitcoind={"url": "http://127.0.0.1:9",
                                    "cookie": str(self.root / "btc.cookie"), "wallet": "test-store"},
                          tokens={"operator": str(self.root / "token")})
        self.reader = Reads(self.store)
        self.ss = "LISTEN 0 128 127.0.0.1:9 0.0.0.0:*\n"
        self.mounts = "1 0 8:1 / / rw - ext4 /dev/test rw\n"
        self.stat = lambda p: SimpleNamespace(st_dev=2 if "offhost" in str(p) else 1,
                                             st_mode=stat.S_IFDIR | 0o700)

    def run_check(self, **kwargs):
        return preflight.check(self.store, self.runner,
                               **dict(reader=self.reader, ss=self.ss, mounts=self.mounts,
                                      stat=self.stat, **kwargs))

    def test_success_is_limited_to_automated_checks_and_has_no_writes(self):
        before = sorted(p.relative_to(self.root) for p in self.root.rglob("*"))
        with patch("service.ledger.Ledger", side_effect=AssertionError("database opened")), \
                patch("controller.core.Controller", side_effect=AssertionError("controller opened")):
            result = self.run_check()
        self.assertEqual(result["automated_checks"], "PASS", result)
        self.assertTrue(result["manual_checks"])
        self.assertEqual(sorted(p.relative_to(self.root) for p in self.root.rglob("*")), before)
        self.assertNotIn(str(self.root), json.dumps(result))
        self.assertNotIn("test-store", json.dumps(result))

    def test_rpc_failures_and_unready_wallets_or_nodes_fail_closed(self):
        changes = [("chain", "chain", "regtest"), ("chain", "initialblockdownload", True),
                   ("chain", "headers", 101), ("wallet", "private_keys_enabled", False),
                   ("wallet", "scanning", {"progress": 0.5}), ("wallet", "unlocked_until", 0)]
        for field, key, value in changes:
            with self.subTest(field=field, key=key):
                self.reader = Reads(self.store)
                getattr(self.reader, field)[key] = value
                self.assertEqual(self.run_check()["automated_checks"], "FAIL")
        self.reader = Reads(self.store)
        self.reader.index = {}
        self.assertEqual(self.run_check()["automated_checks"], "FAIL")
        self.reader = Reads(self.store)
        self.reader.wallets.append("unapproved-wallet")
        self.assertEqual(self.run_check()["automated_checks"], "FAIL")
        self.reader.call = Mock(side_effect=RuntimeError("secret-cookie-and-private-path"))
        out = self.run_check()
        self.assertEqual(out["automated_checks"], "FAIL")
        self.assertNotIn("secret-cookie", json.dumps(out))

    def test_mismatched_or_nonprivate_configuration_makes_no_rpc_calls(self):
        for key, value in (("network", "regtest"), ("private_attended_test", None)):
            bad = copy.deepcopy(self.store)
            bad[key] = value
            reader = Mock()
            result = preflight.check(bad, self.runner, reader=reader)
            self.assertEqual(result["automated_checks"], "FAIL")
            self.assertEqual(reader.mock_calls, [])
        self.runner["store"]["db"] += ".different"
        self.assertEqual(self.run_check()["automated_checks"], "FAIL")
        self.assertEqual(self.reader.calls, [])

    def test_wildcard_missing_and_ipv6_listeners_are_checked(self):
        for host in ("0.0.0.0", "[::]", "*", "192.0.2.1"):
            self.assertFalse(preflight.listener_check(
                self.ss + f"LISTEN 0 128 {host}:9 *:*\n", {9}))
        self.assertFalse(preflight.listener_check("", {9}))
        self.assertTrue(preflight.listener_check("LISTEN 0 128 [::1]:9 [::]:*\n", {9}))
        # Administrative SSH is not an application RPC listener.
        self.assertTrue(preflight.listener_check(self.ss + "LISTEN 0 128 0.0.0.0:22 *:*\n", {9}))

    def test_shared_mounts_and_same_filesystem_recovery_storage_fail(self):
        self.mounts = "1 0 0:2 / /shared rw - virtiofs host rw\n"
        self.assertEqual(self.run_check()["automated_checks"], "FAIL")
        self.mounts = "1 0 8:1 / / rw - ext4 /dev/test rw\n"
        self.stat = lambda p: SimpleNamespace(st_dev=1, st_mode=stat.S_IFDIR | 0o700)
        self.assertEqual(self.run_check()["automated_checks"], "FAIL")

    def real_directories_with_device_ids(self):
        """Real existence/type checks, with a separate recovery device simulated."""
        (self.root / "runner").mkdir()
        offhost = self.root / "offhost"
        offhost.mkdir()
        self.stat_paths = []

        def read_stat(path):
            path = Path(path)
            self.stat_paths.append(path)
            result = path.stat()  # Missing paths and non-directory parents really fail.
            return SimpleNamespace(st_dev=2 if path.is_relative_to(offhost) else 1,
                                   st_mode=result.st_mode)

        self.stat = read_stat

    def test_first_snapshot_uses_existing_parent_without_creating_directories(self):
        self.real_directories_with_device_ids()
        for path in (None, self.root / "offhost" / "new" / "snapshots"):
            with self.subTest(snapshot_dir=path):
                if path is not None:
                    self.runner["controller"]["snapshot_dir"] = str(path)
                before = sorted(self.root.rglob("*"))
                result = self.run_check()
                self.assertEqual(result["automated_checks"], "PASS", result)
                self.assertEqual(sorted(self.root.rglob("*")), before)
                self.assertIn(self.root / "offhost", self.stat_paths)

    def test_missing_snapshot_on_data_disk_and_missing_recovery_mount_fail(self):
        self.real_directories_with_device_ids()
        for path in (self.root / "new-snapshots" / "nested",
                     self.root / "unmounted-recovery" / "snapshots"):
            with self.subTest(snapshot_dir=path):
                self.runner["controller"]["snapshot_dir"] = str(path)
                result = self.run_check()
                storage = result["checks"][-1]
                self.assertFalse(storage["pass"], result)
                self.assertEqual(storage["detail"], "condition not met")

    def test_snapshot_parent_symlink_is_resolved_to_its_device(self):
        self.real_directories_with_device_ids()
        link = self.root / "recovery-link"
        link.symlink_to(self.root / "offhost", target_is_directory=True)
        self.runner["controller"]["snapshot_dir"] = str(link / "new" / "snapshots")
        self.assertEqual(self.run_check()["automated_checks"], "PASS")
        self.assertFalse((link / "new").exists())

    def test_storage_errors_are_not_treated_as_missing_directories(self):
        self.real_directories_with_device_ids()
        snapshot = self.root / "offhost" / "not-a-directory"
        snapshot.write_text("test fixture")
        for path in (snapshot, snapshot / "child"):
            self.runner["controller"]["snapshot_dir"] = str(path)
            storage = self.run_check()["checks"][-1]
            self.assertFalse(storage["pass"])
            self.assertIn("NotADirectoryError", storage["detail"])
        self.runner["controller"]["snapshot_dir"] = str(self.root / "offhost" / "snapshots")
        real_stat = self.stat

        def denied(path):
            if Path(path).name == "snapshots":
                raise PermissionError("private path")
            return real_stat(path)

        self.stat = denied
        storage = self.run_check()["checks"][-1]
        self.assertFalse(storage["pass"])
        self.assertEqual(storage["detail"], "PermissionError; details withheld")

    def test_transport_rejects_non_read_rpcs_before_credentials_or_network(self):
        reader = preflight.Reader(self.store, self.runner)
        with patch.object(reader, "_read") as transport:
            for method in ("sendtoaddress", "getnewaddress", "loadwallet", "createwallet",
                           "walletpassphrase", "sendrawtransaction", "walletexport"):
                with self.subTest(method=method), self.assertRaises(ValueError):
                    reader.call("store_wallet", method)
            transport.assert_not_called()
        with self.assertRaises(ValueError):
            preflight.NoRedirect().redirect_request(None, None, 302, "moved", {}, "http://127.0.0.1")
        for url in ("file:///unused", "http://user:secret@127.0.0.1/", "http://127.0.0.1/?secret"):
            with self.assertRaises(ValueError):
                preflight.valid_url(url)


if __name__ == "__main__":
    unittest.main()
