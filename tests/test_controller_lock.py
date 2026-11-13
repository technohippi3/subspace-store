"""A23: real process ownership, with recording stand-ins for the RPCs."""

import json
import subprocess
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from controller.core import Controller
from controller.locking import ControllerBusy
from tests import test_interrupted_broadcast as fixtures


CHILD = """
import json, sys
from pathlib import Path
from controller.core import Controller
from controller.journal import Journal
from runner import cli
p = Path(sys.argv[1])
def opened():
    return Controller(p / 'controller.db', Journal(p / 'offhost', 'runner'),
                      None, None, None, p / 'verifier', p / 'certs', 'made-up-wallet')
if sys.argv[2] == 'status':
    def build(config, ask=None):
        c = opened()
        return cli.Runner(None, c)
    cli.build = build
    raise SystemExit(cli.main([str(p / 'runner.json'), 'status']))
c = opened()
c.db.execute("update batches set attempted = 1 where bid = 'b1'")
print('attempted', flush=True)
sys.stdin.read()
"""


class Ownership(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.InterruptedBroadcast()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        (self.f.tmp / "runner.json").write_text('{"network":"regtest"}')

    def child(self, command):
        return [sys.executable, "-c", CHILD, str(self.f.tmp), command]

    def test_A23_live_send_blocks_status_without_settling_or_alerting(self):
        c = self.f.controller()
        self.f.issuing(c, "b1")
        entered, release = threading.Event(), threading.Event()

        def answer():
            entered.set()
            if not release.wait(20):
                raise RuntimeError("test did not release the broadcast")
            return json.dumps({"txid": fixtures.GOOD_TXID}).encode()

        self.f.answer = answer
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(c.resume, "b1")
            try:
                self.assertTrue(entered.wait(10))
                before = self.f.journal.position()
                status = subprocess.run(self.child("status"), capture_output=True,
                                        text=True, timeout=10)
                self.assertEqual(status.returncode, 3, status.stderr)
                self.assertIn("controller busy", json.loads(status.stdout)["refused"])
                self.assertEqual(c.batch("b1")["state"], "issuing")
                self.assertEqual(c.alerts(), [])
                self.assertEqual(self.f.journal.position(), before)
                self.assertEqual(len(self.f.broadcasts), 1)
            finally:
                release.set()
            running.result(timeout=10)
        self.assertEqual(c.batch("b1")["state"], "broadcast")
        self.assertEqual(c.alerts(), [])
        c.close()
        reopened = self.f.controller()
        self.assertEqual(reopened.batch("b1")["txid"], fixtures.GOOD_TXID)
        self.assertEqual(reopened.alerts(), [])

    def test_A23_process_death_releases_ownership_and_settles_once(self):
        c = self.f.controller()
        self.f.issuing(c, "b1")
        c.close()
        process = subprocess.Popen(self.child("hold"), stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), "attempted")
            with self.assertRaises(ControllerBusy):
                self.f.controller()
            process.kill()
            process.communicate(timeout=10)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=10)
        reopened = self.f.controller()
        self.assertEqual(reopened.batch("b1")["state"], "broadcast_uncertain")
        self.assertEqual(len(reopened.alerts()), 1)
        reopened.close()
        self.assertEqual(len(self.f.controller().alerts()), 1)
        self.assertEqual(self.f.broadcasts, [])

    def test_A23_failed_start_and_normal_close_release_the_lock(self):
        with patch.object(Controller, "_settle_interrupted", side_effect=RuntimeError("startup")):
            with self.assertRaisesRegex(RuntimeError, "startup"):
                self.f.controller()
        c = self.f.controller()
        # Canonicalizing the path also prevents a symlink alias bypass.
        (self.f.tmp / "alias.db").symlink_to(self.f.tmp / "controller.db")
        with self.assertRaises(ControllerBusy):
            self.f.controller("alias.db")
        c.db.close()
        self.f.controller("alias.db").close()
        self.assertTrue((self.f.tmp / "controller.db.lock").exists())


if __name__ == "__main__":
    unittest.main()
