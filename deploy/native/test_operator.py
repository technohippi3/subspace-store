from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from common import Refused
from host import operator


class OperatorTests(unittest.TestCase):
    def test_O154_redirect_never_forwards_operator_credential(self):
        received = []

        class Target(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                received.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

        target = ThreadingHTTPServer(("127.0.0.1", 0), Target)

        class Redirect(Target):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{target.server_port}/capture")
                self.end_headers()

        source = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
        threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in (source, target)]
        for thread in threads:
            thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                token = Path(directory) / "operator"
                token.write_text("fixture-service-operator-token-32-bytes")
                token.chmod(0o600)
                config = {"operator": {"url": f"http://127.0.0.1:{source.server_port}", "credentialFile": str(token)}}
                with self.assertRaises(Refused):
                    operator(config, "/operator/maintenance")
                self.assertEqual(received, [])
        finally:
            for server in (source, target):
                server.shutdown()
                server.server_close()
            for thread in threads:
                thread.join()


if __name__ == "__main__":
    unittest.main()
