"""Bind an unsent batch to the native head before proving or first-send work."""
from .errors import Refused
from .preparation_readback import handle_fact, pipeline


def require_local_commitment(controller, batch):
    """Read both the latest head and exact recipients; old member roots alone
    cannot identify the commitment selected by subs' /broadcast endpoint.
    This assumes the installation's sole native writer; it is not a lock on
    an unrelated process calling subs directly.
    """
    root = batch["root"]
    head = pipeline(controller.subs_read.get(f"/spaces/{batch['space']}/pipeline"))
    if not root or head["root"] != root or head["txid"] is not None or not head["has_pending"]:
        raise Refused("native local commitment head differs; reconcile before proving or sending")
    for oid in batch["members"]:
        order = controller.registry.order(oid)
        name = order["name"].split("@", 1)[0]
        member = handle_fact(controller.handle(batch["space"], name))
        if order["name"] != name + batch["space"] or member["name"] != name or \
                member["commitment_root"] != root or member["commitment_idx"] != head["commitment_idx"] or \
                member["script_pubkey"] != order["recipient_spk"] or member["parked"]:
            raise Refused("native local commitment member differs; reconcile before proving or sending")
    # Member reads are separate requests. Detect a head change during them.
    after = pipeline(controller.subs_read.get(f"/spaces/{batch['space']}/pipeline"))
    if any(after[key] != head[key] for key in ("root", "txid", "commitment_idx", "has_pending")):
        raise Refused("native local commitment head changed during readback")
    return after
