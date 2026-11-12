"""Issuance entry, send gating and interrupted-answer handling.

Extracted from the controller so the TypeScript registry protocol can be
qualified without growing the already large cycle/recovery module.
"""
import json
import re
import urllib.error
from uuid import uuid4

from .errors import Refused
from .rpc import HttpError

ANSWER_LIMIT = 2000
TXID_RE = re.compile(r"[0-9a-f]{64}")


def _bounded(text):
    if len(text) <= ANSWER_LIMIT:
        return text
    return f"{text[:ANSWER_LIMIT]} [cut: {len(text)} characters in all]"


class Issuance:
    def issue(self, bid, fee_rate=1):
        """The binding check, the serialized `issuing` step, both journals, and
        one `/broadcast`. Returns the batch that went on (a rebuilt one if a
        member failed)."""
        self.require_restored()
        b = self.batch(bid)
        if b["state"] != "checkpointed":
            raise Refused("not checkpointed")
        if getattr(self.registry, "bound_entries", False):
            return self._issue_bound(b, fee_rate)
        failing = self.failing(bid)
        if failing:
            return self.rebuild(bid, failing)
        delegate = self.live_delegate(b["space"])
        acked_members = self.registry.mark_issuing(b["members"])
        self._save(bid, journal=False, state="issuing", intent=1,
                   delegate_in=delegate["outpoint"], fee_rate=fee_rate)
        self._journal(bid)
        self._send(bid)
        return bid

    def _issuance_acknowledged(self, b):
        if self.journal.down():
            return False
        acked = self.acknowledged(b["bid"])
        if not acked or not acked["intent"]:
            return False
        if (acked["root"], acked["delegate_in"], acked["members"]) != \
                (b["root"], b["delegate_in"], b["members"]):
            return False
        if getattr(self.registry, "bound_entries", False):
            if not b.get("entry_key") or acked.get("entry_key") != b["entry_key"]:
                return False
            entry = self.registry.entry_status(b)
            return entry["found"] and entry["acknowledged"] and (bool(b["attempted"]) or entry["batchable"])
        return all(self.registry.acknowledged_status(m) == "issuing" for m in b["members"])

    def _send(self, bid):
        b = self.batch(bid)
        if b["state"] != "issuing" or b["attempted"]:
            raise Refused("the commitment send is not available or was already attempted")
        # The only path to the network for a commitment, checked immediately
        # before the call.
        if not self._issuance_acknowledged(b):
            raise Refused("order locks or broadcast intent not acknowledged off-host; not sent")
        self._save(bid, journal=False, attempted=1)
        try:
            # The body as it came, so that whatever subs answered is kept.
            body = self.subs.post(f"/spaces/{b['space']}/broadcast",
                                  {"fee_rate": b["fee_rate"]}, timeout=600, raw=True)
        except HttpError as e:
            # subs answered with an error. The wallet send may still have
            # happened (subs stores the txid only after the send returns), so
            # an error without a txid is not proof that nothing was sent.
            self._uncertain(bid, _bounded(f"HTTP {e.status}: {e.body}"),
                            "error answer without txid")
            return
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as e:
            self._uncertain(bid, f"no answer: {type(e).__name__}", "no answer")
            return
        except Exception as e:  # noqa: BLE001 - a truncated read, a protocol error
            # The call was made and no usable answer came back, whatever the
            # failure: uncertain, and never sent again.
            self._uncertain(bid, _bounded(f"no usable answer: {type(e).__name__}: {e}"),
                            "no usable answer")
            return
        text = body.decode("utf-8", errors="replace") if isinstance(body, bytes) else str(body)
        try:
            answer = json.loads(text) if text else None
        except ValueError:
            answer = None
        txid = answer.get("txid") if isinstance(answer, dict) else None
        if not (isinstance(txid, str) and TXID_RE.fullmatch(txid)):
            # An answer without a transaction id is no answer (A20).
            self._uncertain(bid, _bounded(f"answer without a txid: {text}"),
                            "answer without txid")
            return
        self._save(bid, state="broadcast", txid=txid, answer=_bounded(text))
        self.capture_bytes(bid)

    def _settle_checkpointed_entries(self):
        """An older local DB must recover an acknowledged entry ID. An
        issuing intent in that newer journal cannot prove no send occurred."""
        if not getattr(self.registry, "bound_entries", False):
            return
        for b in self.batches():
            if b["state"] != "checkpointed":
                continue
            acked = self.acknowledged(b["bid"])
            if not acked or not acked.get("entry_key"):
                continue
            if any(acked[k] != b[k] for k in ("root", "prior_root", "members", "digest", "space")) or \
                    (b.get("entry_key") and b["entry_key"] != acked["entry_key"]):
                raise Refused("controller entry binding differs from its journal; reconcile before continuing")
            if acked["state"] == "checkpointed" and b.get("entry_key") == acked["entry_key"]:
                continue
            if acked["state"] not in ("checkpointed", "issuing", *self.SENT):
                raise Refused("unsupported journal state for checkpointed entry recovery")
            self._adopt_journal_copy(acked)
            if acked["state"] == "issuing":
                self._uncertain(b["bid"], "older controller database lost the local attempted-send evidence",
                                "journaled intent after an older database: outcome uncertain")

    def resume(self, bid):
        self.require_restored()
        b = self.batch(bid)
        if b["state"] != "issuing":
            raise Refused("nothing to resume")
        if b["attempted"]:
            raise Refused("the broadcast was attempted: the outcome is uncertain")
        if getattr(self.registry, "bound_entries", False):
            self._require_bound(b)
            delegate = self.live_delegate(b["space"])
            self._save(bid, journal=False, intent=1, delegate_in=delegate["outpoint"])
            self._journal(bid)
            self._send(bid)
            return bid
        failing = self.failing(bid, recheck_issuing=True)
        if failing:
            return self.rebuild_unsent(bid, failing)
        delegate = self.live_delegate(b["space"])
        # Journal the members' marks again, then the intent, then send.
        for m in b["members"]:
            self.registry.journal_ok(m)
        self._save(bid, journal=False, intent=1, delegate_in=delegate["outpoint"])
        self._journal(bid)
        self._send(bid)
        return bid

    def _require_bound(self, b):
        entry = self.registry.entry_status(b)
        if not entry["found"] or not entry["acknowledged"] or not entry["batchable"]:
            raise Refused("issuance entry is not currently confirmed and batchable; locks retained, not sent")
        return entry

    def _issue_bound(self, b, fee_rate):
        """Checkpointed here may already mean issuing at the store. Read the
        exact durable binding before a retry; never guess from individual
        statuses or replay a commitment send."""
        bid = b["bid"]
        if b["intent"] or b["attempted"]:
            raise Refused("checkpointed batch has an issuance intent; reconcile before continuing")
        if not b.get("entry_key"):
            failing = self.failing(bid)
            if failing:
                return self.rebuild(bid, failing)
            self._save(bid, journal=False, entry_key=uuid4().hex)
            b = self.batch(bid)
        # Persist the key/root/member association before contacting the store.
        if not self._journal(bid):
            raise Refused("entry identity not acknowledged off-host; entry not requested")
        entry = self.registry.entry_status(b)
        if not entry["found"]:
            if self.failing(bid):
                raise Refused("entry candidates changed; reconcile before releasing or rebuilding")
            entry = self.registry.entry_status(b, create=True)
        if not entry["found"] or not entry["acknowledged"] or not entry["batchable"]:
            raise Refused("issuance entry is not currently confirmed and batchable; locks retained, not sent")
        delegate = self.live_delegate(b["space"])
        self._save(bid, journal=False, state="issuing", intent=1,
                   delegate_in=delegate["outpoint"], fee_rate=fee_rate)
        self._journal(bid)
        self._send(bid)
        return bid

