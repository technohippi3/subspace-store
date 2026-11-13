"""Retire a completed, uncommitted preparation owner without staging again."""
import hashlib
import json

from .errors import Refused
from .preparation_history import PreparationBarrier, abort_record, history, identity, same
from .preparation_readback import PreparationReadback


class PreparationAbort:
    def abort_preparation(self, bid):
        if self.recovery_state() in ("required", "incomplete"):
            raise Refused("restore and reconcile before aborting preparation")
        owner, unresolved, latest = history(self.journal)
        b = self.batch(bid)
        prior = abort_record(self.journal, bid)
        if unresolved is not None or owner is not None and not same(owner, identity(b)):
            raise Refused("unresolved or foreign preparation owner; abort withheld")
        if owner is None and (prior is None or latest.get(bid, {}).get("phase") != "cleared"):
            raise Refused("abort requires retained ownership or acknowledged abort progress")
        if prior is not None and not same(prior, identity(b)):
            raise Refused("preparation abort identity differs")
        rows = [b, *[e["batch"] for e in self.journal.entries() if e.get("kind") == "batch" and e.get("batch", {}).get("bid") == bid]]
        if any(not same(identity(row), identity(b)) or row.get("prior_root") != b["prior_root"] or
               row["state"] not in ("frozen", "staged", "rebuilt") or row.get("intent") or row.get("attempted") or row.get("recovery_paused") or
               any(row.get(k) is not None for k in ("root", "entry_key", "txid", "raw", "ancestors")) for row in rows):
            raise Refused("commitment or send evidence; preparation abort refused")
        if any(e.get("kind") == "commit_local_intent" and e.get("bid") == bid for e in self.journal.entries()):
            raise Refused("local commit intent; preparation abort refused")
        if b["state"] == "rebuilt":
            if prior is None or b["release_failed"] != json.dumps(b["members"]):
                raise Refused("batch was retired outside preparation abort")
            if not self._journal(bid):
                raise Refused("preparation abort completion not acknowledged")
            return self.batch(bid)
        reader, barrier = PreparationReadback(self), PreparationBarrier(self.journal)
        def inspect():
            orders = [self._release_order(b, oid) for oid in b["members"]]
            full = sorted((o["name"], o["recipient_spk"], oid) for o, oid in zip(orders, b["members"]))
            if len({o["name"] for o in orders}) != len(orders) or any(not o["name"].endswith(b["space"]) for o in orders) or \
                    hashlib.sha256(json.dumps(full).encode()).hexdigest() != b["digest"]:
                raise Refused("preparation abort frozen binding differs")
            reader.head(b)
            reader.available(b, {o["name"].split("@", 1)[0]: o["recipient_spk"] for o in orders})
        inspect()
        if prior is None:
            self.journal.append("preparation_abort", **identity(b))
            history(self.journal)
        if owner is not None:
            # Resume an acknowledged clear without issuing another request.
            effects = [e for e in self.journal.entries() if e.get("kind") == "preparation_effect" and e.get("bid") == bid]
            cleared = effects and effects[-1]["operation"] == "pending_clear" and effects[-1]["phase"] == "confirmed" and effects[-1]["acknowledged"] is True
            if not cleared and not barrier.effect(b, "pending_clear", [], lambda: self._pending_response([]), pending=True):
                raise Refused("abort pending clear not acknowledged")
            barrier.finish(b)
        inspect()
        if not self._save(bid, state="rebuilt", release_failed=json.dumps(b["members"])):
            raise Refused("preparation abort completion not acknowledged")
        return self.batch(bid)
