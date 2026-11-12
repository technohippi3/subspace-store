"""Local rollback and known-unsent rebuilds. Network broadcasts live in issuance."""
import hashlib
import json
from uuid import uuid4

from .errors import Refused

PREPARING = ("frozen", "staged", "committed_local", "proved", "checkpointed")


def _label(handle):
    return handle.split("@", 1)[0]


class Rebuild:
    def release_unsent(self, bid, failing):
        """Conditionally close the store entry before any local rollback.
        Its durable arm marker, not a stale local flag, is the final guard."""
        self.require_restored()
        b = self.batch(bid)
        failed = sorted(failing)
        if len(set(failed)) != len(failed) or not set(failed) <= set(b["members"]):
            raise Refused("invalid failed members")
        if b["state"] in ("releasing", "rebuilding", "rebuilt") and b.get("release_failed") is not None:
            if not set(failed) <= set(json.loads(b["release_failed"])):
                raise Refused("release already records a different failed-member set")
            return self.resume_release(bid)
        if b["state"] not in ("frozen", "staged", "committed_local", "proved", "checkpointed", "issuing") or b["attempted"]:
            raise Refused("batch may have escaped; unsent release refused")
        acked = self.acknowledged(bid)
        if acked and (acked["state"] in self.SENT or acked["attempted"]):
            raise Refused("journal records a possible send; unsent release refused")
        if acked and (any(acked[k] != b[k] for k in ("root", "prior_root", "members", "digest", "space")) or
                      (acked.get("entry_key") and acked["entry_key"] != b.get("entry_key"))):
            raise Refused("release identity differs from its journal; reconcile before continuing")
        if b["root"] is None:
            if b.get("entry_key") or b["intent"]:
                raise Refused("entry or intent has no root; reconcile before continuing")
            if b["state"] not in ("frozen", "staged") or any(
                    e["kind"] == "commit_local_intent" and e.get("bid") == bid for e in self.journal.entries()):
                raise Refused("local commit outcome has no confirmed root; reconcile before release")
            # No local commit was requested. Never roll back a prior root.
            return self._complete_bound_rebuild(b, failed)
        if not b.get("entry_key"):
            self._save(bid, journal=False, entry_key=uuid4().hex)
        self._save(bid, journal=False, state="releasing", release_failed=json.dumps(failed))
        return self.resume_release(bid)

    def resume_release(self, bid):
        self.require_restored()
        b = self.batch(bid)
        if b["state"] == "rebuilt" and b.get("release_failed") is not None:
            return self._released_successor(b)
        if b["state"] not in ("releasing", "rebuilding") or b["attempted"] or b.get("release_failed") is None:
            raise Refused("no unsent release to resume")
        if not self._journal(bid):
            raise Refused("release intent not acknowledged; store not changed")
        if b["state"] == "releasing":
            try:
                closed = self.registry.close_entry(b)
            except Exception:
                # A stale controller can ask to close an armed entry. Keep
                # that outcome uncertain, never roll back or unlock it.
                entry = self.registry.entry_status(b)
                if entry["found"] and entry["phase"] == "armed":
                    self._save(bid, journal=False, intent=1, attempted=1)
                    self._uncertain(bid, "store entry already armed", "unsent close refused: entry can have escaped")
                raise
            if not closed["acknowledged"]:
                raise Refused("entry closure not acknowledged; local rollback withheld")
            self._save(bid, journal=False, state="rebuilding", intent=0)
            if not self._journal(bid):
                raise Refused("closed-entry progress not acknowledged; local rollback withheld")
            b = self.batch(bid)
        else:
            closed = self.registry.entry_status(b)
            if not closed["found"] or closed["phase"] != "closed" or not closed["acknowledged"]:
                raise Refused("closed entry is not currently confirmed; local rollback withheld")
        self._rollback_bound_root(b)
        failed = json.loads(b["release_failed"])
        self.registry.observe()
        failed = sorted(set(failed) | {m for m in b["members"] if not self.registry.batch_entry_ok(m)})
        if failed != json.loads(b["release_failed"]):
            self._save(bid, journal=False, release_failed=json.dumps(failed))
            if not self._journal(bid):
                raise Refused("updated rebuild membership not acknowledged")
            b = self.batch(bid)
        if failed:
            self.subs.post(f"/spaces/{b['space']}/park", {
                "handles": [_label(self.registry.order(m)["name"]) for m in failed], "parked": True})
        for m in b["members"]:
            info = self.handle(b["space"], _label(self.registry.order(m)["name"]))
            if bool(info["parked"]) != (m in failed):
                raise Refused("parked rebuild membership differs; successor not created")
        return self._complete_bound_rebuild(b, failed)

    def _rollback_bound_root(self, b):
        def read():
            out = []
            for member in b["members"]:
                order = self.registry.order(member)
                info = self.handle(b["space"], _label(order["name"]))
                if info["script_pubkey"] != order["recipient_spk"]:
                    raise Refused("rebuild recipient differs; local rollback refused")
                out.append(info["commitment_root"])
            return out
        roots = read()
        if all(root == b["root"] for root in roots):
            self.journal.append("entry_rollback_intent", bid=b["bid"], root=b["root"], entry_key=b["entry_key"])
            self.subs.post(f"/spaces/{b['space']}/rollback-local")
            roots = read()
        if any(root is not None for root in roots):
            raise Refused("subs is neither the exact old root nor its staged members; rollback refused")

    def _complete_bound_rebuild(self, b, failed):
        """Parent retirement and its sole successor are one local transaction.
        A crash before the journal is repaired by retrying, not by rollback."""
        keep = sorted(m for m in b["members"] if m not in failed)
        child = f"b{self.db.execute('select count(*) from batches').fetchone()[0] + 1}" if keep else None
        statements = []
        if child:
            full = sorted((self.registry.order(m)["name"], self.registry.order(m)["recipient_spk"], m) for m in keep)
            statements.append(("insert into batches(bid,space,members,digest,state,prior_root,supersedes) "
                               "values(?,?,?,?,'frozen',?,?)", (child, b["space"], json.dumps(keep),
                               hashlib.sha256(json.dumps(full).encode()).hexdigest(), b["prior_root"], b["bid"])))
        else:
            statements.append(("insert into alerts(kind,bid,detail) values('every_member_failed',?,'')", (b["bid"],)))
        statements.append(("update batches set state='rebuilt',intent=0,release_failed=? where bid=?",
                           (json.dumps(failed), b["bid"])))
        self._atomically(*statements)
        return self._released_successor(self.batch(b["bid"]))

    def _released_successor(self, b):
        keep = sorted(m for m in b["members"] if m not in json.loads(b["release_failed"]))
        full = sorted((self.registry.order(m)["name"], self.registry.order(m)["recipient_spk"], m) for m in keep)
        digest = hashlib.sha256(json.dumps(full).encode()).hexdigest()
        children = [c for c in self.batches() if c["supersedes"] == b["bid"]]
        if len(children) != (1 if keep else 0) or (children and (
                children[0]["members"] != keep or children[0]["space"] != b["space"] or
                children[0]["prior_root"] != b["prior_root"] or children[0]["digest"] != digest)):
            raise Refused("rebuild successor differs; reconciliation required")
        if children and not self._journal(children[0]["bid"]):
            raise Refused("rebuild successor not acknowledged; retry completion")
        if not self._journal(b["bid"]):
            raise Refused("rebuilt parent not acknowledged; retry completion")
        return children[0]["bid"] if children else None

    def rollback_local(self, bid):
        self.require_restored()
        b = self.batch(bid)
        if getattr(self.registry, "bound_entries", False):
            return self.release_unsent(bid, b["members"])
        if b["state"] not in PREPARING or b["intent"] or b["attempted"]:
            raise Refused("never roll back a commitment that may have escaped")
        self.subs.post(f"/spaces/{b['space']}/rollback-local")
        self._save(bid, state="rebuilt")

    def rebuild_unsent(self, bid, failing):
        """A batch known never to have been sent: journal it as rebuilt, then
        return its members to paid, then roll back and continue without the
        failing members."""
        if getattr(self.registry, "bound_entries", False):
            return self.release_unsent(bid, failing)
        b = self.batch(bid)
        self.db.execute("update batches set state = 'rebuilt', intent = 0 where bid = ?", (bid,))
        if not self._journal(bid):
            self.db.execute("update batches set state = 'issuing', intent = 1 where bid = ?", (bid,))
            raise Refused("rebuild not acknowledged off-host; nothing sent, still issuing")
        for m in b["members"]:
            self.registry.unissue(m)
        self.subs.post(f"/spaces/{b['space']}/rollback-local")
        return self._new_without(b, failing)

    def rebuild(self, bid, failing):
        b = self.batch(bid)
        if getattr(self.registry, "bound_entries", False):
            return self.release_unsent(bid, failing)
        self.subs.post(f"/spaces/{b['space']}/rollback-local")
        self._save(bid, state="rebuilt")
        return self._new_without(b, failing)

    def _new_without(self, b, failing):
        space = b["space"]
        names = [_label(self.registry.order(m)["name"]) for m in failing]
        if names:
            self.subs.post(f"/spaces/{space}/park", {"handles": names, "parked": True})
        keep = [m for m in b["members"] if m not in failing]
        if not keep:
            self.alert("every_member_failed", b["bid"])
            return None
        # The kept members are staged again by the rollback; the new batch
        # skips the registry pull and is read back as staged.
        nb = f"b{self.db.execute('select count(*) from batches').fetchone()[0] + 1}"
        members_full = sorted((self.registry.order(m)["name"], self.registry.order(m)["recipient_spk"], m)
                              for m in keep)
        self.db.execute("""insert into batches(bid, space, members, digest, state, prior_root, supersedes)
                           values (?, ?, ?, ?, 'frozen', ?, ?)""",
                        (nb, space, json.dumps(sorted(keep)),
                         hashlib.sha256(json.dumps(members_full).encode()).hexdigest(),
                         b["prior_root"], b["bid"]))
        self._journal(nb)
        return nb
