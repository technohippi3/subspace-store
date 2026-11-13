"""Versioned global preparation ownership and completed-response evidence.

No readback clears an unanswered request: pinned endpoints have no operation ID.
"""
import re
from .errors import Refused
from .journal import JournalDown

OPERATIONS = ("pending_set", "sync", "park", "unpark", "pending_clear")
FIELDS = {"version", "bid", "space", "members", "digest"}


def identity(batch):
    return dict(version=1, **{key: batch[key] for key in ("bid", "space", "members", "digest")})


def same(left, right):
    return all(left[key] == right[key] for key in FIELDS)


def validate(row):
    pending = row.get("kind") == "preparation_pending"
    abort = row.get("kind") == "preparation_abort"
    if abort:
        # Reuse the exact binding validation without inventing an effect receipt.
        if set(row) != FIELDS | {"kind", "seq"}:
            raise Refused("invalid preparation abort fields")
        validate(dict(row, kind="preparation_pending", phase="owned"))
        return
    expected = FIELDS | {"kind", "seq", "phase"} | (set() if pending else {"operation", "labels", "acknowledged"})
    members = row.get("members")
    if row.get("kind") not in ("preparation_pending", "preparation_effect") or set(row) != expected or \
            type(row.get("version")) is not int or row["version"] != 1 or type(row.get("seq")) is not int or row["seq"] < 1 or \
            not isinstance(row.get("bid"), str) or not re.fullmatch(r"b[1-9][0-9]*", row["bid"]) or \
            not isinstance(row.get("space"), str) or not re.fullmatch(r"@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", row["space"]) or \
            not isinstance(row.get("digest"), str) or not re.fullmatch(r"[0-9a-f]{64}", row["digest"]) or \
            not isinstance(members, list) or not 1 <= len(members) <= 1000 or \
            any(not isinstance(oid, str) or not re.fullmatch(r"o[1-9][0-9]{0,15}", oid) for oid in members) or \
            members != sorted(set(members)):
        raise Refused("invalid preparation history binding or fields")
    if pending:
        valid = row["phase"] in ("owned", "cleared")
    else:
        labels = row["labels"]
        valid = row["operation"] in OPERATIONS and row["phase"] in ("intent", "confirmed") and \
            isinstance(labels, list) and len(labels) <= 10000 and \
            all(isinstance(label, str) and re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels) and \
            labels == sorted(set(labels)) and (row["operation"] in ("park", "unpark") or not labels) and \
            (type(row["acknowledged"]) is bool if row["phase"] == "confirmed" and row["operation"] in ("pending_set", "pending_clear")
             else row["acknowledged"] is None)
    if not valid:
        raise Refused("invalid preparation history phase or response")


def history(journal, live=True):
    if live and journal.down():
        raise JournalDown("preparation journal unavailable")
    owner, unresolved, last, latest, aborted = None, None, None, {}, set()
    for row in journal.entries():
        if row.get("kind") not in ("preparation_pending", "preparation_effect", "preparation_abort"):
            continue
        validate(row)
        if row["kind"] == "preparation_abort":
            if owner is None or not same(owner, row) or unresolved is not None or row["bid"] in aborted:
                raise Refused("preparation abort requires exact completed ownership")
            aborted.add(row["bid"])
        elif row["kind"] == "preparation_pending":
            if row["phase"] == "owned":
                if row["bid"] in aborted:
                    raise Refused("aborted preparation cannot reacquire ownership")
                if owner is not None and not same(owner, row):
                    raise Refused("overlapping global preparation owners")
                if owner is None:
                    last = None
                owner = row
            else:
                if owner is None or not same(owner, row) or unresolved is not None or last is None or \
                        last["operation"] != "pending_clear" or last["phase"] != "confirmed" or last["acknowledged"] is not True:
                    raise Refused("preparation owner cleared without acknowledged completion")
                owner = None
            latest[row["bid"]] = row
        else:
            if row["bid"] in aborted and row["operation"] != "pending_clear":
                raise Refused("aborted preparation permits only pending clear")
            if owner is None or not same(owner, row):
                raise Refused("preparation effect has no exact global owner")
            if row["phase"] == "intent":
                if unresolved is not None:
                    raise Refused("overlapping preparation effects")
                unresolved = row
            else:
                if unresolved is None or not same(unresolved, row) or row["operation"] != unresolved["operation"] or row["labels"] != unresolved["labels"]:
                    raise Refused("preparation completion has no exact intent")
                unresolved = None
            last = row
    return owner, unresolved, latest


def require_idle(journal, preparing_bid=None):
    try:
        owner, unresolved, _ = history(journal)
    except JournalDown:
        raise Refused("preparation journal unavailable") from None
    if unresolved is not None or owner is not None and owner["bid"] != preparing_bid:
        raise Refused("preparation effect or global pending owner requires reconciliation")
    if preparing_bid is not None:
        require_not_aborted(journal, preparing_bid)


def abort_record(journal, bid):
    history(journal)
    return next((row for row in journal.entries() if row.get("kind") == "preparation_abort" and row.get("bid") == bid), None)


def require_not_aborted(journal, bid):
    if abort_record(journal, bid) is not None:
        raise Refused("preparation was aborted; only abort completion may resume")


class PreparationBarrier:
    def __init__(self, journal):
        self.journal = journal

    def acquire(self, batch):
        owner, unresolved, _ = history(self.journal)
        if unresolved is not None or owner is not None and not same(owner, identity(batch)):
            raise Refused("global preparation owner requires reconciliation")
        if owner is None:
            self.journal.append("preparation_pending", **identity(batch), phase="owned")

    def effect(self, batch, operation, labels, work, pending=False):
        owner, unresolved, _ = history(self.journal)
        if owner is None or not same(owner, identity(batch)) or unresolved is not None:
            raise Refused("preparation effect requires reconciliation")
        data = dict(**identity(batch), operation=operation, labels=sorted(labels))
        self.journal.append("preparation_effect", **data, phase="intent", acknowledged=None)
        owner, unresolved, _ = history(self.journal)
        if owner is None or unresolved is None or not same(owner, identity(batch)) or not same(unresolved, identity(batch)) or \
                unresolved["operation"] != operation or unresolved["labels"] != sorted(labels):
            raise Refused("exact live preparation intent unavailable")
        result = work()
        if pending and type(result) is not bool:
            raise Refused("invalid completed pending preparation receipt")
        self.journal.append("preparation_effect", **data, phase="confirmed", acknowledged=result if pending else None)
        history(self.journal)
        return result

    def finish(self, batch):
        self.journal.append("preparation_pending", **identity(batch), phase="cleared")
        history(self.journal)
