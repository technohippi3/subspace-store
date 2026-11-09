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

Before every command but `status`, which reports it, the runner asks
bitcoind, spaced, both subs endpoints (each for the spaced behind it) and
the store which network and chain they are on, by block hash, and refuses
unless all are on the configured network and one chain.
Steps with no on-chain effect run on the command alone. `issue` and
`broadcast-refund` send a transaction, so each needs the operator to
confirm the object it sends: the batch id, or the refund group id, typed at
the prompt or given as `--confirm`. Without it nothing changes.
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
import json
import sys
from pathlib import Path


class NotConfirmed(Exception):
    pass


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

    def networks(self):
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
                    "store": store.get("network"),
                    "subs (writes)": self._subs_chain("subs (writes)", self.c.subs,
                                                      want["subs"], problems),
                    "subs (reads)": self._subs_chain("subs (reads)", self.c.subs_read,
                                                     want["subs"], problems)}
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

    def require_networks(self):
        n = self.networks()
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
                "batches": batches}

    # No on-chain effect

    def prepare(self, space):
        """Freeze, stage with readback, commit locally, prove, checkpoint."""
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
        b = self.c.batch(bid)
        if b["state"] != "checkpointed":
            raise NotConfirmed(f"{bid} is {b['state']}, not checkpointed; nothing was sent")
        _confirm("batch id", bid, confirm, self.ask)
        went = self.c.issue(bid, fee_rate)
        b = self.c.batch(went)
        return {"bid": went, "state": b["state"], "txid": b["txid"],
                "rebuilt_from": bid if went != bid else None}

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
    args = ap.parse_args(argv)
    if ask is None and sys.stdin.isatty():
        ask = input
    config = json.loads(Path(args.config).read_text())
    r = build(config, ask=ask)
    try:
        # Every command but status needs every component on the configured
        # network first; status reports the check instead.
        if args.command != "status":
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
