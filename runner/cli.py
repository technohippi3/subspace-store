"""The attended runner (PAYMENT-SPEC.md, "Checkout and the attended runner").

The operator carries orders through issuance with one command per step:

    python3 -m runner <config.json> status
    python3 -m runner <config.json> prepare <space>
    python3 -m runner <config.json> issue <bid> [--fee-rate N] [--confirm <bid>]
    python3 -m runner <config.json> watch <bid>
    python3 -m runner <config.json> certify <bid>
    python3 -m runner <config.json> publish <bid>
    python3 -m runner <config.json> cancel <oid>
    python3 -m runner <config.json> refund <oid>
    python3 -m runner <config.json> broadcast-refund <gid> [--confirm <gid>]

After a host loss (CONTROLLER-DESIGN.md, "Restore and reconciliation"):

    python3 -m runner <config.json> restore
    python3 -m runner <config.json> readback <bid>
    python3 -m runner <config.json> attach-txid <bid>
    python3 -m runner <config.json> resume <bid> [--confirm <bid>]
    python3 -m runner <config.json> rebroadcast <bid> [--confirm <bid>]

`restore` runs on a fresh host, after the store has been restored from its
journal (`python3 -m service restore`) and started. It refuses a controller
database that holds batches and a non-empty subs data directory. It checks
the latest coordinated snapshot's subs files against its manifest, copies
them only while a connection to subs is refused, starts subs, rebuilds the
controller's batches from its journal and reconciles them against subs,
the store and the chain. Until every batch is reconciled or paused, each
space's restored root agrees with the chain and every adopted txid subs
lacks is attached, `issue` and `resume` are refused; `status` and
`restore` say what waits.

A database that lacks batches the controller's journal holds, a fresh
one included, needs a restore, and that is recorded in it when it is
opened, before anything writes. Until a restore has replayed the journal
(in one transaction) and reconciled, every command but `status` and
`restore` is refused. An interrupted `restore` is run again and resumes:
subs' files are moved into place whole and recorded, a replay that didn't
commit runs again, and reconciliation, which is idempotent, runs again.

Before every command but `status`, which reports it, the runner asks
bitcoind, spaced, both subs endpoints (each for the spaced behind it) and
the store which network and chain they are on, by block hash, and refuses
unless all are on the configured network and one chain. `restore` asks
bitcoind, spaced and the store first, and subs once it has started it.
Steps with no on-chain effect run on the command alone. `issue`, `resume`,
`rebroadcast` and `broadcast-refund` send a transaction, so each needs the
operator to confirm the object it sends: the batch id, or the refund group
id, typed at the prompt or given as `--confirm`. Without it nothing
changes. `readback` and `attach-txid` send nothing: the attach tells subs
a txid the readback adopted, and only a subs with the U1(b) route can be
told.
Certificates go to the store only after libveritas verified them with every
check of the controller's step 11.

Every command prints one JSON object. The runner drives the controller of
`CONTROLLER-DESIGN.md` (`controller/core.py`), built from the host
configuration by `controller/host.py`: addresses, cookie files, the store's
operator token file, and the commands that stop and start subs. It imports
nothing from the regtest harness. It still refuses any network but
regtest, and results from it are regtest results.
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

from controller.core import RESTORE_REQUIRED


class NotConfirmed(Exception):
    pass


def _files(directory, prefix):
    """Every file under `directory`, as manifest paths with `prefix`."""
    directory = Path(directory)
    if not directory.is_dir():
        return set()
    return {prefix + str(f.relative_to(directory)) for f in directory.rglob("*") if f.is_file()}


# The configured network, as each component names it.
NAMES = {"regtest": {"bitcoind": "regtest", "spaced": "regtest", "subs": "regtest",
                     "store": "regtest"}}


def _confirm(what, expected, given, ask):
    """The operator's confirmation naming the object to send. `ask` is None
    when there is no terminal to ask on."""
    if given is None and ask is not None:
        given = ask(f"This sends a transaction. Type the {what} to confirm: ").strip()
    if given != expected:
        raise NotConfirmed(f"not confirmed: the {what} {expected} must be typed or given "
                           f"as --confirm; nothing was sent")


class Runner:
    def __init__(self, store, controller, publisher=None, ask=None, network="regtest"):
        self.store = store
        self.c = controller
        self.publisher = publisher
        self.ask = ask
        self.network = network

    # The networks the clients actually reach

    def _on_best_chain(self, block_hash):
        try:
            return self.c.btc.call("getblockheader", block_hash)["confirmations"] >= 1
        except Exception:  # noqa: BLE001 - unknown to the controller's node
            return False

    def _subs_chain(self, who, client, want, problems):
        """One subs endpoint: the wallet it uses, and the network and tip
        hash of the spaced behind it, asked through that endpoint itself."""
        info = client.get("/rpc/endpoints")
        sp = client.post("/rpc/spaced", {"method": "getserverinfo", "params": []}) or {}
        sp = sp.get("result") or {}
        if sp.get("network") != want:
            problems.append(f"{who}'s spaced is on {sp.get('network')!r}, not {want!r}")
        tip = (sp.get("tip") or {}).get("hash")
        if not tip or not self._on_best_chain(tip):
            problems.append(f"{who}'s spaced tip isn't on the controller's bitcoind best chain")
        if info.get("wallet") != self.c.operator_wallet:
            problems.append(f"{who} uses wallet {info.get('wallet')!r}, not the configured "
                            f"{self.c.operator_wallet!r}")
        return sp.get("network")

    def networks(self, subs=True):
        """Ask every independently configured component which network and
        chain it is on. The configuration's label proves nothing: bitcoind,
        spaced and the store must each report the configured network, and
        spaced's tip and the store node's best block must be on the
        controller node's best chain. Each subs endpoint, the one the
        controller writes to (which broadcasts) and the one it reads from,
        is asked through itself for the network and tip hash of the spaced
        behind it, which must be on that same chain, and must use the
        configured operator wallet."""
        want = NAMES[self.network]
        problems = []
        try:
            btc = self.c.btc.call("getblockchaininfo")
            sp = self.c.spaced.call("getserverinfo")
            store = (self.store.status() or {}).get("chain") or {}
            seen = {"bitcoind": btc.get("chain"), "spaced": sp.get("network"),
                    "store": store.get("network")}
            if subs:
                seen["subs (writes)"] = self._subs_chain("subs (writes)", self.c.subs,
                                                         want["subs"], problems)
                seen["subs (reads)"] = self._subs_chain("subs (reads)", self.c.subs_read,
                                                        want["subs"], problems)
        except Exception as e:  # noqa: BLE001 - reported, and nothing runs
            return {"ok": False, "problems": [f"a component didn't answer: "
                                              f"{type(e).__name__}: {e}"]}
        for who in ("bitcoind", "spaced", "store"):
            if seen[who] != want[who]:
                problems.append(f"{who} is on {seen[who]!r}, not {want[who]!r}")
        tip = (sp.get("tip") or {}).get("hash")
        if not tip or not self._on_best_chain(tip):
            problems.append("spaced's tip isn't on the controller's bitcoind best chain")
        best = store.get("best_block_hash")
        if not best or not self._on_best_chain(best):
            problems.append("the store's node best block isn't on the controller's bitcoind "
                            "best chain")
        return {"ok": not problems, "problems": problems, "seen": seen}

    def require_networks(self, subs=True):
        n = self.networks(subs)
        if not n["ok"]:
            raise NotConfirmed("network check failed, nothing was done: "
                               + "; ".join(n["problems"]))

    # Read-only

    def status(self):
        batches = [{k: b[k] for k in ("bid", "space", "members", "state", "txid",
                                     "mined_height")} for b in self.c.batches()]
        return {"networks": self.networks(),
                "store": self.store.status(), "alerts": self.store.alerts(),
                "controller_alerts": self.c.alerts(),
                "subs_capabilities": self.c.capabilities.as_dict(),
                "orders": {s: self.store.orders(s) for s in
                           ("requested", "quoted", "converted", "issuing", "ready",
                            "fulfilled", "cancelled", "refund_due")},
                "batches": batches,
                "recovery": self.recovery() if self.c.recovery_state() else None}

    # After a host loss: restore, and what still waits

    def recovery(self):
        """The controller's readiness report, with the store's start-up
        reconciliation of refund attempts. Marks the restore recovered once
        nothing waits."""
        report = self.c.recovery_report()
        report["state"] = self.c.recovery_state()
        startup = (self.store.status() or {}).get("startup") or {}
        report["refunds"] = {"reconciled_at_store_start": bool(startup),
                             "rebroadcast_at_store_start": startup.get("rebroadcast")}
        if not startup:
            report["ready"] = False
            report["waiting"].append("the store hasn't reconciled its refund attempts")
        if report["ready"] and self.c.restore_pending():
            self.c.mark_recovered()
        return report

    def require_recovered(self):
        """No new commitment is sent while a restore waits: an operator
        wallet restored from its backup doesn't know a transaction that
        is still unseen by this host, and a new send could spend the same
        inputs."""
        state = self.c.recovery_state()
        if state is None:
            return
        if state != "reconciling":
            raise NotConfirmed(RESTORE_REQUIRED + ", nothing was sent")
        report = self.recovery()
        if not report["ready"]:
            raise NotConfirmed("a restore isn't reconciled yet, nothing was sent: "
                               + "; ".join(report["waiting"]))

    def restore(self):
        """Restore subs from the latest coordinated snapshot and the
        controller from its journal, onto a fresh host, then reconcile. An
        interrupted restore is run again and resumes where it stopped."""
        c = self.c
        state = c.recovery_state()
        if state is None:
            if c.batches():
                raise NotConfirmed("the controller's database already holds every journaled "
                                   "batch; a restore never overwrites, nothing was done")
            raise NotConfirmed("the controller's journal holds no batches: nothing to "
                               "restore, nothing was done")
        pending = c.restore_pending()
        snapshots = sorted((d for d in Path(c.snapshot_dir).glob("*")
                            if (d / "manifest.json").is_file() and c.snapshot_number(d) >= 0),
                           key=c.snapshot_number) if Path(c.snapshot_dir).is_dir() else []
        if pending["snapshot"]:
            snapshots = [d for d in snapshots if d.name == pending["snapshot"]]
        if not snapshots:
            raise NotConfirmed(f"no coordinated snapshot in {c.snapshot_dir}"
                               + (f" named {pending['snapshot']}" if pending["snapshot"] else "")
                               + "; nothing was done")
        snap = snapshots[-1]
        manifest = json.loads((snap / "manifest.json").read_text())
        files = {rel: d for rel, d in manifest["files"].items() if rel.startswith("subs/")}
        bad = [rel for rel, digest in sorted(files.items())
               if not (snap / rel).is_file()
               or hashlib.sha256((snap / rel).read_bytes()).hexdigest() != digest]
        bad += sorted(_files(snap / "subs", "subs/") - set(files))
        if not files or bad:
            raise NotConfirmed(f"snapshot {snap.name} doesn't match its manifest "
                               f"({bad or 'no subs files'}); nothing was copied")
        data = Path(c.subs_process.data_dir)
        copied = False
        if not pending["subs_at"]:
            # Empty, or already holding exactly the snapshot's files (a
            # restore stopped between moving them in and recording it).
            held = _files(data, "subs/")
            exact = held == set(files) and all(
                hashlib.sha256((data / rel[len("subs/"):]).read_bytes()).hexdigest() == d
                for rel, d in files.items())
            if held and not exact:
                raise NotConfirmed(f"subs' data directory {data} isn't empty; a restore never "
                                   "overwrites, nothing was done")
            self.require_networks(subs=False)
            c.subs_process.stop()
            if not c._subs_stopped():
                raise NotConfirmed("subs answers or its shutdown isn't established; nothing "
                                   "was copied")
            if not exact:
                # Copied beside the data directory and moved into place
                # whole, so an interruption leaves it empty or complete.
                stage = data.with_name(data.name + ".restoring")
                if stage.exists():
                    shutil.rmtree(stage)
                shutil.copytree(snap / "subs", stage)
                os.replace(stage, data)
                copied = True
            c.mark_subs_restored(snap.name)
            c.subs_process.start()
            c._wait_subs_ready()
        else:
            self.require_networks(subs=False)
            if not c._subs_ready():
                c.subs_process.start()
                c._wait_subs_ready()
        self.require_networks()
        resumed = c.restore_pending()
        log = c.restore_from_journal()
        return {"snapshot": snap.name, "subs_files_checked": len(files),
                "subs_copied": copied, "resumed_from": state,
                "replayed": not resumed["replayed_at"],
                "controller_journal_entries": c.journal.position(),
                "batches": len(c.batches()), "log": log, "recovery": self.recovery()}

    def readback(self, bid):
        """Read back an uncertain broadcast from the wallet, this node's
        mempool and the chain; adopt the txid only if a transaction
        carrying the batch's root is found. Sends nothing."""
        rb = self.c.readback(bid)
        ev = rb.get("evidence") or {}
        return {"bid": bid, "adopted": rb["adopted"], "txid": rb.get("txid"),
                "reason": rb.get("reason"), "state": self.c.batch(bid)["state"],
                "evidence": {"getcommitment": ev.get("getcommitment"),
                             "mempool": ev.get("mempool"), "wallet": ev.get("wallet")}}

    def attach_txid(self, bid):
        """U1(b): tell subs the txid the controller adopted. Sends nothing."""
        answer = self.c.attach_txid(bid)
        return {"bid": bid, "txid": self.c.batch(bid)["txid"], "answer": answer}

    # No on-chain effect

    def prepare(self, space):
        """Freeze, stage with readback, commit locally, prove, checkpoint."""
        self.require_recovered()
        c = self.c
        bid = c.freeze(space)
        staged = c.stage(bid)
        committed = c.commit_local(bid)
        proved = c.prove(bid)
        snapshot = c.checkpoint(bid)
        b = c.batch(bid)
        return {"bid": bid, "state": b["state"], "members": b["members"],
                "root": b["root"], "staged": staged["staged"],
                "members_on_root": committed.get("members_on_root"),
                "proving": proved["proving"], "snapshot": snapshot["dir"]}

    def watch(self, bid):
        state = self.c.watch(bid)
        b = self.c.batch(bid)
        # d as the controller counts it: 0 in the block that mines it.
        depth = self.c.tip() - b["mined_height"] if b["mined_height"] else None
        return {"bid": bid, "state": state, "txid": b["txid"], "depth": depth,
                "certificate_status": self.c.certificate_status(bid)}

    def certify(self, bid):
        """Verify every member's certificate; deliver only the verified ones
        to the store's order pages."""
        b = self.c.batch(bid)
        try:
            self.c.subs.post("/registry/notify", {"space": b["space"], "root": b["root"]})
        except Exception:  # noqa: BLE001 - the verification below decides
            pass
        results = self.c.verify_certificates(bid)
        out = {}
        for oid, res in sorted(results.items()):
            entry = {"handle": res["handle"], "verified": res["ok"],
                     "checks": res["checks"], "delivered": False}
            if res["ok"]:
                msg = Path(res["artifacts"]) / f"{res['handle']}.message.bin"
                self.store.deliver_certificate(oid, msg.read_bytes())
                entry["delivered"] = True
            out[oid] = entry
        return {"bid": bid, "members": out}

    def publish(self, bid):
        p = self.publisher
        added = p.enroll(bid)
        calls = p.publish_outstanding(bid)
        delivery = {oid: {k: v for k, v in p.confirm_delivery(bid, oid).items()
                          if k in ("confirmed", "waiting", "why")}
                    for oid in list(p.outstanding(bid))}
        return {"bid": bid, "enrolled": added, "publish_calls": len(calls),
                "delivery": delivery, "outstanding": p.outstanding(bid)}

    def cancel(self, oid):
        return dict(self.store.cancel(oid), oid=oid)

    def refund(self, oid):
        """Build, sign and reserve the cancellation refund. Nothing is sent."""
        return dict(self.store.refund(oid, "cancellation"), oid=oid)

    # Sends a transaction: confirmed by the operator

    def issue(self, bid, fee_rate=1, confirm=None):
        self.require_recovered()
        b = self.c.batch(bid)
        if b["state"] != "checkpointed":
            raise NotConfirmed(f"{bid} is {b['state']}, not checkpointed; nothing was sent")
        _confirm("batch id", bid, confirm, self.ask)
        went = self.c.issue(bid, fee_rate)
        b = self.c.batch(went)
        return {"bid": went, "state": b["state"], "txid": b["txid"],
                "rebuilt_from": bid if went != bid else None}

    def resume(self, bid, confirm=None):
        """A batch left `issuing` and never sent: the binding check again,
        the intent journaled again, then one send."""
        self.require_recovered()
        b = self.c.batch(bid)
        if b["state"] != "issuing" or b["attempted"]:
            raise NotConfirmed(f"{bid} is {b['state']}"
                               + (", and its broadcast was attempted" if b["attempted"] else "")
                               + "; only a batch issuing and never sent resumes; nothing was sent")
        _confirm("batch id", bid, confirm, self.ask)
        went = self.c.resume(bid)
        b = self.c.batch(went) if went else self.c.batch(bid)
        return {"bid": b["bid"], "state": b["state"], "txid": b["txid"],
                "rebuilt_from": bid if went != bid else None}

    def rebroadcast(self, bid, confirm=None):
        """Send the identical journaled bytes of a commitment that this node
        has on neither its chain nor its mempool. Never /broadcast."""
        b = self.c.batch(bid)
        if b["state"] not in ("broadcast", "broadcast_uncertain") or not b["txid"]:
            raise NotConfirmed(f"{bid} is {b['state']} with no known txid; nothing to "
                               "rebroadcast, nothing was sent")
        _confirm("batch id", bid, confirm, self.ask)
        txid = self.c.rebroadcast_commitment(bid)
        pool = set(self.c.btc.call("getrawmempool"))
        ancestors = [a for a, _ in json.loads(self.c.batch(bid)["ancestors"] or "[]")]
        return {"bid": bid, "txid": txid, "in_mempool": txid in pool,
                "ancestors": [{"txid": a, "in_mempool": a in pool} for a in ancestors]}

    def broadcast_refund(self, gid, confirm=None):
        _confirm("refund group id", gid, confirm, self.ask)
        return self.store.broadcast(gid)


# Construction from a configuration file


NETWORKS = ("regtest",)  # nothing else runs at this checkpoint


def build(config, ask=None):
    if config.get("network") not in NETWORKS:
        raise SystemExit(f"the runner runs on {', '.join(NETWORKS)} only; "
                         f"the configuration names {config.get('network')!r}")
    from controller import host
    from .store import Store

    try:
        host.check(config)
    except host.ConfigError as e:
        raise SystemExit(f"configuration: {e}")
    s = config["store"]
    store = Store(s["url"], s["operator_token_file"], s["db"], s["journal_dir"])
    try:
        controller, publisher = host.build(config, store)
    except host.ConfigError as e:
        raise SystemExit(f"configuration: {e}")
    return Runner(store, controller, publisher, ask=ask, network=config["network"])


def main(argv=None, ask=None):
    ap = argparse.ArgumentParser(prog="python3 -m runner", description=__doc__.split("\n\n")[0])
    ap.add_argument("config")
    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    sub.add_parser("prepare").add_argument("space")
    p = sub.add_parser("issue")
    p.add_argument("bid")
    p.add_argument("--fee-rate", type=int, default=1)
    p.add_argument("--confirm")
    for name in ("watch", "certify", "publish"):
        sub.add_parser(name).add_argument("bid")
    for name in ("cancel", "refund"):
        sub.add_parser(name).add_argument("oid")
    p = sub.add_parser("broadcast-refund")
    p.add_argument("gid")
    p.add_argument("--confirm")
    sub.add_parser("restore")
    for name in ("readback", "attach-txid"):
        sub.add_parser(name).add_argument("bid")
    for name in ("resume", "rebroadcast"):
        p = sub.add_parser(name)
        p.add_argument("bid")
        p.add_argument("--confirm")
    args = ap.parse_args(argv)
    if ask is None and sys.stdin.isatty():
        ask = input
    config = json.loads(Path(args.config).read_text())
    r = build(config, ask=ask)
    try:
        # Every command but status needs every component on the configured
        # network first; status reports the check instead. A restore checks
        # subs once it has started it.
        if args.command not in ("status", "restore"):
            # Nothing but status and restore runs while the database lacks
            # journaled batches or a restore hasn't replayed and reconciled.
            if r.c.recovery_state() in ("required", "incomplete"):
                raise NotConfirmed(RESTORE_REQUIRED + "; nothing was done")
            r.require_networks()
        if args.command == "status":
            out = r.status()
        elif args.command == "prepare":
            out = r.prepare(args.space)
        elif args.command == "issue":
            out = r.issue(args.bid, args.fee_rate, args.confirm)
        elif args.command == "watch":
            out = r.watch(args.bid)
        elif args.command == "certify":
            out = r.certify(args.bid)
        elif args.command == "publish":
            out = r.publish(args.bid)
        elif args.command == "cancel":
            out = r.cancel(args.oid)
        elif args.command == "refund":
            out = r.refund(args.oid)
        elif args.command == "restore":
            out = r.restore()
        elif args.command == "readback":
            out = r.readback(args.bid)
        elif args.command == "attach-txid":
            out = r.attach_txid(args.bid)
        elif args.command == "resume":
            out = r.resume(args.bid, args.confirm)
        elif args.command == "rebroadcast":
            out = r.rebroadcast(args.bid, args.confirm)
        else:
            out = r.broadcast_refund(args.gid, args.confirm)
    except NotConfirmed as e:
        print(json.dumps({"refused": str(e)}))
        return 3
    except Exception as e:  # noqa: BLE001 - reported, never a trace with state
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        return 1
    print(json.dumps(out, indent=1, default=str))
    return 0
