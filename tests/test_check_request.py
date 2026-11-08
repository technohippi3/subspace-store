"""tools/check_request.py, the buyer gate's request format checker
(docs/BUYER-GATE.md, preparation). The scripts are made-up valid keys from
the twin's recipient generator, never a real buyer's."""

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from tests.service_twin import recipient
from tools.check_request import check, main


class CheckRequest(unittest.TestCase):
    def test_a_nacho_shaped_request_passes(self):
        req = {"handle": "test@xn--example", "script_pubkey": recipient("gate-1")}
        self.assertEqual(check(json.dumps(req)), ("test@xn--example", None))

    def test_the_request_rules_refuse_without_echoing(self):
        good = recipient("gate-1")
        secret = "placeholder-not-a-key-7f3e"
        cases = {
            "extra member": json.dumps({"handle": "a@b", "script_pubkey": good,
                                        "dev_private_key": secret}),
            "repeated member": '{"handle": "a@b", "handle": "c@d", "script_pubkey": "%s"}' % good,
            "not canonical": json.dumps({"handle": "A@b", "script_pubkey": good}),
            "OP_RETURN": json.dumps({"handle": "a@b", "script_pubkey": "6a04deadbeef"}),
            "not an object": "[]",
            "over the HTTP limit": json.dumps({"handle": "a@b", "script_pubkey": good})
                                   + " " * 65536,
        }
        for what, text in cases.items():
            with self.subTest(what):
                handle, reason = check(text)
                self.assertIsNotNone(reason)
                self.assertNotIn(secret, reason)

    def test_the_limit_is_the_endpoints(self):
        from service.app import MAX_BODY
        req = json.dumps({"handle": "a@b", "script_pubkey": recipient("gate-1")})
        at_limit = req + " " * (MAX_BODY - len(req))
        self.assertEqual(check(at_limit), ("a@b", None))
        self.assertEqual(check(at_limit + " ")[1], f"over {MAX_BODY} bytes")

    def test_reused_scripts_fail_the_pair(self):
        script = recipient("gate-1")
        with tempfile.TemporaryDirectory() as d:
            paths = []
            for i, name in enumerate(("test", "test2")):
                p = Path(d) / f"r{i}.json"
                p.write_text(json.dumps({"handle": f"{name}@xn--example", "script_pubkey": script}))
                paths.append(str(p))
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(main(paths), 1)
            self.assertIn("REUSED", out.getvalue())
            Path(paths[1]).write_text(json.dumps({"handle": "test2@xn--example",
                                                  "script_pubkey": recipient("gate-2")}))
            with redirect_stdout(io.StringIO()):
                self.assertEqual(main(paths), 0)


if __name__ == "__main__":
    unittest.main()
