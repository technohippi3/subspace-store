"""Read/reconcile known bound entries; never broadcast or release a name."""
from .errors import Refused


class BoundRecovery:
    def reconcile_bound(self):
        self._require_preparation_idle()
        if not getattr(self.registry, "offline_recovery", False):
            raise Refused("TypeScript recovery requires the store-owned offline reconcile command")
        log = []
        inventory = self.registry.inventory
        entries = self.registry.entries
        for b in self.batches():
            e = entries.get(b.get("entry_key"))
            if e:
                self.registry.entry_status(b)
                if e["delegate"] and b["delegate_in"] and e["delegate"] != b["delegate_in"]:
                    raise Refused("controller/store delegate differs")
                if e["superseded"]:
                    if not self._save(b["bid"], state="superseded", mined_height=None):
                        raise Refused("controller supersession acknowledgment unavailable")
                elif e["closed"]:
                    if not self._save(b["bid"], state="rebuilt"):
                        raise Refused("controller closure acknowledgment unavailable")
                elif e["delegate"]:
                    known = e["txid"] or b["txid"]
                    if not known:
                        # A one-use arm is evidence of a possible send. An
                        # empty mempool or stale local attempted flag isn't.
                        raise Refused("armed transaction unknown; readback/manual recovery required")
                    if b["txid"] and e["txid"] and b["txid"] != e["txid"]:
                        raise Refused("controller/store transaction differs")
                    if not self._save(b["bid"], state="broadcast", txid=known, intent=1, attempted=1, delegate_in=e["delegate"]):
                        raise Refused("controller transaction adoption not acknowledged")
                elif b["intent"] or b["attempted"] or not self.subs_holds(b):
                    raise Refused("open entry has an attempted intent or missing local tree; manual recovery required")
            elif b["state"] not in ("frozen", "staged", "rebuilt", "superseded"):
                raise Refused("controller batch has no bound store entry; manual recovery required")
            log.append((b["bid"], "bound history retained; no transaction sent"))
        for e in inventory["entries"]:
            matches = [b for b in self.batches() if b.get("entry_key") == e["entry"]]
            if len(matches) != 1 and not e["closed"]:
                raise Refused("store entry lacks one controller batch; manual recovery required")
        for o in inventory["orders"]:
            if o["status"] in ("issuing", "ready", "fulfilled") and not any(o["id"] in e["oids"] for e in inventory["entries"]):
                raise Refused("unbound issuance history needs manual recovery")
        return log

    def bound_statement(self):
        self._require_preparation_idle()
        i = self.registry.inventory
        start = self.btc.call("getblockchaininfo")
        if (start["blocks"], start["bestblockhash"]) != (i["tipHeight"], i["tipHash"]):
            raise Refused("store/controller recovery tips differ; retry")
        wallet = self.spaced.call("walletgetinfo", self.operator_wallet)
        if wallet.get("tip") != i["tipHeight"]:
            raise Refused("operator wallet is not synced at the recovery tip")
        known = set()
        for page in range(1000):
            transactions = self.spaced.call("walletlisttransactions", self.operator_wallet, 100, page * 100)
            if not isinstance(transactions, list):
                raise Refused("operator wallet history is malformed")
            known.update(tx["txid"] for tx in transactions)
            if len(transactions) < 100:
                break
        else:
            raise Refused("operator wallet history exceeds recovery inspection limit")
        rows = []
        for e in i["entries"]:
            mode = "closed" if e["closed"] else "superseded" if e["superseded"] else "observed" if e["delegate"] else "unsent"
            facts = None
            wallet_txid = e["conflictTxid"] if mode == "superseded" else None
            if mode == "observed":
                b = next(b for b in self.batches() if b.get("entry_key") == e["entry"])
                if b["raw"] and self.btc.call("decoderawtransaction", b["raw"])["txid"] != b["txid"]:
                    raise Refused("archived controller transaction identity differs")
                # A lookup error is unknown, never absence or permission.
                tx = self.btc.call("getrawtransaction", b["txid"], True)
                if tx.get("blockhash"):
                    header = self.btc.call("getblockheader", tx["blockhash"])
                    if header["confirmations"] < 1:
                        raise Refused("original transaction is not active; locks retained")
                else:
                    self.btc.call("getmempoolentry", b["txid"])
                facts = self._commitment_observation(b)
                wallet_txid = facts["txid"]
                if facts["minedHeight"] is not None and facts["rootHeight"] != facts["minedHeight"]:
                    raise Refused("mined commitment is not included by Spaces; recovery waits")
                if (facts["tipHeight"], facts["tipHash"]) != (i["tipHeight"], i["tipHash"]):
                    raise Refused("commitment recovery tip changed")
                phase = "broadcast" if facts["minedHeight"] is None else "final" if facts["rootHeight"] == facts["minedHeight"] and i["tipHeight"] - facts["minedHeight"] >= 150 else "mined"
                if not self._save(b["bid"], state=phase, mined_height=facts["minedHeight"]):
                    raise Refused("controller observation not acknowledged")
            if wallet_txid is not None and wallet_txid not in known:
                raise Refused("operator wallet does not yet know a pending or settled spend; recovery waits")
            rows.append(dict(entry=e["entry"], root=e["root"], space=e["space"], oids=e["oids"], delegate=e["delegate"], mode=mode, walletTxid=wallet_txid, observation=facts))
        spaces = []
        for space in i["spaces"]:
            pipe = self.subs_read.get(f"/spaces/{space}/pipeline") or {}
            chain = self.onchain_commitment(space)
            root, chain_root = pipe.get("root"), chain["state_root"] if chain else None
            matches = [b for b in self.batches(space) if b["root"] == root and root and b["state"] not in ("rebuilt", "superseded")]
            last = matches[-1] if matches else None
            ahead = None
            if root != chain_root:
                if not last or last["prior_root"] != chain_root or not last.get("entry_key"):
                    raise Refused("restored subs tree does not match the chain or a known pending entry")
                ahead = last["entry_key"]
            if last:
                for oid in last["members"]:
                    order = self.registry.order(oid)
                    info = self.handle(space, order["name"].split("@")[0])
                    if not info or info.get("commitment_root") != root or info.get("script_pubkey") != order["recipient_spk"]:
                        raise Refused("restored subs name/recipient binding differs")
            if last and last["txid"] and pipe.get("txid") != last["txid"]:
                if root != chain_root or not self.capabilities.attach_txid:
                    raise Refused("subs requires a known mined transaction attachment; recovery waits")
                self.journal.append("recovery_attach_txid", bid=last["bid"], txid=last["txid"])
                self.subs.post(f"/spaces/{space}/commit/txid", {"txid": last["txid"]})
                pipe = self.subs_read.get(f"/spaces/{space}/pipeline") or {}
                if pipe.get("root") != root or pipe.get("txid") != last["txid"]:
                    raise Refused("subs did not retain the verified transaction attachment")
            spaces.append(dict(space=space, subsRoot=root, chainRoot=chain_root, subsTxid=pipe.get("txid"), ahead=ahead))
        end = self.btc.call("getblockchaininfo")
        if end["bestblockhash"] != i["tipHash"] or self.spaced.call("getserverinfo")["tip"]["hash"] != i["tipHash"]:
            raise Refused("recovery chain changed; retry")
        return {**{k:i[k] for k in ("version", "store", "sourceSequence", "sequence", "tipHeight", "tipHash")}, "entries": rows, "spaces": spaces}
