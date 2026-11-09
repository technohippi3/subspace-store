"""Small clients for bitcoind, spaced and subs, standard library only.

Authentication uses the cookie files that bitcoind and spaced write at
start-up, read at each call, so no credential is held in configuration.
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


class HttpError(Exception):
    def __init__(self, method, path, status, body):
        super().__init__(f"{method} {path}: HTTP {status}: {body}")
        self.status = status
        self.body = body


def _cookie_auth(cookie_path):
    with open(cookie_path) as f:
        token = f.read().strip()
    return "Basic " + base64.b64encode(token.encode()).decode()


class JsonRpc:
    """JSON-RPC 2.0 over HTTP with cookie authentication."""

    def __init__(self, url, cookie_path, timeout=120):
        self.url = url
        self.cookie_path = cookie_path
        self.timeout = timeout
        self._id = 0

    def call(self, method, *params):
        self._id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method,
                           "params": list(params)}).encode()
        req = urllib.request.Request(self.url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Authorization", _cookie_auth(self.cookie_path))
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                out = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                out = json.loads(raw)
            except ValueError:
                raise RpcError(method, f"HTTP {e.code}: {raw[:200]!r}")
        if out.get("error"):
            raise RpcError(method, out["error"])
        return out.get("result")

    __call__ = call


class Http:
    """A JSON HTTP client for subs and the registry."""

    def __init__(self, base, timeout=120, token=None):
        self.base = base.rstrip("/")
        self.timeout = timeout
        self.token = token

    def request(self, method, path, body=None, raw=False, timeout=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", "Bearer " + self.token)
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                payload = resp.read()
        except urllib.error.HTTPError as e:
            raise HttpError(method, path, e.code, e.read().decode(errors="replace"))
        if raw:
            return payload
        return json.loads(payload) if payload else None

    def get(self, path, **kw):
        return self.request("GET", path, **kw)

    def post(self, path, body=None, **kw):
        return self.request("POST", path, {} if body is None else body, **kw)
