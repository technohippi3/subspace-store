import base64
import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, urlsplit

from common import Refused

module = importlib.util.spec_from_file_location("fetch_secrets", Path(__file__).with_name("fetch-secrets.py"))
fetcher = importlib.util.module_from_spec(module)
module.loader.exec_module(fetcher)


class SecretsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.runtime = tempfile.TemporaryDirectory(prefix="subspace-secret-fixture-", dir=f"/run/user/{os.getuid()}")
        self.credentials = self.root / "credentials"
        self.credentials.mkdir(mode=0o700)
        (self.credentials / "bootstrap").write_text(json.dumps({"clientId": "fixture", "clientSecret": "fixture-bootstrap"}))
        (self.credentials / "bootstrap").chmod(0o600)
        cert, key = self.root / "tls.pem", self.root / "tls.key"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=fixture",
                        "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", str(key), "-out", str(cert)], check=True, capture_output=True)
        owner = self
        self.wrong_scope = False
        self.requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                owner.requests.append(self.path)
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.path != "/api/v1/auth/universal-auth/login" or body != {"clientId": "fixture", "clientSecret": "fixture-bootstrap"}:
                    self.send_error(403)
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({"accessToken": "fixture-access", "tokenType": "Bearer"}).encode())

            def do_GET(self):
                owner.requests.append(self.path)
                query = parse_qs(urlsplit(self.path).query)
                if self.headers.get("Authorization") != "Bearer fixture-access" or query.get("includeImports") != ["false"] or query.get("expandSecretReferences") != ["false"]:
                    self.send_error(403)
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({"secret": {"secretKey": "fixture-token", "secretPath": "/other" if owner.wrong_scope else "/installation/store",
                    "environment": "fixture", "workspace": "fixture-project", "type": "shared", "secretValueHidden": False,
                    "secretValue": "fixture-service-token-value-32-bytes"}}).encode())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.config = {"version": 1, "source": "infisical", "endpoint": f"https://127.0.0.1:{self.server.server_port}",
            "projectId": "fixture-project", "environment": "fixture", "roles": {"store": {"operator": {"name": "fixture-token",
            "path": "/installation/store", "encoding": "text"}}}, "outputRoot": self.runtime.name, "caFile": str(cert)}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()
        self.runtime.cleanup()

    def test_scoped_https_retrieval_renders_only_role_files(self):
        result = fetcher.fetch(self.config, "store", self.credentials)
        self.assertTrue(result["ok"])
        output = Path(self.runtime.name) / "store/operator"
        self.assertEqual(output.read_text(), "fixture-service-token-value-32-bytes")
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(self.requests), 2)

    def test_scope_failure_removes_old_runtime_values_and_has_no_cache_fallback(self):
        fetcher.fetch(self.config, "store", self.credentials)
        self.wrong_scope = True
        with self.assertRaises(Refused):
            fetcher.fetch(self.config, "store", self.credentials)
        self.assertFalse((Path(self.runtime.name) / "store").exists())

    def test_attended_recovery_requires_explicit_source_and_uses_no_infisical(self):
        self.config["source"] = "attended"
        (self.credentials / "bootstrap").unlink()
        (self.credentials / "offline-operator").write_bytes(b"fixture-independent-runtime-value")
        (self.credentials / "offline-operator").chmod(0o600)
        result = fetcher.fetch(self.config, "store", self.credentials)
        self.assertEqual(result["source"], "attended")
        self.assertEqual(self.requests, [])
        self.assertEqual((Path(self.runtime.name) / "store/operator").read_bytes(), b"fixture-independent-runtime-value")

    def test_missing_bootstrap_and_loose_runtime_credentials_refuse(self):
        (self.credentials / "bootstrap").chmod(0o644)
        with self.assertRaises(Refused):
            fetcher.fetch(self.config, "store", self.credentials)
        self.assertFalse((Path(self.runtime.name) / "store").exists())


if __name__ == "__main__":
    unittest.main()
