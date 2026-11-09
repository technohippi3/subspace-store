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

Steps with no on-chain effect run on the command alone. `issue` and
`broadcast-refund` send a transaction, so each needs the operator to
confirm the object it sends: the batch id, or the refund group id, typed at
the prompt or given as `--confirm`. Without it nothing changes.
Certificates go to the store only after libveritas verified them with every
check of the controller's step 11.

Every command prints one JSON object. The runner drives the controller of
`CONTROLLER-DESIGN.md`, which is still the regtest harness's
(`regtest/harness/controller.py`), and reaches bitcoind, spaced and subs
through the harness stack. It refuses any network but regtest. Results from
it are regtest results.
"""

import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace


class NotConfirmed(Exception):
    pass


def _confirm(what, expected, given, ask):
    """The operator's confirmation naming the object to send. `ask` is None
    when there is no terminal to ask on."""
    if given is None and ask is not None:
        given = ask(f"This sends a transaction. Type the {what} to confirm: ").strip()
    if given != expected:
        raise NotConfirmed(f"not confirmed: the {what} {expected} must be typed or given "
                           f"as --confirm; nothing was sent")


class Runner:
    def __init__(self, store, controller, publisher=None, ask=None):
        self.store = store
        self.c = controller
        self.publisher = publisher
        self.ask = ask

    # Read-only

    def status(self):
        batches = [{k: b[k] for k in ("bid", "space", "members", "state", "txid",
                                     "mined_height")} for b in self.c.batches()]
        return {"store": self.store.status(), "alerts": self.store.alerts(),
                "controller_alerts": self.c.alerts(),
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


def build(config, ask=None):
    if config.get("network") != "regtest":
        raise SystemExit("the runner runs on regtest only")
    from regtest.harness.controller import Controller
    from regtest.harness.journal import Journal
    from regtest.harness.procs import Stack
    from regtest.harness.publication import Publisher
    from .store import Store

    s = config["store"]
    store = Store(s["url"], s["operator_token_file"], s["db"], s["journal_dir"])
    cc = config["controller"]
    host = Path(cc["dir"])
    host.mkdir(parents=True, exist_ok=True)
    journal = Journal(cc["journal_dir"], cc.get("journal_name", "runner"))
    stack = Stack(config["regtest_run"])
    controller = Controller(host / "controller.db", journal, store, stack,
                            Path(config["verifier"]), host / "certs")
    publisher = Publisher(SimpleNamespace(controller=controller, registry=store, stack=stack,
                                          controller_journal=journal, host=host))
    return Runner(store, controller, publisher, ask=ask)


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
