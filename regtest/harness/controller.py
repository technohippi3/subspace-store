"""The issuance controller against the real subs and spaced (regtest only).

A direct reading of the cycle in CONTROLLER-DESIGN.md draft 5, restricted to
what the scenarios exercise: freeze, stage with readback and parking, local
commit with readback, proving through subs' proving loop, the binding check,
the coordinated snapshot, the serialized `issuing` step with both journals
checked immediately before the one `/broadcast`, the uncertain-broadcast
rule, chain readback, finality at d >= 150 and its loss, and certificate
verification with libveritas.

It is harness code. Results from it are regtest results.
"""

import hashlib
import json
import shutil
import sqlite3
import subprocess
import time
import urllib.error
from pathlib import Path

from .journal import JournalDown
from .rpc import HttpError

FINAL_D = 150
ANCHOR_FINALITY = 144  # libveritas: newest anchor - commitment height
PREPARING = ("frozen", "staged", "committed_local", "proved", "checkpointed")
CLOSED = ("rebuilt", "final", "fulfilled", "superseded")
WATCHED = ("broadcast", "broadcast_uncertain", "mined")
LIVE = ("issuing", "broadcast", "broadcast_uncertain", "mined", "final")

SCHEMA = """
create table if not exists batches (
  bid text primary key, space text not null, members text not null,
  digest text not null, state text not null, prior_root text, root text,
  delegate_in text, fee_rate integer, txid text, mined_height integer,
  intent integer not null default 0, attempted integer not null default 0,
  supersedes text, answer text, raw text, recovery_paused integer not null default 0
);
create table if not exists alerts (n integer primary key, kind text, bid text, detail text);
"""


class Refused(Exception):
    pass


def label(handle):
    """subs stores and reports a handle by its label alone ("one" for
    "one@space")."""
    return handle.split("@", 1)[0]


class Paused(Exception):
    pass


class Controller:
    def __init__(self, db_path, journal, registry, stack, verifier_bin, workdir):
        self.db = sqlite3.connect(db_path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.journal = journal
        self.registry = registry
        self.stack = stack
        self.verifier_bin = verifier_bin
        self.workdir = Path(workdir)
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.snapshots = 0

    # Clients. Writes to subs go through the fault proxy, which can lose an
    # answer; readback goes direct.

    @property
    def subs(self):
        return self.stack.subs(via_proxy=True)

    @property
    def subs_read(self):
        return self.stack.subs()

    @property
    def spaced(self):
        return self.stack.spaced()

    @property
    def btc(self):
        return self.stack.btc()

    # Records

    def batch(self, bid):
        row = self.db.execute("select * from batches where bid = ?", (bid,)).fetchone()
        if row is None:
            raise Refused("no such batch")
        b = dict(row)
        b["members"] = json.loads(b["members"])
        return b

    def batches(self, space=None):
        rows = self.db.execute("select bid from batches order by rowid").fetchall()
        out = [self.batch(r["bid"]) for r in rows]
        return [b for b in out if space is None or b["space"] == space]

    def _save(self, bid, journal=True, **fields):
        sets = ", ".join(f"{k} = ?" for k in fields)
        self.db.execute(f"update batches set {sets} where bid = ?", (*fields.values(), bid))
        if journal:
            return self._journal(bid)
        return False

    def _journal(self, bid):
        try:
            self.journal.append("batch", batch=self.batch(bid))
            return True
        except JournalDown:
            return False

    def alert(self, kind, bid=None, detail=""):
        self.db.execute("insert into alerts(kind, bid, detail) values (?, ?, ?)", (kind, bid, detail))

    def alerts(self):
        return [dict(r) for r in self.db.execute("select kind, bid, detail from alerts order by n")]

    def acknowledged(self, bid):
        """The last acknowledged copy of a batch in the controller's journal."""
        last = None
        for e in self.journal.entries():
            if e["kind"] == "batch" and e["batch"]["bid"] == bid:
                last = e["batch"]
        return last

    # Chain views

    def root_anchors(self, attempts=20):
        """spaced's root anchors. spaced v0.5.0 rewrites its anchors file in
        place while getrootanchors reads it, so a read can see a truncated
        file (finding R15). Retry that error only."""
        from .rpc import RpcError
        for i in range(attempts):
            try:
                return self.spaced.call("getrootanchors")
            except RpcError as e:
                if "Could not read anchors file" not in str(e) or i == attempts - 1:
                    raise
                self.anchor_read_retries = getattr(self, "anchor_read_retries", 0) + 1
                time.sleep(0.25)

    def tip(self):
        return self.btc.call("getblockcount")

    def wait_synced(self, timeout=300):
        deadline = time.time() + timeout
        target = self.btc.call("getbestblockhash")
        while time.time() < deadline:
            info = self.spaced.call("getserverinfo")
            if info["tip"]["hash"] == target and info.get("ready", True):
                return
            time.sleep(0.5)
        raise TimeoutError("spaced did not reach the bitcoind tip")

    def live_delegate(self, space):
        """The delegate output, as spaced reports it: getdelegation gives the
        num id, getnum its current outpoint and whether it is spent."""
        num = self.spaced.call("getdelegation", space)
        out = self.spaced.call("getnum", num) if num else None
        if not out:
            return None
        return {"num": num, "outpoint": f"{out['txid']}:{out['n']}", "spent": out.get("spent")}

    def onchain_commitment(self, space, root=None):
        return self.spaced.call("getcommitment", space, root)

    def tx_position(self, txid):
        """(height, depth) of a transaction on the best chain, or None."""
        try:
            tx = self.btc.call("getrawtransaction", txid, True)
        except Exception:  # noqa: BLE001 - absent from the node
            return None
        if not tx.get("blockhash"):
            return None
        header = self.btc.call("getblockheader", tx["blockhash"])
        if header["confirmations"] < 1:
            return None
        return header["height"], self.tip() - header["height"]

    def mempool_spend_with_root(self, outpoint, root):
        """Look in the controller's own node's mempool for a transaction that
        spends the delegate output and carries the root."""
        txid, vout = outpoint.split(":")
        for t in self.btc.call("getrawmempool"):
            tx = self.btc.call("getrawtransaction", t, True)
            if any(i.get("txid") == txid and i.get("vout") == int(vout) for i in tx["vin"]):
                if root and root in json.dumps(tx["vout"]):
                    return t, "mempool"
                return t, "mempool_spend_without_root"
        return None

    def wallet_spend_with_root(self, outpoint, root):
        """The operator wallet's own transactions, as spaced lists them."""
        txid, vout = outpoint.split(":")
        found = []
        for t in self.spaced.call("walletlisttransactions", "wallet_99", 50, 0):
            raw = self.btc.call("getrawtransaction", t["txid"], True)
            if any(i.get("txid") == txid and i.get("vout") == int(vout) for i in raw["vin"]):
                found.append({"txid": t["txid"], "block_height": t.get("block_height"),
                              "root_seen": bool(root and root in json.dumps(raw["vout"])),
                              "events": t.get("events")})
        return found

    # Readback from subs

    def handles(self, space, filt):
        out, page = [], 1
        while True:
            r = self.subs_read.get(f"/spaces/{space}/handles?filter={filt}&page={page}&per_page=100")
            out.extend(r["handles"])
            if page >= max(1, r["total_pages"]):
                return out
            page += 1

    def handle(self, space, handle):
        return self.subs_read.get(f"/spaces/{space}/handles/{handle}")

    # 1. Freeze

    def freeze(self, space, members=None, supersedes=None):
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
        self.db.execute("""insert into batches(bid, space, members, digest, state, prior_root, supersedes)
                           values (?, ?, ?, ?, 'frozen', ?, ?)""",
                        (bid, space, json.dumps(sorted(chosen)), digest,
                         prior["state_root"] if prior else None, supersedes))
        self._journal(bid)
        return bid

    # 2. Stage

    def stage(self, bid):
        b = self.batch(bid)
        if b["state"] != "frozen":
            raise Refused("not frozen")
        space = b["space"]
        expected = {label(self.registry.order(m)["name"]): self.registry.order(m)["recipient_spk"]
                    for m in b["members"]}
        self.registry.set_pending(b["members"])
        sync = self.subs.post("/registry/sync")
        staged = self.handles(space, "staged")
        strays = [h["name"] for h in staged if not h["parked"] and h["name"] not in expected]
        if strays:
            self.subs.post(f"/spaces/{space}/park", {"handles": strays, "parked": True})
        # A member parked by an earlier rebuild is unparked; parking only
        # touches staged handles, so this can't reach a committed one.
        parked_members = [h["name"] for h in staged if h["parked"] and h["name"] in expected]
        if parked_members:
            self.subs.post(f"/spaces/{space}/park", {"handles": parked_members, "parked": False})
        if strays or parked_members:
            staged = self.handles(space, "staged")
        unparked = {h["name"]: h["script_pubkey"] for h in staged if not h["parked"]}
        if unparked != expected:
            raise Refused(f"staged readback mismatch: {unparked} != {expected}")
        self.registry.set_pending([])
        self._save(bid, state="staged")
        return {"sync": sync, "staged": unparked, "parked": strays}

    # 3. Local commit

    def commit_local(self, bid):
        b = self.batch(bid)
        if b["state"] != "staged":
            raise Refused("not staged")
        space = b["space"]
        self.journal.append("commit_local_intent", bid=bid, space=space)
        result = self.subs.post(f"/spaces/{space}/commit", {})
        root = result["root"]
        for m in b["members"]:
            info = self.handle(space, label(self.registry.order(m)["name"]))
            if info["commitment_root"] != root:
                raise Refused(f"member {m} readback root {info['commitment_root']} != {root}")
        still = {h["name"] for h in self.handles(space, "staged")}
        if still & {label(self.registry.order(m)["name"]) for m in b["members"]}:
            raise Refused("a member is still staged after the local commit")
        self._save(bid, state="committed_local", root=root)
        return result

    # 4. Prove

    def prove(self, bid, timeout=6 * 3600, poll=5):
        b = self.batch(bid)
        if b["state"] != "committed_local":
            raise Refused("not committed locally")
        space = b["space"]
        started = time.time()
        last = None
        pushes = []
        while time.time() - started < timeout:
            p = self.subs_read.get(f"/spaces/{space}/pipeline")
            last = p
            if p["steps"]["proving"] in ("complete", "skipped") and p.get("pending_proofs", 0) == 0:
                self._save(bid, state="proved")
                return {"seconds": round(time.time() - started, 1),
                        "proving": p["steps"]["proving"], "proof_total": p.get("proof_total"),
                        "pushes": pushes}
            if not p.get("proving_job_active"):
                # subs' proving loop only polls jobs already in flight; a new
                # proof is submitted through /proving/push (finding R12).
                # Proving has no on-chain effect.
                self.journal.append("prove_push", bid=bid, proof_index=p.get("proof_index"))
                r = self.subs.post(f"/spaces/{space}/proving/push")
                pushes.append({"t": round(time.time() - started, 1),
                               "proof_index": p.get("proof_index"), "job_id": r.get("job_id"),
                               "message": r.get("message")})
            time.sleep(poll)
        raise TimeoutError(f"proving did not finish: {last}")

    # 6. Binding check

    def failing(self, bid, recheck_issuing=False):
        b = self.batch(bid)
        self.registry.observe()
        if recheck_issuing:
            return [m for m in b["members"] if not self.registry.issuing_recheck_ok(m)]
        return [m for m in b["members"] if not self.registry.batch_entry_ok(m)]

    # 7. Checkpoint: the coordinated snapshot

    def checkpoint(self, bid):
        b = self.batch(bid)
        if b["state"] != "proved":
            raise Refused("not proved")
        snap = self.snapshot(label=bid)
        self._save(bid, state="checkpointed")
        return snap

    def snapshot(self, label):
        """Stop subs, copy its data directory, back up both databases with
        SQLite's backup API, record the journal positions, start subs."""
        self.snapshots += 1
        dest = Path(self.journal.dir) / "snapshots" / f"{self.snapshots:03d}-{label}"
        dest.mkdir(parents=True)
        self.stack.stop_process("subs")
        shutil.copytree(self.stack.subs_dir, dest / "subs")
        for name, conn in (("registry.db", self.registry.db), ("controller.db", self.db)):
            out = sqlite3.connect(dest / name)
            conn.backup(out)
            out.close()
        manifest = {"label": label,
                    "store_journal": self.registry.journal.position(),
                    "controller_journal": self.journal.position(),
                    "files": {}}
        for f in sorted(dest.rglob("*")):
            if f.is_file():
                manifest["files"][str(f.relative_to(dest))] = hashlib.sha256(f.read_bytes()).hexdigest()
        (dest / "manifest.json").write_text(json.dumps(manifest, indent=1))
        # Confirm each object against its source digest where the source still
        # exists unchanged (subs is stopped, so its files are stable).
        mismatches = []
        for rel, digest in manifest["files"].items():
            if rel.startswith("subs/"):
                src = self.stack.subs_dir / rel[len("subs/"):]
                if hashlib.sha256(src.read_bytes()).hexdigest() != digest:
                    mismatches.append(rel)
        self.stack.start_subs()
        if mismatches:
            raise Refused(f"snapshot objects do not match: {mismatches}")
        return {"dir": str(dest), "objects": len(manifest["files"]),
                "store_journal": manifest["store_journal"],
                "controller_journal": manifest["controller_journal"]}

    # 8. Issue

    def issue(self, bid, fee_rate=1):
        """The binding check, the serialized `issuing` step, both journals, and
        one `/broadcast`. Returns the batch that went on (a rebuilt one if a
        member failed)."""
        b = self.batch(bid)
        if b["state"] != "checkpointed":
            raise Refused("not checkpointed")
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
        acked = self.acknowledged(b["bid"])
        if not acked or not acked["intent"]:
            return False
        if (acked["root"], acked["delegate_in"], acked["members"]) != \
                (b["root"], b["delegate_in"], b["members"]):
            return False
        return all(self.registry.acknowledged_status(m) == "issuing" for m in b["members"])

    def _send(self, bid):
        b = self.batch(bid)
        # The only path to the network for a commitment, checked immediately
        # before the call.
        if not self._issuance_acknowledged(b):
            raise Refused("order locks or broadcast intent not acknowledged off-host; not sent")
        self._save(bid, journal=False, attempted=1)
        try:
            answer = self.subs.post(f"/spaces/{b['space']}/broadcast",
                                    {"fee_rate": b["fee_rate"]}, timeout=600)
        except HttpError as e:
            # subs answered with an error. The wallet send may still have
            # happened (subs stores the txid only after the send returns), so
            # an error without a txid is not proof that nothing was sent.
            self._save(bid, state="broadcast_uncertain", answer=f"HTTP {e.status}: {e.body[:300]}")
            self.alert("broadcast_uncertain", bid, "error answer without txid")
            return
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as e:
            self._save(bid, state="broadcast_uncertain", answer=f"no answer: {type(e).__name__}")
            self.alert("broadcast_uncertain", bid, "no answer")
            return
        self._save(bid, state="broadcast", txid=answer["txid"], answer=json.dumps(answer))
        self.capture_bytes(bid)

    def resume(self, bid):
        b = self.batch(bid)
        if b["state"] != "issuing":
            raise Refused("nothing to resume")
        if b["attempted"]:
            raise Refused("the broadcast was attempted: the outcome is uncertain")
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

    def retry_broadcast(self, bid):
        raise Refused("never repeat a broadcast whose outcome is unknown")

    def rollback_local(self, bid):
        b = self.batch(bid)
        if b["state"] not in PREPARING or b["intent"] or b["attempted"]:
            raise Refused("never roll back a commitment that may have escaped")
        self.subs.post(f"/spaces/{b['space']}/rollback-local")
        self._save(bid, state="rebuilt")

    def rebuild_unsent(self, bid, failing):
        """A batch known never to have been sent: journal it as rebuilt, then
        return its members to paid, then roll back and continue without the
        failing members."""
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
        self.subs.post(f"/spaces/{b['space']}/rollback-local")
        self._save(bid, state="rebuilt")
        return self._new_without(b, failing)

    def _new_without(self, b, failing):
        space = b["space"]
        names = [label(self.registry.order(m)["name"]) for m in failing]
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

    # Uncertain broadcast: readback, never retried

    def readback(self, bid):
        b = self.batch(bid)
        if b["state"] != "broadcast_uncertain":
            return {"adopted": False, "reason": "not uncertain"}
        evidence = {
            "getcommitment": self.onchain_commitment(b["space"], b["root"]),
            "delegate_now": self.live_delegate(b["space"]),
            "mempool": self.mempool_spend_with_root(b["delegate_in"], b["root"]),
            "wallet": self.wallet_spend_with_root(b["delegate_in"], b["root"]),
            "subs_commit_status": self.subs_read.get(f"/spaces/{b['space']}/commit/status"),
        }
        txid = None
        if evidence["mempool"] and evidence["mempool"][1] == "mempool":
            txid = evidence["mempool"][0]
        for w in evidence["wallet"]:
            if w["root_seen"]:
                txid = txid or w["txid"]
        if txid:
            # Adopted in the controller's journal. subs itself has no way to
            # record it at the pinned commit (U1(b)).
            self._save(bid, state="broadcast", txid=txid, answer=json.dumps({"adopted": txid}))
            self.capture_bytes(bid)
        return {"adopted": bool(txid), "txid": txid, "evidence": evidence}

    # 10. Watch

    def capture_bytes(self, bid):
        """Journal the signed commitment as soon as the controller's node has
        it. Without a prepare/send split in subs (U1(c)) this is the earliest
        the bytes can be had."""
        b = self.batch(bid)
        if b["raw"] or not b["txid"]:
            return bool(b["raw"])
        try:
            raw = self.btc.call("getrawtransaction", b["txid"])
        except Exception:  # noqa: BLE001 - not known to the node
            return False
        self._save(bid, raw=raw)
        return True

    def commitment_seen(self, bid):
        b = self.batch(bid)
        if b["txid"] and (self.tx_position(b["txid"]) or b["txid"] in self.btc.call("getrawmempool")):
            return True
        return False

    def rebroadcast_commitment(self, bid):
        """Send the identical journaled bytes of a commitment that is in no
        mempool and not on the best chain. Without journaled bytes the
        recovery pauses for the owner. Never /broadcast."""
        b = self.batch(bid)
        if b["state"] not in ("broadcast", "broadcast_uncertain"):
            raise Refused("nothing to recover")
        if self.commitment_seen(bid):
            raise Refused("the commitment is still on the chain or in the mempool")
        acked = self.acknowledged(bid)
        if not b["raw"] or not acked or acked.get("raw") != b["raw"]:
            if not b["recovery_paused"]:
                self._save(bid, recovery_paused=1)
                self.alert("recovery_paused", bid)
            raise Refused("no journaled commitment bytes: recovery paused for the owner")
        if not self._issuance_acknowledged(self.batch(bid)):
            raise Refused("order locks or broadcast intent not acknowledged off-host; not sent")
        txid = self.btc.call("sendrawtransaction", b["raw"])
        self._save(bid, recovery_paused=0)
        return txid

    def certificate_status(self, bid):
        """"verified" needs d >= 150 and a root anchor 144 past the commitment;
        "awaiting_anchor" in between; "not_final" otherwise."""
        b = self.batch(bid)
        if b["state"] != "final":
            return "not_final"
        newest = self.root_anchors()[0]["block"]["height"]
        return "verified" if newest - b["mined_height"] >= ANCHOR_FINALITY else "awaiting_anchor"

    def watch(self, bid):
        """Move a batch along with the chain, including loss of finality."""
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

    # 11. Certificates

    def verify_certificates(self, bid):
        """Fetch each member's certificate message from subs, read the root
        anchors from spaced directly, verify with libveritas, and compare
        handle, script_pubkey and root with the batch record."""
        b = self.batch(bid)
        if b["state"] != "final":
            raise Refused("not final")
        anchors = self.root_anchors()
        newest = anchors[0]["block"]["height"] if anchors else 0
        if newest - b["mined_height"] < ANCHOR_FINALITY:
            # d >= 150 by the tip, but no root anchor covers the commitment
            # yet, so libveritas would answer "pending" (finding R11).
            raise Refused(f"no anchor covers the commitment yet (newest {newest}, "
                          f"mined {b['mined_height']})")
        # Numbered from what is on disk, so a controller reopened after a
        # restore never reuses a verification's directory.
        n = len([d for d in self.workdir.iterdir() if d.is_dir()]) + 1
        out_dir = self.workdir / f"{n:03d}-{bid}"
        out_dir.mkdir(parents=True)
        anchors_path = out_dir / "anchors.json"
        anchors_path.write_text(json.dumps(anchors))
        results = {}
        for m in b["members"]:
            o = self.registry.order(m)
            handle = o["name"]
            msg = self.subs_read.get(f"/certs/{handle}/message", raw=True)
            msg_path = out_dir / f"{handle}.message.bin"
            msg_path.write_bytes(msg)
            proc = subprocess.run([str(self.verifier_bin), str(msg_path), str(anchors_path)],
                                  capture_output=True, text=True)
            (out_dir / f"{handle}.libveritas.json").write_text(proc.stdout + proc.stderr)
            out = json.loads(proc.stdout or "{}") if proc.stdout.strip().startswith("{") else \
                {"verified": False, "error": proc.stderr[-500:]}
            zones = out.get("zones", [])
            zone = next((z for z in zones if z["handle"] == handle), None)
            # The handle's zone proves inclusion; the committed root and its
            # height are on the space's zone in the same verified message.
            space_zone = next((z for z in zones if z["handle"] == b["space"]), None)
            checks = {
                "verified": out.get("verified", False),
                "handle": zone is not None,
                "script_pubkey": bool(zone and zone["script_pubkey"] == o["recipient_spk"]),
                "root": bool(space_zone and space_zone["commitment_root"] == b["root"]),
                "root_height": bool(space_zone and space_zone["commitment_height"] == b["mined_height"]),
                "sovereign": bool(zone and zone["sovereignty"] == "sovereign"),
            }
            ok = all(checks.values())
            results[m] = {"handle": handle, "ok": ok, "checks": checks, "zone": zone,
                          "artifacts": str(out_dir),
                          "space_zone": space_zone,
                          "error": out.get("error"), "message_bytes": len(msg)}
            if ok and o["status"] == "issuing":
                self.registry.mark_ready(m)
            if not ok:
                self.alert("certificate_failed", bid, handle)
        return results

    # Restore and reconciliation (CONTROLLER-DESIGN.md, "Restore and
    # reconciliation"), from the restored snapshot plus the journal.

    def restore_from_journal(self):
        latest = {}
        for e in self.journal.entries():
            if e["kind"] == "batch":
                latest[e["batch"]["bid"]] = e["batch"]
        self.db.execute("delete from batches")
        for row in latest.values():
            row = dict(row)
            row["members"] = json.dumps(row["members"])
            cols = ", ".join(row)
            self.db.execute(f"insert into batches({cols}) values ({', '.join('?' for _ in row)})",
                            tuple(row.values()))
        log = []
        orders = {r["oid"]: r["status"] for r in self.registry.db.execute("select oid, status from orders")}
        for b in self.batches():
            bid = b["bid"]
            if b["state"] in PREPARING and any(m not in orders for m in b["members"]):
                self._save(bid, state="rebuilt")
                log.append((bid, "rebuilt: a member is missing from the restored registry"))
                continue
            if b["state"] == "issuing" and b["intent"]:
                # A journaled intent without a recorded answer: the call may
                # have happened before the host was lost.
                self._save(bid, state="broadcast_uncertain", attempted=1)
                log.append((bid, "journaled intent without an answer: broadcast_uncertain"))
            elif b["state"] in WATCHED + ("final",):
                self._save(bid, journal=False, attempted=1)
            b = self.batch(bid)
            if b["state"] not in ("rebuilt", "superseded") and (
                    b["intent"] or b["state"] in WATCHED + ("final",)):
                for m in b["members"]:
                    if self.registry.order(m)["status"] == "converted":
                        self.registry.restore_issuing(m)
                        log.append((m, "marked issuing again before anything else"))
        live = {m for b in self.batches() if b["state"] in LIVE for m in b["members"]}
        for oid, status in orders.items():
            if oid in live:
                continue
            if status == "ready":
                self.registry.unready(oid)
                status = "issuing"
            if status == "issuing":
                self.registry.unissue(oid)
                log.append((oid, "issuing with no live batch: paid again"))
        for b in self.batches():
            if b["state"] == "broadcast_uncertain":
                log.append((b["bid"], f"readback: {self.readback(b['bid'])['adopted']}"))
        return log
