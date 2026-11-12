"""The controller and publisher built from a host configuration.

The configuration is plain JSON, read by the runner (`runner/cli.py`). It
names addresses, paths and commands only: authentication is by the cookie
files bitcoind and spaced write and by the store's operator token file, so
the configuration itself holds no credential. An example, with every key,
is `deploy/runner.example.json`; `docs/SERVICE.md` describes it.

    {
      "network": "regtest",
      "store": {"url", "operator_token_file", "db", "journal_dir",
                "implementation": "python" | "typescript" (optional)},
      "controller": {"dir", "journal_dir", "journal_name", "operator_wallet",
                     "snapshot_dir" (optional)},
      "bitcoind": {"url", "cookie_file"},
      "spaced": {"url", "cookie_file"},
      "subs": {"url", "write_url" (optional), "data_dir",
               "stop_command", "start_command", "command_timeout" (optional),
               "ready_timeout" (optional),
               "capabilities": {"attach_txid": true | false}},
      "relay": {"url"},
      "verifier": "<path to the libveritas verifier>"
    }

`subs.stop_command` must return only once the subs process has exited, and
`subs.start_command` once it has been started; the controller then checks
that subs no longer answers before it copies anything, and waits until it
answers again before work resumes. Each command is an argument list, run
without a shell.

`subs.capabilities.attach_txid` says whether the running subs has the
U1(b) route (`controller.core.Capabilities`). Nothing probes for it: the
operator states it, and the controller refuses the attach when it is false.

Which networks may run is the runner's decision, not this module's.
The implementation defaults to the Python owner-only baseline. The
TypeScript pilot requires an explicit selection; no server is probed to
guess the protocol, and an error never chooses another one.
"""

import os
import subprocess
import urllib.parse
from pathlib import Path

from .installation_fence import configured as installation_fence, attach as attach_fence
from .core import Capabilities, Clients, Controller
from .journal import Journal
from .recovery_backend import configured as recovery_backend, reference as backend_reference, RemoteJournal
from .publication import Publisher
from .rpc import Http, JsonRpc


class ConfigError(Exception):
    pass


def _need(config, *path):
    cur = config
    for i, key in enumerate(path):
        if not isinstance(cur, dict) or key not in cur:
            raise ConfigError(f"configuration has no {'.'.join(path[:i + 1])}")
        cur = cur[key]
    return cur


class CommandSubs:
    """subs as the host runs it, stopped and started by configured commands."""

    def __init__(self, data_dir, stop_command, start_command, timeout=300, cwd=None):
        for name, cmd in (("stop_command", stop_command), ("start_command", start_command)):
            if not isinstance(cmd, list) or not cmd or not all(isinstance(a, str) for a in cmd):
                raise ConfigError(f"subs.{name} must be a non-empty list of strings")
        self.data_dir = Path(data_dir)
        self.stop_command = stop_command
        self.start_command = start_command
        self.timeout = timeout
        self.cwd = cwd

    def _run(self, what, cmd):
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=self.timeout,
                           stdin=subprocess.DEVNULL, cwd=self.cwd)
        if p.returncode != 0:
            raise RuntimeError(f"subs {what} command exited {p.returncode}: "
                               f"{(p.stderr or p.stdout)[-300:]}")

    def stop(self):
        self._run("stop", self.stop_command)

    def start(self):
        self._run("start", self.start_command)


PATH, URL, NAME, COMMAND, SECONDS = "path", "url", "name", "command", "seconds"

# Every key the host reads: (path, kind, required).
KEYS = (
    (("store", "url"), URL, True), (("store", "operator_token_file"), PATH, True),
    (("store", "db"), PATH, True), (("store", "journal_dir"), PATH, True),
    (("controller", "dir"), PATH, True), (("controller", "journal_dir"), PATH, True),
    (("controller", "journal_name"), NAME, False),
    (("controller", "operator_wallet"), NAME, True),
    (("controller", "snapshot_dir"), PATH, False),
    (("bitcoind", "url"), URL, True), (("bitcoind", "cookie_file"), PATH, True),
    (("spaced", "url"), URL, True), (("spaced", "cookie_file"), PATH, True),
    (("subs", "url"), URL, True), (("subs", "write_url"), URL, False),
    (("subs", "data_dir"), PATH, True),
    (("subs", "stop_command"), COMMAND, True), (("subs", "start_command"), COMMAND, True),
    (("subs", "command_timeout"), SECONDS, False), (("subs", "ready_timeout"), SECONDS, False),
    (("relay", "url"), URL, True), (("verifier",), PATH, True),
)


def _value_ok(kind, v):
    if kind in (PATH, NAME):
        return isinstance(v, str) and v.strip() == v and v != "" and "\0" not in v
    if kind == URL:
        if not isinstance(v, str):
            return False
        u = urllib.parse.urlsplit(v)
        try:
            u.port
        except ValueError:
            return False
        return u.scheme in ("http", "https") and bool(u.hostname) and not u.username \
            and not u.password and not u.query and not u.fragment
    if kind == COMMAND:
        return isinstance(v, list) and bool(v) and all(isinstance(a, str) and a for a in v)
    if kind == SECONDS:
        return isinstance(v, (int, float)) and not isinstance(v, bool) and 0 < v <= 86400
    raise ValueError(kind)


WHAT = {PATH: "a non-empty path", NAME: "a non-empty name",
        URL: "an http or https URL with a host and no credentials, query or fragment",
        COMMAND: "a non-empty list of non-empty strings, run without a shell",
        SECONDS: "a number of seconds above 0 and at most 86400"}


def check(config):
    """Every key the host reads, present where required and of the right
    kind, checked before anything is created."""
    if not isinstance(config, dict):
        raise ConfigError("the configuration must be a JSON object")
    for path, kind, required in KEYS:
        section = config.get(path[0]) if len(path) > 1 else config
        if len(path) > 1 and not isinstance(section, dict):
            raise ConfigError(f"configuration has no {path[0]}")
        if path[-1] not in section:
            if required:
                raise ConfigError(f"configuration has no {'.'.join(path)}")
            continue
        if not _value_ok(kind, section[path[-1]]):
            raise ConfigError(f"{'.'.join(path)} must be {WHAT[kind]}")
    if "recovery_backend" in config:
        try:
            backend_reference(config["recovery_backend"])
        except ValueError as e:
            raise ConfigError(str(e)) from e
        if config.get("version") != 2 or config["store"].get("implementation") != "typescript" or not Path(config["controller"].get("snapshot_dir", "")).is_absolute():
            raise ConfigError("recovery_backend requires version 2, the TypeScript store and an explicit absolute controller.snapshot_dir")
    capabilities(config)
    if config["store"].get("implementation", "python") not in ("python", "typescript"):
        raise ConfigError("store.implementation must be python or typescript")


def clients(config):
    btc_url, btc_cookie = _need(config, "bitcoind", "url"), _need(config, "bitcoind", "cookie_file")
    sp_url, sp_cookie = _need(config, "spaced", "url"), _need(config, "spaced", "cookie_file")
    subs_url = _need(config, "subs", "url")
    write_url = config["subs"].get("write_url") or subs_url
    return Clients(subs=lambda: Http(write_url, timeout=600),
                   subs_read=lambda: Http(subs_url, timeout=600),
                   spaced=lambda: JsonRpc(sp_url, sp_cookie),
                   btc=lambda: JsonRpc(btc_url, btc_cookie))


def capabilities(config):
    caps = _need(config, "subs", "capabilities")
    if not isinstance(caps, dict) or not isinstance(caps.get("attach_txid"), bool):
        raise ConfigError("subs.capabilities.attach_txid must be true or false")
    return Capabilities(attach_txid=caps["attach_txid"])


def build(config, registry, cwd=None):
    """The controller and its publisher, for the store client `registry`."""
    check(config)
    fence = installation_fence(config)
    try:
        cc = _need(config, "controller")
        host = Path(_need(config, "controller", "dir"))
        host.mkdir(parents=True, exist_ok=True)
        backend = recovery_backend(config)
        journal = RemoteJournal(backend) if backend else Journal(_need(config, "controller", "journal_dir"), cc.get("journal_name", "runner"))
        s = _need(config, "subs")
        subs = CommandSubs(_need(config, "subs", "data_dir"), _need(config, "subs", "stop_command"),
                           _need(config, "subs", "start_command"), s.get("command_timeout", 300),
                           cwd=cwd)
        controller = Controller(host / "controller.db", journal, registry, clients(config), subs,
                                Path(_need(config, "verifier")), host / "certs",
                                _need(config, "controller", "operator_wallet"), capabilities(config),
                                snapshot_dir=cc.get("snapshot_dir"),
                                ready_timeout=s.get("ready_timeout", 120))
        controller.recovery_backend = backend
        attach_fence(controller, fence)
        fence = None
        try:
            publisher = Publisher(controller, registry, journal, host / "publication.db",
                                  controller.subs, _need(config, "relay", "url"))
        except BaseException:
            controller.close()
            raise
        return controller, publisher
    finally:
        if fence is not None:
            os.close(fence)
