"""Pinned public native facts for preparation, not proof or chain acceptance."""
import hashlib
import json
import re
from .errors import Refused
from .rpc import HttpError


def hash_value(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def count(value):
    return type(value) is int and 0 <= value <= 100000


def pipeline(value):
    required = {"root", "txid", "has_pending", "staged_count", "commitment_idx", "steps"}
    steps = {"local", "proving", "broadcast", "confirmed", "finalized", "published"}
    if not isinstance(value, dict) or not required <= set(value) or type(value["has_pending"]) is not bool or not count(value["staged_count"]) or \
            value["root"] is not None and not hash_value(value["root"]) or value["txid"] is not None and not hash_value(value["txid"]) or \
            not isinstance(value["steps"], dict) or not steps <= set(value["steps"]) or \
            any(v not in ("complete", "in_progress", "pending", "skipped") for v in value["steps"].values()):
        raise Refused("invalid native preparation pipeline")
    if value["root"] is None:
        valid = value["txid"] is None and value["commitment_idx"] is None and not value["has_pending"] and value["steps"]["local"] == "pending"
    else:
        valid = count(value["commitment_idx"]) and value["steps"]["local"] == "complete"
    if not valid:
        raise Refused("inconsistent native preparation pipeline")
    return value


def handle_fact(row):
    required = {"name", "script_pubkey", "status", "commitment_root", "commitment_idx", "publish_status", "parked"}
    if not isinstance(row, dict) or not required <= set(row) or "dev_private_key" in row or not isinstance(row["name"], str) or \
            re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", row["name"]) is None or \
            not isinstance(row["script_pubkey"], str) or re.fullmatch(r"5120[0-9a-f]{64}", row["script_pubkey"]) is None or \
            type(row["parked"]) is not bool or row["publish_status"] is not None and not isinstance(row["publish_status"], str):
        raise Refused("invalid native preparation handle")
    if row["commitment_root"] is None:
        valid = row["commitment_idx"] is None and row["status"] == "staged"
    else:
        valid = hash_value(row["commitment_root"]) and count(row["commitment_idx"]) and row["status"] == "committed"
    if not valid:
        raise Refused("inconsistent native preparation handle")
    return row


class PreparationReadback:
    def __init__(self, controller):
        self.c = controller

    def bindings(self, batch):
        orders = [self.c.registry.order(oid) for oid in batch["members"]]
        if any(not isinstance(o, dict) or o.get("status") != "converted" or not isinstance(o.get("name"), str) or
               not o["name"].endswith(batch["space"]) or not isinstance(o.get("recipient_spk"), str) for o in orders):
            raise Refused("preparation order binding or status differs")
        full = sorted((o["name"], o["recipient_spk"], oid) for o, oid in zip(orders, batch["members"]))
        if len({o["name"] for o in orders}) != len(orders) or hashlib.sha256(json.dumps(full).encode()).hexdigest() != batch["digest"]:
            raise Refused("frozen preparation digest differs")
        if any(not self.c.registry.batch_entry_ok(oid) for oid in batch["members"]):
            raise Refused("preparation member is no longer batchable")
        return {o["name"].split("@", 1)[0]: o["recipient_spk"] for o in orders}

    def head(self, batch):
        chain = self.c.onchain_commitment(batch["space"])
        if chain is not None and (not isinstance(chain, dict) or "state_root" not in chain or not hash_value(chain["state_root"])):
            raise Refused("invalid observed preparation chain prior root")
        prior = chain["state_root"] if chain is not None else None
        row = pipeline(self.c.subs_read.get(f"/spaces/{batch['space']}/pipeline"))
        if prior is not None and not hash_value(prior) or prior != batch["prior_root"] or not isinstance(row, dict) or \
                row["root"] != prior or row["has_pending"] is not False or \
                (prior is not None and not hash_value(row["txid"])):
            raise Refused("native commitment is ahead, pending or ambiguous; preparation reconciliation required")

    def handle(self, batch, name):
        row = handle_fact(self.c.handle(batch["space"], name))
        if row["name"] != name:
            raise Refused("invalid native preparation handle")
        return row

    def pages(self, batch, filt):
        result, seen, total, pages, page = [], set(), None, 1, 1
        while page <= pages:
            row = self.c.subs_read.get(f"/spaces/{batch['space']}/handles?filter={filt}&page={page}&per_page=100")
            if not isinstance(row, dict) or set(row) != {"handles", "total", "page", "per_page", "total_pages"} or \
                    type(row["total"]) is not int or not 0 <= row["total"] <= 10000 or type(row["page"]) is not int or row["page"] != page or type(row["per_page"]) is not int or row["per_page"] != 100 or \
                    type(row["total_pages"]) is not int or row["total_pages"] != (row["total"] + 99) // 100 or not isinstance(row["handles"], list) or \
                    len(row["handles"]) != min(100, max(0, row["total"] - (page - 1) * 100)):
                raise Refused("invalid native preparation pagination")
            if total is not None and (row["total"] != total or max(1, row["total_pages"]) != pages):
                raise Refused("native preparation pagination changed")
            total, pages = row["total"], max(1, row["total_pages"])
            for handle in row["handles"]:
                handle = handle_fact(handle)
                if handle["name"] in seen or (handle["commitment_root"] is None) != (filt == "staged"):
                    raise Refused("duplicate or mismatched native preparation row")
                seen.add(handle["name"])
                result.append(handle)
            page += 1
        return result

    def available(self, batch, expected):
        for name, script in expected.items():
            try:
                row = self.handle(batch, name)
            except HttpError as error:
                if error.status == 404:
                    continue
                raise
            if row["script_pubkey"] != script or row["commitment_root"] is not None:
                raise Refused("preexisting native member is committed or differs")

    def exact(self, batch, expected):
        staged = self.pages(batch, "staged")
        if {h["name"]: h["script_pubkey"] for h in staged if not h["parked"]} != expected:
            raise Refused("native staged set differs from frozen members")
        for name, script in expected.items():
            row = self.handle(batch, name)
            if row["script_pubkey"] != script or row["commitment_root"] is not None or row["parked"]:
                raise Refused("native staged member differs")

    def committed(self, batch, expected, root):
        for name, script in expected.items():
            row = self.handle(batch, name)
            if row["script_pubkey"] != script or row["commitment_root"] != root or row["parked"]:
                raise Refused("local commitment member differs; reconciliation required")
        all_root = [h for h in self.pages(batch, "committed") if h["commitment_root"] == root]
        row = pipeline(self.c.subs_read.get(f"/spaces/{batch['space']}/pipeline"))
        if len(all_root) != len(expected) or {h["name"]: h["script_pubkey"] for h in all_root if not h["parked"]} != expected or \
                any(h["name"] in expected for h in self.pages(batch, "staged")) or row.get("root") != root or \
                row.get("txid") is not None or row.get("has_pending") is not True:
            raise Refused("complete local commitment readback differs; reconciliation required")
