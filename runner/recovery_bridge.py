"""Offline registry view for the store-owned recovery subprocess.

The TypeScript parent owns and validates the complete store inventory. This
view has no HTTP, token, signer or entry-mutation fallback.
"""
import hashlib
import json

from controller.errors import Refused


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


class RecoveryStore:
    bound_entries = True
    offline_recovery = True

    def __init__(self, inventory):
        self.inventory = inventory
        if not isinstance(inventory, dict) or set(inventory) != set("version store sourceSequence sequence tipHeight tipHash orders entries spaces".split()):
            raise Refused("invalid recovery inventory")
        if inventory["version"] != 1 or not isinstance(inventory["orders"], list) or not isinstance(inventory["entries"], list) or len(inventory["orders"]) > 100000:
            raise Refused("invalid recovery inventory version or size")
        self.orders_by_id = {o["id"]: o for o in inventory["orders"]}
        self.entries = {e["entry"]: e for e in inventory["entries"]}
        if len(self.orders_by_id) != len(inventory["orders"]) or len(self.entries) != len(inventory["entries"]):
            raise Refused("duplicate recovery inventory identity")

    def order(self, oid):
        o = self.orders_by_id.get(oid)
        if not o:
            raise Refused("recovery order is missing")
        return dict(oid=oid, name=o["handle"], recipient_spk=o["recipient"], status=o["status"])

    def entry_status(self, b, create=False):
        if create:
            raise Refused("entry creation is unavailable during recovery")
        e = self.entries.get(b.get("entry_key"))
        if not e:
            return dict(found=False)
        if (e["root"], e["oids"], e["space"]) != (b["root"], sorted(b["members"]), b["space"]):
            raise Refused("controller/store recovery binding differs")
        return dict(found=True, entry=e["entry"], root=e["root"], oids=e["oids"],
                    phase="closed" if e["closed"] else "armed" if e["delegate"] else "open",
                    delegate=e["delegate"], acknowledged=True, batchable=False)

    def status(self):
        i = self.inventory
        return dict(chain=dict(network="regtest", best_block_hash=i["tipHash"], blocks=i["tipHeight"]),
                    application_recovery=dict(required=True))

    def journal_ok(self, oid):
        self.order(oid)
        return False  # No offline read ever grants a send permission.

    def acknowledged_status(self, oid):
        return None
