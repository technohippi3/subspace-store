"""TypeScript restore completion is bound to this controller's own journal."""
from .recovery_bridge import digest


def recovery_status(runner):
    if getattr(runner.store, "offline_recovery", False):
        return dict(ready=False, waiting=["store completion required"], paused=[], state=runner.c.recovery_state())
    report = runner.c.recovery_report()
    report["state"] = runner.c.recovery_state()
    status = runner.store.status() or {}
    marker = status.get("application_recovery") or {}
    valid = False
    if marker.get("version") == 2 and marker.get("required") is False and status.get("chain") and not runner.c.journal.down():
        position = marker.get("controllerSequence")
        history = runner.c.journal.entries()
        if type(position) is int and 1 <= position <= len(history):
            proof = history[position - 1]
            statement = proof.get("statement") or {}
            identity = runner.store.db.execute("select store from store_meta where id=1").fetchone()[0]
            valid = proof.get("kind") == "store_reconciliation" and proof.get("proofHash") == marker.get("proofHash") == digest(statement) and \
                statement.get("store") == identity and statement.get("sourceSequence") == marker.get("sourceSequence")
    report["store_reconciled"] = valid
    if not valid:
        report["ready"] = False
        report["waiting"].append("store/controller recovery completion is not acknowledged")
    if report["ready"] and runner.c.restore_pending():
        runner.c.mark_recovered()
    return report
