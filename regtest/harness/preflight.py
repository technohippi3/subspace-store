"""Exercise the read-only preflight against the real isolated regtest stack.

The fixture intentionally has extra Core wallets and no separate recovery
volume. read_preflight expects the original wildcard subs binding;
read_private_preflight requires the patched IPv4 loopback binding.
Neither scenario is host acceptance.
"""

import json
import subprocess
import sys
from pathlib import Path

from tools.private_preflight import check, listeners
from . import scenarios
from .private_purchase import PrivateRun, PrivateRunner, private_checkout
from .procs import PORTS


def read_preflight(run):
    read_fixture(run, loopback_subs=False)


def read_private_preflight(run):
    read_fixture(run, loopback_subs=True)


def read_fixture(run, *, loopback_subs):
    runner = PrivateRunner(run)
    store_cfg = json.loads(run.registry.process.config.read_text())
    runner_cfg = json.loads(runner.config.read_text())
    sockets = subprocess.check_output(["ss", "-H", "-ltn"], text=True)
    bound = sorted((host, port) for host, port in listeners(sockets) if port == PORTS["subs"])
    expected_bound = [("127.0.0.1" if loopback_subs else "0.0.0.0", PORTS["subs"])]
    run.report.step("private preflight", None, "inspect the actual subs listener",
                    bound, {"expected listeners": expected_bound}, match=bound == expected_bound)
    result = check(store_cfg, runner_cfg, expected="regtest", ss=sockets)
    failed = {r["check"] for r in result["checks"] if not r["pass"]}
    expected = {
        "only the intended Core wallet is loaded",
        "only the intended wallet is registered in Core's wallet directory",
        "journal and snapshot filesystem devices differ from databases",
    }
    if not loopback_subs:
        expected.add("configured local TCP ports listen only on loopback")
    c = runner_cfg["controller"]
    snapshot = Path(c.get("snapshot_dir", str(Path(c["journal_dir"]) / "snapshots")))
    storage = next(r for r in result["checks"] if r["check"].startswith("journal and snapshot"))
    run.report.step("private preflight", None, "missing snapshot directory checks its existing device",
                    {"snapshot_exists": snapshot.exists(), "storage": storage},
                    {"snapshot_exists": False, "storage_detail": "condition not met"},
                    match=not snapshot.exists() and not storage["pass"]
                    and storage["detail"] == "condition not met",
                    note="same filesystem is refused; FileNotFoundError is not an acceptable result")
    run.report.step("private preflight", None, "read-only preflight identifies fixture limitations",
                    result, {"expected failures of this regtest fixture": sorted(expected)},
                    match=result["automated_checks"] == "FAIL" and failed == expected,
                    note="the checker result is FAIL by design; this tests detection, not host acceptance")


if __name__ == "__main__":
    scenarios.Run = PrivateRun
    scenarios.read_preflight = read_preflight
    scenarios.read_private_preflight = read_private_preflight
    scenarios.private_checkout = private_checkout
    sys.exit(scenarios.main(sys.argv))
