"""A JSON-RPC client for Bitcoin Core, standard library only.

Authentication uses the cookie file bitcoind writes at start-up, so the
service's configuration names a path and holds no credentials.
"""

import base64
import json
import urllib.error
import urllib.request


class RpcError(Exception):
    def __init__(self, method, error):
        super().__init__(f"{method}: {error}")
        self.method = method
        self.error = error


class RpcUnreachable(Exception):
    """No answer: the call may or may not have reached the node."""


class BitcoinRpc:
    def __init__(self, url, cookie_path, wallet=None, timeout=60):
        self.url = url.rstrip("/") + (f"/wallet/{wallet}" if wallet else "")
        self.cookie_path = cookie_path
        self.timeout = timeout
        self._id = 0

    def _auth(self):
        with open(self.cookie_path) as f:
            return "Basic " + base64.b64encode(f.read().strip().encode()).decode()

    def call(self, method, *params):
        self._id += 1
        body = json.dumps({"jsonrpc": "1.0", "id": self._id, "method": method,
                           "params": list(params)}).encode()
        req = urllib.request.Request(self.url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Authorization", self._auth())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                out = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                out = json.loads(raw)
            except ValueError:
                raise RpcError(method, f"HTTP {e.code}: {raw[:200]!r}")
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            raise RpcUnreachable(f"{method}: {e}")
        if out.get("error"):
            raise RpcError(method, out["error"])
        return out.get("result")
