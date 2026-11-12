"""The issuance controller against the real subs, spaced and Bitcoin Core.

A direct reading of the cycle in CONTROLLER-DESIGN.md draft 5, restricted to
what the regtest scenarios exercise: freeze, stage with readback and
parking, local commit with readback, proving through subs' proving loop, the
binding check, the coordinated snapshot, the serialized `issuing` step with
both journals checked immediately before the one `/broadcast`, the
uncertain-broadcast rule, chain readback, finality at d >= 150 and its loss,
and certificate verification with libveritas.

It holds no address, path, wallet name or process of its own: the caller
gives it clients, the `subs` process control, the operator wallet's name
and what the running `subs` can do (`Capabilities`). The regtest harness
gives it the harness stack (`regtest/harness/controller.py`); the runner
gives it a host configuration (`controller/host.py`). Nothing here depends
on the network; mainnet in the runner requires the explicit private test.
Results from it are regtest results until it has run anywhere else.
"""

import hashlib
import json
import shutil
import sqlite3
import time
import urllib.error
from pathlib import Path

from .journal import JournalDown
from .locking import LockedConnection
from .rpc import HttpError
from .errors import Refused
from .issuance import ANSWER_LIMIT, Issuance
from .rebuild import PREPARING, Rebuild
from .commitments import ANCHOR_FINALITY, FINAL_D, WATCHED, CommitmentTracking
from .certificates import CertificateVerification
from .supersessions import SupersessionTracking
from .bound_recovery import BoundRecovery
from .rebuild_guard import RebuildGuard

COMMITTED_UNSENT = ("committed_local", "proved", "checkpointed")
CLOSED = ("rebuilt", "final", "fulfilled", "superseded")
LIVE = ("issuing", "broadcast", "broadcast_uncertain", "mined", "final")

SCHEMA = """
create table if not exists batches (
  bid text primary key, space text not null, members text not null,
  digest text not null, state text not null, prior_root text, root text,
  delegate_in text, fee_rate integer, txid text, mined_height integer,
  intent integer not null default 0, attempted integer not null default 0,
  supersedes text, answer text, raw text, recovery_paused integer not null default 0,
  ancestors text, entry_key text, release_failed text
);
create table if not exists alerts (n integer primary key, kind text, bid text, detail text);
create table if not exists recoveries (
  n integer primary key, snapshot text, restored_at real not null, subs_at real,
  replayed_at real, reconciled_at real, ready_at real
);
"""

# Columns added since the first released schema (commit 5226810), added to an
# existing database when it is opened: table -> {column: declaration}.
MIGRATIONS = {"batches": {"ancestors": "text", "entry_key": "text", "release_failed": "text"},
              "recoveries": {"snapshot": "text", "subs_at": "real", "replayed_at": "real",
                             "reconciled_at": "real", "ready_at": "real"}}

RESTORE_REQUIRED = ("restore required: the controller's journal holds batches this database "
                    "doesn't, or a restore hasn't finished replaying and reconciling them; "
                    "run restore")


def label(handle):
    """subs stores and reports a handle by its label alone ("one" for
    "one@space")."""
    return handle.split("@", 1)[0]


class Paused(Exception):
    pass


class Clients:
    """The controller's clients, each a function returning one. Writes to
    subs and readback from it may go to different addresses: the regtest
    harness sends writes through a fault proxy that can lose an answer, and
    reads directly."""

    def __init__(self, subs, subs_read, spaced, btc):
        self.subs, self.subs_read, self.spaced, self.btc = subs, subs_read, spaced, btc


class Capabilities:
    """What the running subs can do beyond the pinned commit.

    attach_txid: `POST /spaces/:space/commit/txid`, the U1(b) patch in
    `regtest/upstream/`. Without it, a later commitment restored without its
    txid blocks every further local commit of the space (R17): chain
    readback still adopts the transaction in the controller's journal, but
    subs can't be told, so issuance on that space can't continue. The
    operator gate needs another batch after a recovery, so a deployment needs
    this capability or another reviewed recovery procedure."""

    def __init__(self, attach_txid=False):
        self.attach_txid = bool(attach_txid)

    def as_dict(self):
        return {"attach_txid": self.attach_txid}


NO_ATTACH = ("subs has no /commit/txid route (U1(b)): the adopted txid can't be attached, so "
             "a later commitment restored without its txid blocks the space's next local "
             "commit (R17). Continued issuance needs the U1(b) capability or another "
             "reviewed recovery procedure")


class Controller(RebuildGuard, Issuance, Rebuild, CommitmentTracking, CertificateVerification, SupersessionTracking, BoundRecovery):
    def __init__(self, db_path, journal, registry, clients, subs_process, verifier_bin,
                 workdir, operator_wallet, capabilities=None, snapshot_dir=None,
                 ready_timeout=120):
        self.db = LockedConnection(db_path, check_same_thread=False, isolation_level=None)
        try:
            self.db.row_factory = sqlite3.Row
            self.db.executescript(SCHEMA)
            self._migrate()
            self.journal = journal
            self.recovery_backend = getattr(journal, "backend", None)
            self._rebuild_policy()  # Refuse malformed/unsupported policy history before serving.
            self.registry = registry
            self.clients = clients
            self.subs_process = subs_process
            self.verifier_bin = verifier_bin
            self.workdir = Path(workdir)
            self.workdir.mkdir(parents=True, exist_ok=True)
            self.operator_wallet = operator_wallet
            self.capabilities = capabilities or Capabilities()
            # Snapshots sit beside the controller's journal unless placed
            # elsewhere, so they leave with it when the host is lost.
            self.snapshot_dir = Path(snapshot_dir) if snapshot_dir else Path(journal.dir) / "snapshots"
            self.ready_timeout = ready_timeout
            self.snapshots = 0
            # Ownership is held before schema work or startup reconciliation.
            self.recovery_state()
            self._settle_interrupted()
        except BaseException:
            self.db.close()
            raise

    def close(self):
        self.db.close()

    def _migrate(self):
        """Add the columns a database from an earlier schema lacks. Each is
        nullable, so existing rows keep their values."""
        for table, columns in MIGRATIONS.items():
            have = {r["name"] for r in self.db.execute(f"pragma table_info({table})")}
            for name, decl in columns.items():
                if name not in have:
                    self.db.execute(f"alter table {table} add column {name} {decl}")

    # Clients

    @property
    def subs(self):
        return self.clients.subs()

    @property
    def subs_read(self):
        return self.clients.subs_read()

    @property
    def spaced(self):
        return self.clients.spaced()

    @property
    def btc(self):
        return self.clients.btc()

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
        place while getrootanchors reads it. A fresh host can also be at tip
        before that file exists. Retry only these bounded file errors."""
        from .rpc import RpcError
        for i in range(attempts):
            try:
                return self.spaced.call("getrootanchors")
            except RpcError as e:
                if not any(m in str(e) for m in ("Could not read anchors file", "Could not open anchors file")) or i == attempts - 1:
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
        for t in self.spaced.call("walletlisttransactions", self.operator_wallet, 50, 0):
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
        self.db.execute("""insert into batches(bid, space, members, digest, state, prior_root, supersedes)
                           values (?, ?, ?, ?, 'frozen', ?, ?)""",
                        (bid, space, json.dumps(sorted(chosen)), digest,
                         prior["state_root"] if prior else None, supersedes))
        self._journal(bid)
        return bid

    # 2. Stage

    def stage(self, bid):
        self.require_restored()
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
        self.require_restored()
        b = self.batch(bid)
        if b["state"] != "staged":
            raise Refused("not staged")
        space = b["space"]
        self.journal.append("commit_local_intent", bid=bid, space=space)
        result = self.subs.post(f"/spaces/{space}/commit", {})
        root = result["root"]
        on_root = 0
        for m in b["members"]:
            info = self.handle(space, label(self.registry.order(m)["name"]))
            if info["commitment_root"] != root:
                raise Refused(f"member {m} readback root {info['commitment_root']} != {root}")
            on_root += 1
        result["members_on_root"] = on_root
        still = {h["name"] for h in self.handles(space, "staged")}
        if still & {label(self.registry.order(m)["name"]) for m in b["members"]}:
            raise Refused("a member is still staged after the local commit")
        self._save(bid, state="committed_local", root=root)
        return result

    # 4. Prove

    def prove(self, bid, timeout=6 * 3600, poll=5):
        self.require_restored()
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
        self.require_restored()
        b = self.batch(bid)
        if b["state"] != "proved":
            raise Refused("not proved")
        snap = self.snapshot(label=bid)
        self._save(bid, state="checkpointed")
        return snap

    def _subs_stopped(self):
        """True only when a connection to subs is refused: nothing listens.
        Any HTTP answer, even an error, shows something is running; a
        timeout or another failure leaves the shutdown uncertain."""
        try:
            self.subs_read.get("/status", timeout=5)
        except ConnectionRefusedError:
            return True
        except urllib.error.URLError as e:
            return isinstance(e.reason, ConnectionRefusedError)
        except Exception:  # noqa: BLE001 - HTTP errors and timeouts: not stopped
            return False
        return False

    def _subs_ready(self):
        """True only when subs answers /status with a status."""
        try:
            return isinstance(self.subs_read.get("/status", timeout=5), dict)
        except Exception:  # noqa: BLE001 - not ready yet
            return False

    def _wait_subs_ready(self):
        deadline = time.time() + self.ready_timeout
        while time.time() < deadline:
            if self._subs_ready():
                return
            time.sleep(0.5)
        raise Refused(f"subs did not answer /status within {self.ready_timeout} s of its start; "
                      "nothing resumes")

    @staticmethod
    def snapshot_number(path):
        """A coordinated snapshot's sequence number, from its directory name
        `NNN-label`; -1 for anything else."""
        head = Path(path).name.split("-", 1)[0]
        return int(head) if head.isdigit() else -1

    def snapshot(self, label):
        """Stop subs, copy its data directory, back up both databases with
        SQLite's backup API, record the journal positions, start subs.

        subs must be stopped before anything is copied: the process control's
        stop returns only once the process has exited, and a connection to
        subs must then be refused. An HTTP answer of any kind, a timeout or
        any other failure leaves the shutdown unestablished, and nothing is
        copied. Work resumes only once subs answers /status with a status
        again after its start."""
        # Numbered from what is already there, so the latest is well defined
        # however many processes took them (each runner command is its own).
        self.snapshots += 1
        backend = getattr(self, "recovery_backend", None)
        if backend:
            n = max([0, *(self.snapshot_number(name) for name in backend.list_snapshots())])
        else:
            n = max((self.snapshot_number(d) for d in self.snapshot_dir.glob("*")), default=0) \
                if self.snapshot_dir.is_dir() else 0
        snapshot_name = f"{n + 1:03d}-{label}"
        if backend:
            import tempfile
            self.snapshot_dir.mkdir(parents=True, exist_ok=True)
            staging = Path(tempfile.mkdtemp(prefix="checkpoint-", dir=self.snapshot_dir))
            dest = staging / snapshot_name
        else:
            dest = self.snapshot_dir / snapshot_name
        dest.mkdir(parents=True)
        self.subs_process.stop()
        if not self._subs_stopped():
            raise Refused("subs' shutdown isn't established after its stop (it answered, "
                          "or the check timed out or failed); nothing was copied")
        subs_dir = Path(self.subs_process.data_dir)
        shutil.copytree(subs_dir, dest / "subs")
        for name, conn in (("registry.db", self.registry.db), ("controller.db", self.db)):
            out = sqlite3.connect(dest / name)
            conn.backup(out)
            if backend:
                # A self-contained backup must not create WAL/SHM files when
                # its exact prefix is read or after remote materialization.
                out.execute("pragma journal_mode=delete")
            out.close()
        if backend:
            from .recovery_backend import acknowledged_store_position, acknowledged_controller_position
            with sqlite3.connect((dest / "registry.db").resolve().as_uri() + "?mode=ro", uri=True) as db:
                store_position = acknowledged_store_position(db, backend, exact_head=False)
            with sqlite3.connect((dest / "controller.db").resolve().as_uri() + "?mode=ro", uri=True) as db:
                controller_position = acknowledged_controller_position(db, backend)
        else:
            store_position = self.registry.journal.position()
            controller_position = self.journal.position()
        manifest = {"label": label, "store_journal": store_position,
                    "controller_journal": controller_position, "files": {}}
        for f in sorted(dest.rglob("*")):
            if f.is_file():
                manifest["files"][str(f.relative_to(dest))] = hashlib.sha256(f.read_bytes()).hexdigest()
        (dest / "manifest.json").write_text(json.dumps(manifest, indent=1))
        # Confirm each object against its source digest where the source still
        # exists unchanged (subs is stopped, so its files are stable).
        mismatches = []
        for rel, digest in manifest["files"].items():
            if rel.startswith("subs/"):
                src = subs_dir / rel[len("subs/"):]
                if hashlib.sha256(src.read_bytes()).hexdigest() != digest:
                    mismatches.append(rel)
        if mismatches:
            raise Refused(f"snapshot objects do not match: {mismatches}")
        if backend:
            if not self._subs_stopped():
                raise Refused("subs restarted during checkpoint; nothing was acknowledged")
            from .recovery_backend import sync_snapshot
            sync_snapshot(dest)
            backend.upload_snapshot(dest, snapshot_name)
            if not self._subs_stopped():
                raise Refused("subs restarted before checkpoint acknowledgment; nothing resumes")
        self.subs_process.start()
        self._wait_subs_ready()
        root = Path(__file__).resolve().parents[1]
        shown = dest.relative_to(root) if dest.is_relative_to(root) else dest
        return {"dir": str(shown), "objects": len(manifest["files"]),
                "store_journal": manifest["store_journal"],
                "controller_journal": manifest["controller_journal"]}

    # Entry and send methods are inherited from controller.issuance.Issuance.

    def _atomically(self, *statements):
        """Several writes to this database in one SQLite transaction."""
        self.db.execute("begin immediate")
        try:
            for sql, args in statements:
                self.db.execute(sql, args)
        except BaseException:
            self.db.execute("rollback")
            raise
        self.db.execute("commit")

    def _uncertain(self, bid, answer, why):
        """The call may have reached the network and no txid came back: the
        batch is an uncertain broadcast, never sent again (CONTROLLER-DESIGN.md
        step 9). The state and its alert are committed together, so neither
        is ever left without the other; the journal entry follows, and if the
        journal can't take it now, a later opening journals it."""
        self._atomically(
            ("update batches set state = 'broadcast_uncertain', answer = ? where bid = ?",
             (answer, bid)),
            ("insert into alerts(kind, bid, detail) values (?, ?, ?)",
             ("broadcast_uncertain", bid, why)))
        self._journal(bid)

    # A batch's states once its commitment may have left the host.
    SENT = ("broadcast", "broadcast_uncertain", "mined", "final", "fulfilled", "superseded")

    def _settle_interrupted(self):
        """At every opening in normal operation, before anything else runs
        (A21, A22). Never while a restore is needed or under way: the
        journal is then the authority, and the replay decides.

        For each batch this database holds `issuing` or uncertain, against
        its latest journaled copy:
        - the journal holds it sent, in a later state than here: this
          database is behind its journal for it, which this controller's own
          writes never leave (the database is written first). It takes the
          journal's copy, and the owner is alerted (A22);
        - `issuing` with its broadcast attempted, journaled at most
          `issuing`: the controller stopped after the call and before
          recording an answer. It is an uncertain broadcast (A21);
        - uncertain here, journaled at most `issuing`: the journal was down
          or the controller stopped before the entry. It is journaled now,
          without another alert."""
        if self.recovery_state() is not None:
            return
        self._settle_checkpointed_entries()
        for r in self.db.execute("select bid from batches where state in "
                                 "('issuing', 'broadcast_uncertain') order by rowid").fetchall():
            b, acked = self.batch(r["bid"]), self.acknowledged(r["bid"])
            journaled = acked["state"] if acked else None
            behind = journaled in self.SENT and journaled != b["state"] and not (
                b["state"] == "broadcast_uncertain" and journaled == "broadcast_uncertain")
            if behind:
                self._adopt_journal_copy(acked)
            elif journaled in (None, "issuing"):
                if b["state"] == "issuing" and b["attempted"]:
                    self._uncertain(b["bid"], "interrupted: the controller stopped before "
                                              "recording an answer",
                                    "interrupted before an answer was recorded")
                elif b["state"] == "broadcast_uncertain":
                    self._journal(b["bid"])

    def _adopt_journal_copy(self, acked):
        """Replace a row this database is behind on with the journal's copy,
        and alert the owner, in one transaction (A22)."""
        row = dict(acked)
        row["members"] = json.dumps(row["members"])
        cols = ", ".join(row)
        self._atomically(
            ("delete from batches where bid = ?", (row["bid"],)),
            (f"insert into batches({cols}) values ({', '.join('?' for _ in row)})",
             tuple(row.values())),
            ("insert into alerts(kind, bid, detail) values (?, ?, ?)",
             ("database_behind_journal", row["bid"],
              f"held here as an older state; took the journal's {acked['state']}")))

    def retry_broadcast(self, bid):
        raise Refused("never repeat a broadcast whose outcome is unknown")

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
            # Adopted in the controller's journal. subs itself can be told
            # only with the U1(b) capability (`attach_txid`).
            self._save(bid, state="broadcast", txid=txid, answer=json.dumps({"adopted": txid}))
            self.capture_bytes(bid)
        return {"adopted": bool(txid), "txid": txid, "evidence": evidence}

    def attach_txid_value(self, bid, txid):
        """Ask subs to attach a given txid to the last commitment of the
        batch's space. Used to check that a wrong one is refused."""
        self.require_restored()
        if not self.capabilities.attach_txid:
            raise Refused(NO_ATTACH)
        b = self.batch(bid)
        self.journal.append("attach_txid_intent", bid=bid, space=b["space"], txid=txid, probe=True)
        return self.subs.post(f"/spaces/{b['space']}/commit/txid", {"txid": txid})

    def attach_txid(self, bid):
        """U1(b): tell subs the txid the readback adopted, so that its own
        status and its next local commit see it. Only through the
        `/commit/txid` route of the patch in `regtest/upstream/`; the pinned
        subs has no such route. It sends nothing."""
        self.require_restored()
        if not self.capabilities.attach_txid:
            raise Refused(NO_ATTACH)
        b = self.batch(bid)
        if not b["txid"]:
            raise Refused("no adopted txid to attach")
        self.journal.append("attach_txid_intent", bid=bid, space=b["space"], txid=b["txid"])
        answer = self.subs.post(f"/spaces/{b['space']}/commit/txid", {"txid": b["txid"]})
        self.journal.append("attach_txid_answer", bid=bid, answer=answer)
        return answer

    # 10. Watch

    def capture_bytes(self, bid):
        """Journal the signed commitment as soon as the controller's node has
        it. Without a prepare/send split in subs (U1(c)) this is the earliest
        the bytes can be had.

        The operator wallet funds a commitment from unconfirmed change, which
        can be another space's commitment still in flight. A node that knows
        neither, such as a fresh host's, refuses the commitment's own bytes
        for a missing input. So the bytes of every unconfirmed ancestor the
        node holds now are journaled with it, parents first."""
        b = self.batch(bid)
        if b["raw"] or not b["txid"]:
            return bool(b["raw"])
        try:
            raw = self.btc.call("getrawtransaction", b["txid"])
        except Exception:  # noqa: BLE001 - not known to the node
            return False
        self._save(bid, raw=raw, ancestors=json.dumps(self._unconfirmed_ancestors(b["txid"])))
        return True

    def _unconfirmed_ancestors(self, txid):
        """[(txid, raw)] of every unconfirmed transaction `txid` spends from,
        directly or not, parents before children, as the node has them."""
        out, seen = [], set()

        def visit(t):
            tx = self.btc.call("getrawtransaction", t, True)
            for vin in tx.get("vin", []):
                parent = vin.get("txid")
                if not parent or parent in seen:
                    continue
                seen.add(parent)
                try:
                    ptx = self.btc.call("getrawtransaction", parent, True)
                except Exception:  # noqa: BLE001 - unknown to the node
                    continue
                if ptx.get("blockhash") and ptx.get("confirmations", 1) > 0:
                    continue
                visit(parent)
                out.append([parent, ptx["hex"]])
        visit(txid)
        return out

    def commitment_seen(self, bid):
        b = self.batch(bid)
        if b["txid"] and (self.tx_position(b["txid"]) or b["txid"] in self.btc.call("getrawmempool")):
            return True
        return False

    def rebroadcast_commitment(self, bid):
        """Send the identical journaled bytes of a commitment that is in no
        mempool and not on the best chain. Without journaled bytes the
        recovery pauses for the owner. Never /broadcast."""
        self.require_restored()
        b = self.batch(bid)
        if b["state"] not in ("broadcast", "broadcast_uncertain"):
            raise Refused("nothing to recover")
        if getattr(self.registry, "bound_entries", False) and self.supersession_progress(b) is not None:
            raise Refused("commitment is safely superseded; rebroadcast refused")
        if self.commitment_seen(bid):
            raise Refused("the commitment is still on the chain or in the mempool")
        acked = self.acknowledged(bid)
        if not b["raw"] or not acked or acked.get("raw") != b["raw"]:
            self.pause_missing_commitment_bytes(bid)
            raise Refused("no journaled commitment bytes: recovery paused for the owner")
        if not self._issuance_acknowledged(self.batch(bid)):
            raise Refused("order locks or broadcast intent not acknowledged off-host; not sent")
        # Its unconfirmed ancestors first, each as journaled, unless the node
        # already has it. They are no new spend: each is the identical bytes
        # of a transaction that was sent before.
        if acked.get("ancestors") != b["ancestors"]:
            raise Refused("the ancestors' bytes aren't the journaled ones; nothing sent")
        pool = set(self.btc.call("getrawmempool"))
        for atxid, araw in json.loads(b["ancestors"] or "[]"):
            if atxid in pool or self.tx_position(atxid):
                continue
            self.btc.call("sendrawtransaction", araw)
        txid = self.btc.call("sendrawtransaction", b["raw"])
        self._save(bid, recovery_paused=0)
        return txid

    # 11. Certificates

    def _on_chain_at(self, space, root, height):
        try:
            c = self.onchain_commitment(space, root) if root else None
        except Exception:  # noqa: BLE001 - spaced has no such commitment
            c = None
        return bool(c and c.get("state_root") == root and c.get("block_height") == height)

    def root_gate(self, space, root, height):
        """A root a certificate or a relay's answer carries: a commitment of
        the space on the active chain at `height`, at d >= 150, with an
        anchor that covers it (L9, A19)."""
        tip = self.tip()
        newest = self.root_anchors()[0]["block"]["height"]
        out = {"on_chain": self._on_chain_at(space, root, height), "height": height,
               "depth": tip - height if height is not None else None, "newest_anchor": newest}
        out["final"] = out["on_chain"] and out["depth"] >= FINAL_D
        out["covered"] = out["on_chain"] and newest - height >= ANCHOR_FINALITY
        out["ok"] = out["final"] and out["covered"]
        return out

    # Restore and reconciliation (CONTROLLER-DESIGN.md, "Restore and
    # reconciliation"), from the restored snapshot plus the journal.

    def restore_from_journal(self):
        """Replay the journal into the batches table, in one transaction, then
        reconcile. A restore that was interrupted resumes: a replay that
        didn't commit left nothing and runs again; one that committed isn't
        repeated, and reconciliation, which is idempotent, runs again."""
        pending = self.restore_pending()
        if pending is None or not pending["replayed_at"]:
            self._replay(pending["n"] if pending else None)
        log = self._reconcile()
        if pending is not None:
            self.db.execute("update recoveries set reconciled_at = ? where n = ?",
                            (time.time(), pending["n"]))
        return log

    def _insert_batch(self, row):
        row = dict(row)
        row["members"] = json.dumps(row["members"])
        cols = ", ".join(row)
        self.db.execute(f"insert into batches({cols}) values ({', '.join('?' for _ in row)})",
                        tuple(row.values()))

    def _replay(self, recovery):
        """Every batch's latest journaled state, written whole or not at all,
        with the restore's replay recorded in the same transaction."""
        latest = {}
        for e in self.journal.entries():
            if e["kind"] == "batch":
                latest[e["batch"]["bid"]] = e["batch"]
        self.db.execute("begin immediate")
        try:
            self.db.execute("delete from batches")
            for row in latest.values():
                self._insert_batch(row)
            if recovery is not None:
                self.db.execute("update recoveries set replayed_at = ? where n = ?",
                                (time.time(), recovery))
            self.db.execute("commit")
        except BaseException:
            self.db.execute("rollback")
            raise

    def _reconcile(self):
        if getattr(self.registry, "bound_entries", False):
            return self.reconcile_bound()
        log = []
        orders = {r["oid"]: r["status"] for r in self.registry.db.execute("select oid, status from orders")}
        for b in self.batches():
            bid = b["bid"]
            if b["state"] in PREPARING and any(m not in orders for m in b["members"]):
                self._save(bid, state="rebuilt")
                log.append((bid, "rebuilt: a member is missing from the restored registry"))
                continue
            if b["state"] in COMMITTED_UNSENT and not self.subs_holds(b):
                # The snapshot predates the local commitment, and no
                # broadcast intent follows it: nothing escaped. Redo it
                # from step 2; its members are still paid.
                self._save(bid, state="rebuilt")
                log.append((bid, "rebuilt: the restored subs doesn't hold its local commitment "
                                 "(the snapshot predates it); its members stay paid"))
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

    # Readiness after a restore (CONTROLLER-DESIGN.md, "Restore and
    # reconciliation", step 4): what still waits before a new commitment may
    # be sent.

    def subs_holds(self, b):
        """Whether subs holds the batch's local commitment: every member
        read back on the batch's root. A handle subs doesn't know, or one
        on another root or none, means it doesn't."""
        if not b["root"]:
            return False
        for m in b["members"]:
            try:
                info = self.handle(b["space"], label(self.registry.order(m)["name"]))
            except HttpError as e:
                if e.status == 404:
                    return False
                raise
            if not info or info.get("commitment_root") != b["root"]:
                return False
        return True

    def missing_batches(self):
        """Batches the journal holds that this database doesn't."""
        journaled = {e["batch"]["bid"] for e in self.journal.entries() if e["kind"] == "batch"}
        have = {r["bid"] for r in self.db.execute("select bid from batches")}
        return sorted(journaled - have, key=lambda b: (len(b), b))

    def restore_pending(self):
        """The latest restore, while it hasn't yet been found ready."""
        row = self.db.execute("select * from recoveries order by n desc limit 1").fetchone()
        return dict(row) if row and row["ready_at"] is None else None

    def recovery_state(self):
        """None in normal operation; otherwise where a restore stands:
        "required" (not replayed), "incomplete" (replayed, not reconciled)
        or "reconciling" (reconciled, not yet found ready). A database that
        lacks batches its journal holds needs a restore, and that is
        recorded here, before anything else can write, so it survives a
        restart. It is never cleared but by a restore."""
        pending = self.restore_pending()
        if self.missing_batches() and (pending is None or pending["replayed_at"]):
            self.db.execute("insert into recoveries(restored_at) values (?)", (time.time(),))
            pending = self.restore_pending()
        if pending is None:
            return None
        if not pending["replayed_at"]:
            return "required"
        if not pending["reconciled_at"]:
            return "incomplete"
        return "reconciling"

    def require_restored(self):
        """Normal writes wait until a restore has replayed and reconciled."""
        if self.recovery_state() in ("required", "incomplete"):
            raise Refused(RESTORE_REQUIRED)

    def mark_subs_restored(self, snapshot):
        self.db.execute("update recoveries set snapshot = ?, subs_at = ? where n = ?",
                        (snapshot, time.time(), self.restore_pending()["n"]))

    def mark_recovered(self):
        if self.recovery_state() == "reconciling":
            self.db.execute("update recoveries set ready_at = ? where ready_at is null",
                            (time.time(),))

    def _batch_readiness(self, b):
        st = b["state"]
        if st in CLOSED:
            return "closed", st
        if st in ("frozen", "staged"):
            return "reconciled", "not committed locally: the cycle continues from staging"
        if st in COMMITTED_UNSENT:
            if self.subs_holds(b):
                return "reconciled", "subs holds its local commitment; never sent"
            return "waiting", "subs doesn't hold its local commitment"
        if b["recovery_paused"]:
            return "paused", "recovery paused for the owner"
        if st == "issuing":
            if not b["attempted"]:
                return "reconciled", ("never sent: a resume repeats the binding check, journals "
                                      "the intent again and sends once")
            return "waiting", "attempted without an answer"
        if st == "broadcast_uncertain":
            return "waiting", ("uncertain: no transaction carrying its root found yet; read back "
                               "again (finding nothing proves nothing)")
        # broadcast or mined, with the txid known.
        if self.commitment_seen(b["bid"]):
            return "reconciled", "its transaction is on this node's chain or in its mempool"
        if b["raw"]:
            n = len(json.loads(b["ancestors"] or "[]"))
            return "waiting", ("its transaction is on neither this node's chain nor its "
                               "mempool: rebroadcast the journaled bytes"
                               + (f", with its {n} unconfirmed ancestor"
                                  + ("s" if n > 1 else "") if n else ""))
        return "waiting", "its transaction isn't seen and no bytes were journaled"

    def recovery_report(self):
        """Every batch, and every space's restored subs against the chain.
        Ready when nothing waits: each batch closed, reconciled or paused;
        each space's subs root on the chain, or one local commitment of an
        unsent or pending batch ahead of it; and every adopted txid subs
        lacks attached, or the space paused for want of the U1(b)
        capability. It reads only."""
        waiting, paused = [], []
        state = self.recovery_state()
        if state in ("required", "incomplete"):
            missing = self.missing_batches()
            waiting.append(RESTORE_REQUIRED + (f" (missing: {', '.join(missing)})"
                                               if missing else f" (the restore is {state})"))
        batches = {}
        for b in self.batches():
            verdict, why = self._batch_readiness(b)
            batches[b["bid"]] = {"space": b["space"], "state": b["state"], "verdict": verdict,
                                 "why": why}
            if verdict == "waiting":
                waiting.append(f"{b['bid']}: {why}")
            elif verdict == "paused":
                paused.append(f"{b['bid']}: {why}")
        spaces = {}
        for space in sorted({b["space"] for b in self.batches()}):
            pipe = self.subs_read.get(f"/spaces/{space}/pipeline") or {}
            chain = self.onchain_commitment(space)
            subs_root, subs_txid = pipe.get("root"), pipe.get("txid")
            chain_root = chain["state_root"] if chain else None
            ours = [b for b in self.batches(space) if b["root"] == subs_root and subs_root
                    and b["state"] not in ("rebuilt", "superseded")]
            last = ours[-1] if ours else None
            entry = {"subs_root": subs_root, "subs_txid": subs_txid, "chain_root": chain_root,
                     "batch": last and last["bid"]}
            if subs_root == chain_root:
                entry["root"] = "matches the chain"
            elif last and last["state"] in PREPARING + ("issuing", "broadcast",
                                                         "broadcast_uncertain") \
                    and chain_root == last["prior_root"]:
                entry["root"] = (f"one local commitment ahead of the chain ({last['bid']}, "
                                 f"{last['state']})")
            else:
                entry["root"] = "doesn't match the chain"
                waiting.append(f"{space}: subs' root {subs_root} doesn't match the chain's "
                               f"{chain_root}")
            if last and last["txid"] and subs_txid != last["txid"]:
                if not self.capabilities.attach_txid:
                    entry["attach"] = "paused: " + NO_ATTACH
                    paused.append(f"{space}: subs lacks {last['bid']}'s txid and can't be told")
                elif chain_root == last["root"]:
                    entry["attach"] = f"needed: attach {last['bid']}'s adopted txid"
                    waiting.append(f"{space}: attach {last['bid']}'s adopted txid to subs")
                else:
                    entry["attach"] = f"needed once {last['bid']}'s commitment is mined"
                    waiting.append(f"{space}: attach {last['bid']}'s txid once it is mined")
            spaces[space] = entry
        return {"ready": not waiting, "waiting": waiting, "paused": paused,
                "batches": batches, "spaces": spaces}
