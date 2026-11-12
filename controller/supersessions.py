"""Observe an owner-selected, already settled conflict. Never create or send it."""
import re

from .errors import Refused


class SupersessionTracking:
    def supersession_progress(self, b):
        status = self.registry.supersession_status(b)
        if not status["acknowledged"]:
            raise Refused("supersession history not acknowledged; progress withheld")
        proof = status["proof"]
        if proof and proof["active"]:
            if not self._save(b["bid"], state="superseded", mined_height=None):
                raise Refused("controller supersession not acknowledged; retry")
            return "superseded"
        if proof and b["state"] == "superseded":
            self._atomically(
                ("update batches set state='broadcast',mined_height=null where bid=?", (b["bid"],)),
                ("insert into alerts(kind,bid,detail) values('supersession_reversed',?,?)", (b["bid"], proof["conflictTxid"])))
        if proof and not self._journal(b["bid"]):
            raise Refused("supersession reversal not acknowledged; retry")
        if status["conflicted"]:
            raise Refused("supersession reversal has conflicting or cancelled members; manual recovery required")
        return None

    def _supersession_facts(self, b, conflict):
        if not isinstance(conflict, str) or not re.fullmatch(r"[0-9a-f]{64}", conflict) or conflict == b["txid"] or not b["raw"]:
            raise Refused("supersession needs different conflict and journaled original bytes")
        for _ in range(3):
            start = self.btc.call("getblockchaininfo")
            tip, tip_hash = start["blocks"], start["bestblockhash"]
            if type(tip) is not int or tip < 0 or not isinstance(tip_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", tip_hash):
                raise Refused("invalid supersession tip")
            if self.spaced.call("getserverinfo")["tip"]["hash"] != tip_hash:
                continue
            original = self.btc.call("decoderawtransaction", b["raw"])
            tx = self.btc.call("getrawtransaction", conflict, True)
            block = tx.get("blockhash")
            if not block:
                raise Refused("conflict is not mined; locks retained")
            header = self.btc.call("getblockheader", block)
            height, confirmations = header["height"], header["confirmations"]
            spends = lambda t: any(f"{i.get('txid')}:{i.get('vout')}" == b["delegate_in"] for i in t["vin"])
            if original["txid"] != b["txid"] or tx["txid"] != conflict or not spends(original) or not spends(tx):
                raise Refused("transactions do not conflict on the bound delegate")
            if not any(o.get("scriptPubKey", {}).get("hex", "").startswith("6a") and b["root"] in o["scriptPubKey"]["hex"] for o in original["vout"]):
                raise Refused("original transaction does not carry the bound root")
            if type(height) is not int or type(confirmations) is not int or height < 0 or confirmations < 6:
                raise Refused("conflict is not settled; locks retained")
            if self.btc.call("getblockhash", height) != block or self.onchain_commitment(b["space"], b["root"]) is not None:
                raise Refused("conflict is not active or Spaces still includes the old root")
            end = self.btc.call("getblockchaininfo")
            if (end["blocks"], end["bestblockhash"]) != (tip, tip_hash) or tip - height + 1 != confirmations or \
                    self.spaced.call("getserverinfo")["tip"]["hash"] != tip_hash:
                continue
            return dict(txid=b["txid"], originalRaw=b["raw"], conflictTxid=conflict, blockHash=block,
                        height=height, tipHeight=tip, tipHash=tip_hash)
        raise Refused("Core/spaced changed during supersession observation; retry")

    def record_supersession(self, bid, conflict):
        self.require_restored()
        if not getattr(self.registry, "bound_entries", False):
            raise Refused("bound supersession requires the TypeScript store")
        b = self.batch(bid)
        if b["state"] not in ("broadcast", "broadcast_uncertain", "mined", "final", "superseded") or not b["txid"] or not b["entry_key"]:
            raise Refused("supersession requires a known bound attempted transaction")
        self.wait_synced(); self.capture_bytes(bid); b = self.batch(bid)
        current = self.registry.supersession_status(b)
        if not current["acknowledged"]:
            raise Refused("supersession history not acknowledged")
        if current["proof"]:
            if current["proof"]["active"]:
                if current["proof"]["conflictTxid"] != conflict or self.supersession_progress(b) != "superseded":
                    raise Refused("proof identity changed or was revoked; reobserve before another decision")
                return current
        self.watch_bound(bid)
        b = self.batch(bid)
        observed = self.registry.commitment_status(b)
        proof = self._supersession_facts(b, conflict)
        if not observed["acknowledged"] or observed["observation"]["tipHash"] != proof["tipHash"] or observed["observation"]["minedHeight"] is not None:
            raise Refused("commitment evidence changed or remains on chain; locks retained")
        proof["revision"] = observed["revision"]
        self.journal.append("supersession_decision", bid=bid, entry_key=b["entry_key"], root=b["root"],
                            members=b["members"], delegate=b["delegate_in"], proof=proof)
        result = self.registry.accept_supersession(b, proof)
        if not result["acknowledged"] or not result["proof"]["active"]:
            raise Refused("supersession not acknowledged or was revoked; locks/progress retained")
        if self.supersession_progress(self.batch(bid)) != "superseded":
            raise Refused("supersession was revoked before controller completion")
        return result
