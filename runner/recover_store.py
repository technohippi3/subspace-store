"""Store-owned recovery subprocess: inventory on stdin, one proof on stdout."""
import json
import sys
from pathlib import Path

from controller.host import build, check
from controller.errors import Refused
from controller.recovery_backend import reference as backend_reference
from runner.cli import Runner
from .recovery_bridge import RecoveryStore, digest


def main():
    request = json.loads(sys.stdin.buffer.read(4_194_305))
    if len(json.dumps(request)) > 4_194_304 or set(request) not in ({"inventory", "network", "database", "journalDirectory", "core"}, {"inventory", "network", "database", "journalDirectory", "core", "recoveryBackend"}):
        raise Refused("invalid recovery request")
    config = json.loads(Path(sys.argv[1]).read_text())
    check(config)
    if ("recoveryBackend" in request) != ("recovery_backend" in config) or "recoveryBackend" in request and backend_reference(request["recoveryBackend"]) != backend_reference(config["recovery_backend"]):
        raise Refused("runner and store recovery backends differ")
    if request.get("network") not in {"main", "regtest"} or config.get("network") != {"main":"mainnet", "regtest":"regtest"}[request["network"]] or config["store"].get("implementation") != "typescript" or \
            Path(config["store"]["db"]).resolve() != Path(request["database"]).resolve() or \
            Path(config["store"]["journal_dir"]).resolve() != Path(request["journalDirectory"]).resolve() or \
            config["bitcoind"]["url"].rstrip("/") != request["core"]["url"].rstrip("/") or \
            Path(config["bitcoind"]["cookie_file"]).resolve() != Path(request["core"]["cookiePath"]).resolve():
        raise Refused("runner and store recovery configuration differ")
    registry = RecoveryStore(request["inventory"], network=request["network"])
    c, publisher = build(config, registry)
    try:
        r = Runner(registry, c, network=config["network"], recovery_only=True)
        if c.recovery_state() is not None:
            r.restore()
        else:
            c.reconcile_bound()
        r.require_networks()
        statement = c.bound_statement()
        proof_hash = digest(statement)
        position = c.journal.append("store_reconciliation", statement=statement, proofHash=proof_hash)
        print(json.dumps(dict(statement=statement, proofHash=proof_hash, position=position)))
    finally:
        publisher.db.close()
        c.close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("controller recovery refused; inspect journals, bindings and chain state\n")
        sys.exit(1)
