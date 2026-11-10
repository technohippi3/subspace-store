"""A commitment broadcast whose answer never arrives as a transaction id,
and a database behind its journal: the runner cases A20 to A22 of
PAYMENT-SPEC.md (CONTROLLER-DESIGN.md, "One
cycle", step 9).

They run the real controller against recording stand-ins for subs,
spaced, bitcoind and the store, as tests/test_runner_recovery.py does, so
they show what the controller records, refuses and calls, not what subs
or the chain does. They are neither model results nor regtest evidence;
the model's case is X11 (tests/test_issuance.py).
"""

import json
import sqlite3
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from controller.core import ANSWER_LIMIT, Capabilities, Clients, Controller, Refused
from controller.journal import Journal
from controller.rpc import Http, HttpError
from tests.test_runner_recovery import ROOT_B1, ROOT_B2, World, batch_row

GOOD_TXID = "ab" * 32


class Stopped(BaseException):
    """The controller's process stopping at this point."""


class InterruptedBroadcast(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.w = World(self.tmp)
        self.journal = Journal(self.tmp / "offhost", "runner")
        self.w.spaced.answers.update({"getdelegation": lambda space: "made-up-num",
                                      "getnum": lambda num: {"txid": "made-up-delegate", "n": 0}})
        self.w.store.add("o1", "one@a", "issuing")
        self.w.subs_running = True
        self.broadcasts = []
        self.answer = lambda: json.dumps({"txid": GOOD_TXID}).encode()

    def controller(self, db="controller.db", journal=None, writes=None):
        reads = self.w.subs_client()
        test = self

        class Writes:
            def post(self, path, body=None, raw=False, **kw):
                if path.endswith("/broadcast"):
                    assert raw, "the broadcast answer is read as it came"
                    test.broadcasts.append(path)
                    return test.answer()
                return reads.post(path, body, **kw)

            def get(self, path, **kw):
                return reads.get(path, **kw)

        return Controller(self.tmp / db, journal or self.journal, self.w.store,
                          Clients(writes or Writes, lambda: reads, lambda: self.w.spaced,
                                  lambda: self.w.btc),
                          self.w, self.tmp / "verifier", self.tmp / "certs", "made-up-wallet",
                          Capabilities(attach_txid=True), ready_timeout=1)

    @staticmethod
    def insert(c, row):
        cols = ", ".join(row)
        c.db.execute(f"insert into batches({cols}) values ({', '.join('?' * len(row))})",
                     tuple(json.dumps(v) if k == "members" else v for k, v in row.items()))

    def issuing(self, c, bid):
        """A batch `issuing`, never sent; `resume` journals its intent and
        sends once."""
        self.insert(c, batch_row(bid, "@a", ["o1"], "issuing", ROOT_B1, intent=1))

    def journaled(self, bid, journal=None):
        return [e["batch"]["state"] for e in (journal or self.journal).entries()
                if e["kind"] == "batch" and e["batch"]["bid"] == bid]

    def assertUncertain(self, c, bid, sends):
        b = c.batch(bid)
        self.assertEqual((b["state"], b["attempted"]), ("broadcast_uncertain", 1))
        self.assertIsNone(b["txid"])
        self.assertEqual([a["kind"] for a in c.alerts() if a["bid"] == bid],
                         ["broadcast_uncertain"])
        self.assertEqual(c.acknowledged(bid)["state"], "broadcast_uncertain")
        with self.assertRaises(Refused):
            c.resume(bid)
        with self.assertRaises(Refused):
            c.retry_broadcast(bid)
        # Readback applies: it looks, finds nothing here, and sends nothing.
        rb = c.readback(bid)
        self.assertIn("evidence", rb)
        self.assertFalse(rb["adopted"])
        self.assertEqual(len(self.broadcasts), sends)

    def test_A20_an_answer_without_a_txid_is_an_uncertain_broadcast(self):
        def raise_(e):
            raise e
        long_body = '{"error": "' + "x" * (2 * ANSWER_LIMIT) + '"}'
        answers = {
            "not JSON": (lambda: b"<html>502 Bad Gateway</html>", "<html>502 Bad Gateway</html>"),
            "empty": (lambda: b"", "answer without a txid: "),
            "no txid": (lambda: b"{}", "{}"),
            "null txid": (lambda: b'{"txid": null}', '{"txid": null}'),
            "short txid": (lambda: b'{"txid": "made-up-txid"}', '{"txid": "made-up-txid"}'),
            "uppercase txid": (lambda: json.dumps({"txid": GOOD_TXID.upper()}).encode(),
                               GOOD_TXID.upper()),
            "a list": (lambda: json.dumps([GOOD_TXID]).encode(), f'["{GOOD_TXID}"]'),
            "not UTF-8": (lambda: b"\xff\xfe broken", "broken"),
            "HTTP error": (lambda: raise_(HttpError("POST", "/broadcast", 500, "wallet error")),
                           "HTTP 500: wallet error"),
            "long": (lambda: long_body.encode(),
                     f"[cut: {len('answer without a txid: ' + long_body)} characters in all]"),
        }
        c = self.controller()
        for i, (what, (answer, kept)) in enumerate(answers.items(), 1):
            with self.subTest(answer=what):
                bid = f"b{i}"
                self.issuing(c, bid)
                self.answer = answer
                c.resume(bid)
                self.assertUncertain(c, bid, sends=i)
                recorded = c.batch(bid)["answer"]
                self.assertIn(kept, recorded)
                self.assertLessEqual(len(recorded), ANSWER_LIMIT + 60)
        # A real HTTP client, and an answer cut short: 100 bytes promised,
        # 8 sent, the connection closed.
        test = self

        class Truncating(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                test.broadcasts.append(self.path)
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                self.send_response(200)
                self.send_header("Content-Length", "100")
                self.end_headers()
                self.wfile.write(b'{"txid":')
                self.wfile.flush()
                self.close_connection = True

        server = ThreadingHTTPServer(("127.0.0.1", 0), Truncating)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_address[1]}"
        own = Journal(self.tmp / "offhost-real", "runner")
        real = self.controller("real-http.db", own, writes=lambda: Http(url, timeout=10))
        self.issuing(real, "b50")
        sent = len(self.broadcasts)
        real.resume("b50")
        self.assertEqual(real.acknowledged("b50")["state"], "broadcast_uncertain")
        self.assertEqual(self.journaled("b50", own).count("broadcast_uncertain"), 1)
        self.assertUncertain(real, "b50", sends=sent + 1)
        self.assertIn("IncompleteRead", real.batch("b50")["answer"])
        # The control: a transaction id is an answer, kept as it came.
        self.answer = lambda: json.dumps({"txid": GOOD_TXID}).encode()
        self.issuing(c, "b99")
        c.resume("b99")
        b = c.batch("b99")
        self.assertEqual((b["state"], b["txid"], b["answer"]),
                         ("broadcast", GOOD_TXID, json.dumps({"txid": GOOD_TXID})))

    def test_A21_a_controller_stopped_mid_broadcast_reopens_uncertain(self):
        c = self.controller()
        self.issuing(c, "b1")

        def stop():
            raise Stopped()
        self.answer = stop
        with self.assertRaises(Stopped):
            c.resume("b1")
        self.assertEqual((c.batch("b1")["state"], c.batch("b1")["attempted"]), ("issuing", 1))
        # The next process opens the same database while the journal is down:
        # the batch is uncertain here, alerted, and not yet acknowledged.
        self.journal.set_down(True)
        c2 = self.controller()
        self.assertEqual(c2.batch("b1")["state"], "broadcast_uncertain")
        self.assertIn("interrupted", c2.batch("b1")["answer"])
        self.assertEqual(self.journaled("b1")[-1], "issuing")
        # With the journal back, the next opening acknowledges it, without
        # another alert or a send.
        self.journal.set_down(False)
        c3 = self.controller()
        self.assertUncertain(c3, "b1", sends=1)
        # Opening it again changes nothing more.
        self.controller()
        self.assertEqual(self.journaled("b1").count("broadcast_uncertain"), 1)

    def test_A21_a_stop_never_leaves_the_state_without_its_alert(self):
        c = self.controller()
        self.issuing(c, "b1")

        def stop():
            raise Stopped()
        self.answer = stop
        with self.assertRaises(Stopped):
            c.resume("b1")
        # A stop inside the settle's transaction, before it commits: the
        # alert can't be written, so neither is the state.
        c.db.execute("create trigger stop before insert on alerts "
                     "begin select raise(abort, 'stopped'); end")
        with self.assertRaises(sqlite3.Error):
            self.controller()
        self.assertEqual((c.batch("b1")["state"], c.alerts()), ("issuing", []))
        c.db.execute("drop trigger stop")
        # A stop after it commits, before the journal entry: the state and
        # its alert are here, and the next opening journals them.
        append = self.journal.append

        def stopped_append(kind, **data):
            if kind == "batch" and data["batch"]["state"] == "broadcast_uncertain":
                raise Stopped()
            return append(kind, **data)
        self.journal.append = stopped_append
        with self.assertRaises(Stopped):
            self.controller()
        self.journal.append = append
        self.assertEqual(c.batch("b1")["state"], "broadcast_uncertain")
        self.assertEqual(self.journaled("b1")[-1], "issuing")
        self.assertUncertain(self.controller(), "b1", sends=1)

    def test_A22_a_database_behind_its_journal_takes_the_journal_s_copy(self):
        c = self.controller()
        row = batch_row("b1", "@a", ["o1"], "issuing", ROOT_B1, intent=1)
        self.insert(c, dict(row, attempted=1))
        row2 = batch_row("b2", "@a", ["o1"], "broadcast_uncertain", ROOT_B2, intent=1)
        self.insert(c, dict(row2, attempted=1))
        # The journal holds both sent with known txids and bytes; this
        # database holds every journaled batch, so no restore is needed.
        for b in (row, dict(row, state="broadcast", txid=GOOD_TXID, raw="02made-up", attempted=1),
                  row2, dict(row2, state="broadcast", txid="cd" * 32, raw="02made-up-2",
                             attempted=1)):
            self.journal.append("batch", batch=b)
        c2 = self.controller()
        self.assertIsNone(c2.recovery_state())
        for bid, txid, raw in (("b1", GOOD_TXID, "02made-up"), ("b2", "cd" * 32, "02made-up-2")):
            b = c2.batch(bid)
            self.assertEqual((b["state"], b["txid"], b["raw"]), ("broadcast", txid, raw))
            self.assertEqual([a["kind"] for a in c2.alerts() if a["bid"] == bid],
                             ["database_behind_journal"])
            with self.assertRaises(Refused):
                c2.resume(bid)
        self.assertEqual(self.broadcasts, [])
        # Opened again, nothing more changes.
        self.assertEqual(len(self.controller().alerts()), 2)

    def test_A21_a_stale_row_waits_for_the_replay(self):
        journal = Journal(self.tmp / "offhost-restore", "runner")
        # A database left with a row from before the broadcast's answer.
        c0 = self.controller("partial.db", journal)
        row = batch_row("b1", "@a", ["o1"], "issuing", ROOT_B1, intent=1)
        self.insert(c0, dict(row, attempted=1))
        # b3 is attempted here too, but the journal holds it only `issuing`:
        # only the restore gate keeps the opening from writing it.
        self.w.store.add("o3", "three@c", "issuing")
        row3 = batch_row("b3", "@c", ["o3"], "issuing", "cc" * 32, intent=1)
        self.insert(c0, dict(row3, attempted=1))
        # The journal holds b1's answer and bytes, and a batch the database
        # doesn't have: a restore is needed.
        self.w.store.add("o2", "two@b", "converted")
        for b in (row, dict(row, state="broadcast", txid=GOOD_TXID, raw="02made-up"), row3,
                  batch_row("b2", "@b", ["o2"], "checkpointed", ROOT_B2)):
            journal.append("batch", batch=b)
        before = journal.position()
        c1 = self.controller("partial.db", journal)
        self.assertEqual(c1.recovery_state(), "required")
        for bid in ("b1", "b3"):
            self.assertEqual((c1.batch(bid)["state"], c1.batch(bid)["attempted"]), ("issuing", 1))
        # Nothing is written while the restore is needed.
        self.assertEqual((journal.position(), c1.alerts()), (before, []))
        c1.restore_from_journal()
        b = c1.batch("b1")
        self.assertEqual((b["state"], b["txid"], b["raw"]), ("broadcast", GOOD_TXID, "02made-up"))
        # The reconciliation, not the opening, makes b3 uncertain.
        self.assertEqual(c1.batch("b3")["state"], "broadcast_uncertain")
        self.assertEqual(self.broadcasts, [])


if __name__ == "__main__":
    unittest.main()
