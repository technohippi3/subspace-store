"""Keep unrelated preparation ownership out of acknowledged sent-batch work."""
from .errors import Refused, RESTORE_REQUIRED
from .preparation_history import history
from .journal import JournalDown


class Postsend:
    def require_postsend(self, bid):
        if self.recovery_state() in ("required", "incomplete"):
            raise Refused(RESTORE_REQUIRED)
        try:
            owner, _, _ = history(self.journal)
        except JournalDown:
            raise Refused("preparation journal unavailable") from None
        if owner is None:
            return
        b, acked = self.batch(bid), self.acknowledged(bid)
        fields = ("space", "members", "digest", "root", "prior_root", "entry_key", "delegate_in", "txid")
        if owner["bid"] == bid or set(owner["members"]) & set(b["members"]) or \
                b["state"] not in self.SENT or not b["root"] or not b["txid"] or not b["intent"] or not b["attempted"] or \
                not acked or not acked["intent"] or not acked["attempted"] or any(b[k] != acked[k] for k in fields):
            raise Refused("preparation owner overlaps or sent-batch binding is not acknowledged")
