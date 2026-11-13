"""TypeScript registry commitment observations. No signing or broadcast path."""
import re

from .errors import Refused

FINAL_D = 150
ANCHOR_FINALITY = 144  # libveritas: newest anchor - commitment height
WATCHED = ("broadcast", "broadcast_uncertain", "mined")


class CommitmentTracking:
    def certificate_status(self, bid):
        """"verified" needs d >= 150 and a root anchor 144 past the commitment;
        "awaiting_anchor" in between; "not_final" otherwise."""
        b = self.batch(bid)
        if b["state"] != "final":
            return "not_final"
        if getattr(self.registry, "bound_entries", False):
            current = self.registry.commitment_status(b)
            if not current["acknowledged"]:
                return "observation_unconfirmed"
            observed = current.get("observation")
            if not observed or observed["phase"] != "final":
                return "not_final"
            if not observed["covered"]:
                return "awaiting_anchor"
            verified = all(self.registry.order(m)["status"] in ("ready", "fulfilled") and self.registry.journal_ok(m) for m in b["members"])
            return "verified" if verified else "awaiting_certificate_verification"
        newest = self.root_anchors()[0]["block"]["height"]
        return "verified" if newest - b["mined_height"] >= ANCHOR_FINALITY else "awaiting_anchor"

    def watch(self, bid):
        self.require_postsend(bid)
        """Move a batch along with the chain, including loss of finality."""
        if getattr(self.registry, "bound_entries", False):
            return self.watch_bound(bid)
        self.wait_synced()
        self.capture_bytes(bid)
        b = self.batch(bid)
        state = b["state"]
        if state not in WATCHED + ("final",) or not b["txid"]:
            return state
        pos = self.tx_position(b["txid"])
        onchain = self.onchain_commitment(b["space"], b["root"])
        if state == "final" and (pos is None or pos[1] < FINAL_D):
            new = "mined" if pos else "broadcast"
            self._save(bid, state=new, mined_height=pos[0] if pos else None)
            self.alert("finality_lost", bid, f"position {pos}")
            for m in b["members"]:
                if self.registry.order(m)["status"] == "ready":
                    self.registry.unready(m)
            return new
        if pos and pos[1] >= FINAL_D and onchain:
            self._save(bid, state="final", mined_height=pos[0])
            return "final"
        if pos:
            if state != "mined":
                self._save(bid, state="mined", mined_height=pos[0])
            return "mined"
        if state == "mined":
            self._save(bid, state="broadcast", mined_height=None)
            return "broadcast"
        return state

    def _commitment_observation(self, b):
        """Retry observations spanning a changing Core/spaced tip. The store
        independently compares the report with its coherent payment tip."""
        for _ in range(3):
            start = self.btc.call("getblockchaininfo")
            tip, tip_hash = start["blocks"], start["bestblockhash"]
            if not isinstance(tip, int) or isinstance(tip, bool) or tip < 0 or not isinstance(tip_hash, str) or \
                    not re.fullmatch(r"[0-9a-f]{64}", tip_hash):
                raise Refused("invalid commitment observation tip")
            if self.spaced.call("getserverinfo")["tip"]["hash"] != tip_hash:
                continue
            pos = self.tx_position(b["txid"])
            root = self.onchain_commitment(b["space"], b["root"])
            anchors = self.root_anchors()
            end = self.btc.call("getblockchaininfo")
            if (end["blocks"], end["bestblockhash"]) != (tip, tip_hash) or \
                    self.spaced.call("getserverinfo")["tip"]["hash"] != tip_hash or \
                    (pos and pos[1] != tip - pos[0]):
                continue
            height = pos[0] if pos else None
            return {"txid": b["txid"], "tipHeight": tip, "tipHash": tip_hash,
                    "minedHeight": height,
                    "rootHeight": height if height is not None and root and root.get("state_root") == b["root"]
                    and root.get("block_height") == height else None,
                    "anchorHeight": anchors[0]["block"]["height"] if anchors else None}
        raise Refused("Core/spaced changed during commitment observation; retry")

    def watch_bound(self, bid):
        self.require_postsend(bid)
        self.wait_synced()
        self.capture_bytes(bid)
        b = self.batch(bid)
        if b["state"] not in ("broadcast", "broadcast_uncertain", "mined", "final", "superseded") or not b["txid"]:
            return b["state"]
        if self.supersession_progress(b) == "superseded":
            return "superseded"
        b = self.batch(bid)
        if not b.get("entry_key") or not b["attempted"] or not b["intent"]:
            raise Refused("commitment has no bound attempted intent")
        current = self.registry.commitment_status(b)
        if not current["acknowledged"]:
            raise Refused("commitment history not currently acknowledged; watch withheld")
        facts = self._commitment_observation(b)
        # Unlike a first-send intent this report is safe to repeat. Persist
        # the exact binding and revision before contacting the store.
        self.journal.append("commitment_observation", bid=bid, entry_key=b["entry_key"],
                            root=b["root"], members=b["members"], delegate=b["delegate_in"],
                            expected_revision=current["revision"], observation=facts)
        receipt = self.registry.report_commitment(b, current["revision"], facts)
        if not receipt["acknowledged"]:
            raise Refused("commitment observation not acknowledged; controller progress withheld")
        phase = receipt["observation"]["phase"]
        statements = [("update batches set state=?,mined_height=? where bid=?", (phase, facts["minedHeight"], bid))]
        if b["state"] == "final" and phase != "final":
            statements.append(("insert into alerts(kind,bid,detail) values('finality_lost',?,?)",
                               (bid, f"commitment phase {phase} at {facts['tipHash']}")))
        self._atomically(*statements)
        if not self._journal(bid):
            raise Refused("controller commitment progress not acknowledged; retry watch")
        return phase
