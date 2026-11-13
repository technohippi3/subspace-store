"""Bound publisher gates and acknowledgment-first delivery completion."""
from .errors import Refused


class BoundPublication:
    def _bound_context(self, bid, members):
        self.c.watch(bid)
        b = self.c.batch(bid)
        current = self.reg.commitment_status(b)
        if not current["acknowledged"] or not current["observation"] or not current["observation"]["covered"]:
            raise Refused("publication commitment not acknowledged and covered")
        statuses = {}
        for oid in members:
            status = self.reg.delivery_status(b, oid)
            if not status["acknowledged"] or status["revision"] != current["revision"]:
                raise Refused("publication certificate not currently acknowledged")
            statuses[oid] = status
        return b, current, statuses

    def _bound_fence(self, b, current):
        observed = self.c._commitment_observation(b)
        if any(observed[k] != current["observation"][k] for k in observed):
            raise Refused("chain changed during relay operation; verify again")

    def _bound_publish_guard(self, bid, chunk):
        b = self.c.batch(bid)
        if len(set(chunk)) != len(chunk) or any(o not in b["members"] or self.row(bid, o) is None or
                self.row(bid, o)["handle"] != self.reg.order(o)["name"] for o in chunk):
            raise Refused("invalid publication members")
        b, current, _ = self._bound_context(bid, chunk)
        self._bound_fence(b, current)
        self._journal(bid)  # Confirm the outstanding set before the external call.

    def _bound_confirm_delivery(self, bid, oid):
        row = self.row(bid, oid)
        if row is None or row["state"] not in ("published", "delivered") or row["publish_status"] != "final":
            return {"confirmed": False, "why": "not published"}
        b, current, statuses = self._bound_context(bid, [oid])
        live = self.live_check(bid)
        if not live["ok"]:
            return {"confirmed": False, "why": "live commitment check failed", "live": live}
        found = self.lookup(bid, oid)
        if not found["ok"]:
            self.c.alert("delivery_unconfirmed", bid, oid)
            return {"confirmed": False, "why": "verified lookup does not match", "lookup": found, "live": live}
        if not found["root_gate"]["ok"] or found["sovereignty"] != "sovereign":
            return {"confirmed": False, "waiting": True, "why": "relay root is not final, covered and sovereign", "lookup": found, "live": live}
        self._bound_fence(b, current)
        self._journal(bid)  # Includes the exact handle with final publication status.
        root, height = found["space_zone"]["commitment_root"], found["space_zone"]["commitment_height"]
        self.journal.append("verified_delivery", bid=bid, oid=oid, entry_key=b["entry_key"], revision=current["revision"],
                            certificate_hash=statuses[oid]["certificateHash"], root=root, height=height, proof_hash=found["proof_hash"])
        receipt = self.reg.fulfill_order(b, current["revision"], oid, statuses[oid]["certificateHash"], root, height, found["proof_hash"])
        if not receipt["acknowledged"]:
            raise Refused("fulfillment not acknowledged; local delivery remains outstanding")
        self.db.execute("update publication set state='delivered' where bid=? and oid=?", (bid, oid))
        self._journal(bid)
        return {"confirmed": True, "live": live, "lookup": found, "fulfillment": receipt}
