"""A forwarding HTTP proxy that can lose one response.

Usage: python3 -m regtest.harness.faultproxy <listen_port> <target_port> <control_file>

Every request is forwarded to 127.0.0.1:<target_port> unchanged. The control
file holds a JSON rule, `{"drop_response": "<substring>", "count": 1}`: the
next `count` requests whose path or body contain the substring are forwarded
and answered upstream, and then the client connection is closed without a
reply. The upstream effect happens; only the answer is lost. That is the
"lost response" fault in CONTROLLER-DESIGN.md.

`GET /__proxy__` returns the rule and the log of dropped requests.
"""

import http.client
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LOCK = threading.Lock()
DROPPED = []


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    target = None
    control = None

    def log_message(self, fmt, *args):  # quiet
        pass

    def _rule(self):
        try:
            return json.loads(Path(self.control).read_text())
        except (FileNotFoundError, ValueError):
            return {}

    def _consume(self, path, body):
        with LOCK:
            rule = self._rule()
            needle = rule.get("drop_response")
            count = rule.get("count", 0)
            if not needle or count <= 0:
                return False
            if needle not in path and needle.encode() not in body:
                return False
            rule["count"] = count - 1
            Path(self.control).write_text(json.dumps(rule))
            return True

    def _handle(self):
        if self.path == "/__proxy__":
            out = json.dumps({"rule": self._rule(), "dropped": DROPPED}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        drop = self._consume(self.path, body)
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in ("host", "connection", "content-length")}
        conn = http.client.HTTPConnection("127.0.0.1", self.target, timeout=3600)
        conn.request(self.command, self.path, body=body or None, headers=headers)
        resp = conn.getresponse()
        payload = resp.read()
        conn.close()
        if drop:
            with LOCK:
                DROPPED.append({"method": self.command, "path": self.path,
                                "request": body.decode(errors="replace")[:2000],
                                "upstream_status": resp.status,
                                "upstream_response": payload.decode(errors="replace")[:2000]})
            # The upstream call completed; the caller never hears about it.
            self.close_connection = True
            try:
                self.connection.shutdown(2)
            except OSError:
                pass
            return
        self.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() not in ("transfer-encoding", "connection", "content-length"):
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = do_POST = do_PUT = do_DELETE = _handle


def main(argv):
    listen, target, control = int(argv[1]), int(argv[2]), argv[3]
    Handler.target = target
    Handler.control = control
    server = ThreadingHTTPServer(("127.0.0.1", listen), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main(sys.argv)
