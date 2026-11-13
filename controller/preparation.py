"""Batch preparation, separate from proving, snapshots and sends."""
import hashlib
import json

from .errors import Refused
from .preparation_history import PreparationBarrier, history, require_idle
from .preparation_readback import PreparationReadback, hash_value

CLOSED = ("rebuilt", "final", "fulfilled", "superseded")

def label(handle):
    return handle.split("@", 1)[0]


class Preparation:
    def _require_preparation_idle(self, preparing_bid=None):
        require_idle(self.journal, preparing_bid)

    # 1. Freeze

    def freeze(self, space, members=None, supersedes=None):
        self.require_restored()
        self._require_rebuild_gate()
        open_ = [b for b in self.batches(space) if b["state"] not in CLOSED]
        if open_:
            raise Refused(f"another batch is open ({open_[0]['bid']}); one commitment per space")
        busy = {m for b in self.batches() if b["state"] not in CLOSED for m in b["members"]}
        candidates = [o for o in self.registry.converted_orders()
                      if o not in busy and self.registry.batch_entry_ok(o)
                      and self.registry.order(o)["name"].endswith(space)]
        chosen = candidates if members is None else [m for m in members if m in candidates]
        if not chosen:
            raise Refused("nothing to batch")
        members_full = sorted((self.registry.order(m)["name"], self.registry.order(m)["recipient_spk"], m)
                              for m in chosen)
        digest = hashlib.sha256(json.dumps(members_full).encode()).hexdigest()
        bid = f"b{self.db.execute('select count(*) from batches').fetchone()[0] + 1}"
        prior = self.onchain_commitment(space)
        if prior is not None and (not isinstance(prior, dict) or "state_root" not in prior or not hash_value(prior["state_root"])):
            raise Refused("invalid observed preparation prior root")
        self.db.execute("""insert into batches(bid, space, members, digest, state, prior_root, supersedes)
                           values (?, ?, ?, ?, 'frozen', ?, ?)""",
                        (bid, space, json.dumps(sorted(chosen)), digest,
                         prior["state_root"] if prior is not None else None, supersedes))
        self._journal(bid)
        return bid

    def _preparation_no_commit(self, batch):
        if batch["root"] is not None or batch["intent"] or batch["attempted"] or batch["entry_key"] is not None or batch["txid"] is not None or \
                batch["raw"] is not None or batch.get("ancestors") is not None or batch["recovery_paused"] or \
                any(e["kind"] == "commit_local_intent" and e.get("bid") == batch["bid"] for e in self.journal.entries()):
            raise Refused("local commitment already requested or ambiguous; reconciliation required")

    def _pending_response(self, oids):
        result = self.registry.set_pending(oids)
        if getattr(self.registry, "bound_entries", False):
            if type(result) is not bool:
                raise Refused("invalid completed pending preparation receipt")
            return result
        return True  # The existing Python store's successful {ok:true} transport.

    @staticmethod
    def _sync_response(value):
        if not isinstance(value, dict) or set(value) != {"success", "pulled", "staged", "errors"} or \
                type(value["success"]) is not bool or any(type(value[k]) is not int or value[k] < 0 for k in ("pulled", "staged")) or \
                not isinstance(value["errors"], list) or any(not isinstance(e, str) for e in value["errors"]) or \
                value["success"] != (not value["errors"]):
            raise Refused("invalid completed preparation sync response")
        return value

    def _park_response(self, space, labels, parked):
        value = self.subs.post(f"/spaces/{space}/park", {"handles": labels, "parked": parked})
        if not isinstance(value, dict) or set(value) != {"updated"} or type(value["updated"]) is not int or not 0 <= value["updated"] <= len(labels):
            raise Refused("invalid completed preparation parking response")
        return value

    # 2. Stage. Unknown native/global pending requests retain ownership forever
    # until a separately reviewed reconciliation supplies more than readback.
    def stage(self, bid):
        self.require_restored(preparation_bid=bid)
        self._require_rebuild_gate()
        b = self.batch(bid)
        if b["state"] not in ("frozen", "staged"):
            raise Refused("not frozen or staged")
        self._preparation_no_commit(b)
        if not self._journal(bid):
            raise Refused("frozen batch not acknowledged; preparation withheld")
        reader, barrier = PreparationReadback(self), PreparationBarrier(self.journal)
        expected = reader.bindings(b)
        reader.head(b)
        _, _, latest = history(self.journal)
        if b["state"] == "staged" or latest.get(bid, {}).get("phase") == "cleared":
            reader.exact(b, expected)
            if b["state"] != "staged" and not self._save(bid, state="staged"):
                raise Refused("staged preparation not acknowledged")
            return {"sync": None, "staged": expected, "parked": []}
        reader.available(b, expected)
        staged = reader.pages(b, "staged")
        if any(h["name"] in expected and expected[h["name"]] != h["script_pubkey"] for h in staged):
            raise Refused("preexisting staged script differs")
        barrier.acquire(b)
        if not barrier.effect(b, "pending_set", [], lambda: self._pending_response(b["members"]), pending=True):
            raise Refused("pending preparation set not acknowledged; sync withheld")
        expected = reader.bindings(b)
        reader.head(b)
        staged = reader.pages(b, "staged")
        sync = None
        if not all(any(h["name"] == name and h["script_pubkey"] == script for h in staged) for name, script in expected.items()):
            sync = barrier.effect(b, "sync", [], lambda: self._sync_response(self.subs.post("/registry/sync")))
            staged = reader.pages(b, "staged")
        strays = sorted(h["name"] for h in staged if not h["parked"] and h["name"] not in expected)
        unpark = sorted(h["name"] for h in staged if h["parked"] and h["name"] in expected)
        for operation, labels, parked in (("park", strays, True), ("unpark", unpark, False)):
            if labels:
                reader.bindings(b)
                reader.head(b)
                barrier.effect(b, operation, labels, lambda: self._park_response(b["space"], labels, parked))
        expected = reader.bindings(b)
        reader.head(b)
        reader.exact(b, expected)
        if not barrier.effect(b, "pending_clear", [], lambda: self._pending_response([]), pending=True):
            raise Refused("pending clear not acknowledged; staged transition withheld")
        barrier.finish(b)
        if not self._save(bid, state="staged"):
            raise Refused("staged preparation not acknowledged")
        return {"sync": sync, "staged": expected, "parked": strays}

    # 3. Local commit. The pinned endpoint has no operation ID. The recorded
    # intent consumes this batch's sole opportunity even before a call arrives.
    def commit_local(self, bid):
        self.require_restored()
        self._require_rebuild_gate()
        b, reader = self.batch(bid), PreparationReadback(self)
        expected = reader.bindings(b)
        if b["state"] == "committed_local" and b["root"]:
            reader.committed(b, expected, b["root"])
            return dict(root=b["root"], members_on_root=len(expected), read_only=True)
        if b["state"] != "staged":
            raise Refused("not staged")
        self._preparation_no_commit(b)
        reader.head(b)
        reader.exact(b, expected)
        reader.bindings(b)
        if len(reader.pages(b, "committed")) + len(expected) > 10000:
            raise Refused("committed preparation readback capacity exceeded")
        if not self._journal(bid):
            raise Refused("staged batch not acknowledged; no local commit")
        self._preparation_no_commit(self.batch(bid))
        sequence = self.journal.append("commit_local_intent", bid=bid, space=b["space"])
        if self.journal.down():
            raise Refused("local commitment intent journal unavailable; reconciliation required")
        self._require_preparation_idle()
        exact = dict(seq=sequence, kind="commit_local_intent", bid=bid, space=b["space"])
        if not any(row == exact for row in self.journal.entries()):
            raise Refused("exact live local commitment intent unavailable; reconciliation required")
        result = self.subs.post(f"/spaces/{b['space']}/commit", {})
        if not isinstance(result, dict) or set(result) != {"space", "prev_root", "root", "handles_committed", "is_initial"} or \
                result["space"] != b["space"] or result["prev_root"] != b["prior_root"] or not hash_value(result["root"]) or \
                type(result["handles_committed"]) is not int or result["handles_committed"] != len(expected) or result["is_initial"] is not (b["prior_root"] is None):
            raise Refused("local commitment response differs; reconciliation required")
        root = result["root"]
        reader.committed(b, expected, root)
        reader.bindings(b)
        if not self._save(bid, state="committed_local", root=root):
            raise Refused("known local commitment not acknowledged; reconciliation required")
        result["members_on_root"] = len(expected)
        return result
