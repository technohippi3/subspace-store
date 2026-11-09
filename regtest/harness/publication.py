"""Publication to a local relay and per-handle delivery confirmation
(regtest only): scenario 6, over the core publisher in
`controller/publication.py`.

The publication procedure of CONTROLLER-DESIGN.md, steps 1 to 6, against
the real `subs` and the pinned `certrelay`, both inside the run's network
namespace:
1. a journaled set of outstanding handles per batch: members whose
   certificate was verified at d >= 150 and whose delivery isn't confirmed;
2. no `/publish` call for an empty set;
3. chunks of at most 100 handles;
4. immediately before each call, the live commitment from `getcommitment`
   must carry the batch's root at d >= 150, with an anchor that covers it;
5. after each call, `publish_status` per handle, where only "final" counts;
6. delivery per handle through a verified lookup: the relay's `/query`
   answer, verified with libveritas against root anchors read from `spaced`
   directly, must show the handle and its `script_pubkey`, under a root that
   is a commitment of the space on chain at d >= 150 with an anchor that
   covers it (L9). `subs` builds the certificate against the space's latest
   commitment when it publishes the handle, so that root is the batch's or
   a later one (R23, R24); a later one below d >= 150 or not yet covered
   means waiting. The live check of step 4 runs again first. A relay's
   `/peek` is never read.

`subs` must be the build with `upstream/subs-fabric-seed.patch` and the run
must have SUBSPACE_RELAY=1, so that `subs` seeds its fabric client with the
local relay only (finding R19). The scenario refuses to run otherwise.

Usage: python3 -m regtest.harness.publication <run> first_purchase publication

It is harness code. Results from it are regtest results.
"""

import sys

from controller.publication import CHUNK, SCHEMA, Publisher as _Publisher  # noqa: F401

from . import compare
from .controller import ANCHOR_FINALITY
from .procs import relay_enabled, relay_url
from .rpc import Http



class Publisher(_Publisher):
    """The core publisher, given the regtest run's controller, registry,
    journal and subs, and the local relay."""

    def __init__(self, run):
        super().__init__(run.controller, run.registry, run.controller_journal,
                         run.host / "publication.db", run.stack.subs(via_proxy=True),
                         relay_url())
        self.run = run
        self.stack = run.stack


LABELS = ("one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
          "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
          "eighteen", "nineteen", "twenty")


def _free_label(run, space):
    """The first numbered label not yet listed on the space, so scenario 6 can
    follow the other scenarios in one run."""
    used = {r[0] for r in run.registry.db.execute("select name from names")}
    return next(l for l in LABELS if f"{l}{space}" not in used)


def _subs_seed_line(stack):
    log = stack.logs / "subs.log"
    lines = [l for l in log.read_text(errors="replace").splitlines() if "Using fabric seeds:" in l]
    return lines[-1].split("Using fabric seeds:", 1)[1].strip() if lines else None


def _lookup_cell(res):
    """The parts of a delivery attempt the report shows."""
    out = {"confirmed": res["confirmed"], "why": res.get("why", "")}
    lk = res.get("lookup")
    if lk:
        out.update({"relay_answer": lk.get("relay_answer"), "checks": lk.get("checks"),
                    "root_gate": lk.get("root_gate"), "root_is_the_batchs": lk.get("root_is_the_batchs"),
                    "root_is_live": lk.get("root_is_live"),
                    "zone": lk.get("zone"), "space_zone": lk.get("space_zone"),
                    "error": lk.get("error")})
    if res.get("waiting"):
        out["waiting"] = True
    if res.get("live"):
        out["live"] = res["live"]
    return out


def _enroll_and_publish(run, p, scen, bid):
    """Steps 1 to 5 for one batch, each compared with the model."""
    r, c = run.report, run.controller
    space, mbid = run.bids[bid]
    m = run.mirror(space)
    added = p.enroll(bid)
    r.step(scen, None, f"outstanding set for {bid} (journaled)",
           {"outstanding": p.outstanding(bid), "added": added,
            "journaled": c.journal.acknowledged(lambda e: e["kind"] == "publication"
                                                and e["bid"] == bid)},
           {"members": m.batch_members(mbid)},
           match=sorted(p.outstanding(bid)) == sorted(m.batch_members(mbid)))
    # L3: a handle that isn't published yet can't be confirmed. The relay is
    # asked anyway, to show that it has nothing for the handle.
    for oid in p.outstanding(bid):
        found = p.lookup(bid, oid)
        res = p.confirm_delivery(bid, oid)
        mok, mwhy = m.step("confirm_delivery", mbid, oid)
        got = {"confirmed": res["confirmed"], "status": run.registry.order(oid)["status"]}
        r.step(scen, "L3", f"delivery of {oid} before its handle is published",
               {"confirmed": res["confirmed"], "why": res.get("why", ""), "status": got["status"],
                "relay_answer": found.get("relay_answer"), "checks": found.get("checks"),
                "error": found.get("error")},
               {"confirmed": mok, "why": mwhy if not mok else ""},
               match=compare.same_delivery(got, {"ok": mok, "status": m.order_status(oid)}))
    for res in p.publish_outstanding(bid):
        chunk = sorted(res.get("publish_status", {}))
        mok, mcount = m.step("publish", mbid, chunk)
        mpub = sorted(set(chunk) & set(m.sim.controller.batches[mbid].published)) if mok else []
        r.step(scen, "L2", f"publish a chunk of {len(chunk)} for {bid} after the live check",
               res, {"ok": mok, "count": mcount if mok else 0, "published": mpub,
                     "why": mcount if not mok else ""},
               match=compare.same_publish(res, {"ok": mok, "count": mcount if mok else 0,
                                                "published": mpub}))


def _deliver(run, p, scen, bid, case="L2", what="confirmed by a verified lookup through the relay"):
    """Step 6 for every outstanding member of one batch, compared with the
    model. A refusal agrees with the model only when it is a wait: a
    matching answer whose root isn't final and covered yet."""
    r = run.report
    space, mbid = run.bids[bid]
    m = run.mirror(space)
    for oid in list(p.outstanding(bid)):
        res = p.confirm_delivery(bid, oid)
        mok, mwhy = m.step("confirm_delivery", mbid, oid)
        got = {"confirmed": res["confirmed"], "status": run.registry.order(oid)["status"]}
        exp = {"ok": mok, "status": m.order_status(oid)}
        r.step(scen, case, f"delivery of {oid} {what}",
               dict(_lookup_cell(res), status=got["status"]),
               dict(exp, why=mwhy if not mok else ""),
               match=compare.same_delivery(got, exp)
               and (res["confirmed"] or bool(res.get("waiting"))))


def _nothing_outstanding(run, p, scen, bid):
    r, c = run.report, run.controller
    space, mbid = run.bids[bid]
    m = run.mirror(space)
    run.compare_orders(scen, None, f"{bid} members after delivery", c.batch(bid)["members"], space)
    # Step 2: nothing is outstanding now, so nothing is called.
    calls = len(p.calls)
    again = p.publish_outstanding(bid)
    mok, mcount = m.step("publish", mbid, [])
    r.step(scen, None, f"publication pass for {bid} with nothing outstanding",
           {"calls": len(p.calls) - calls, "results": again},
           {"ok": mok, "count": mcount if mok else 0},
           match=compare.same_publish({"called": len(p.calls) > calls},
                                      {"ok": mok, "count": mcount if mok else 0, "published": []}))


def _publish_and_deliver(run, p, scen, bid):
    """Steps 1 to 6 for one batch, each compared with the model."""
    _enroll_and_publish(run, p, scen, bid)
    _deliver(run, p, scen, bid)
    _nothing_outstanding(run, p, scen, bid)


def publication(run):
    """Publish the first purchase's batch to the local relay and confirm
    delivery, then issue another batch and show that publication waits for
    finality and anchor coverage. Publish that one while a third commitment
    is at d = 149, and show that delivery waits for the root the certificate
    was built on (L9). Then publish and deliver the third."""
    from .scenarios import FEE_RATE, SPACE_A, attempt, isolated

    scen = "6. publication and delivery"
    r, c = run.report, run.controller
    if not relay_enabled():
        raise RuntimeError("publication needs SUBSPACE_RELAY=1 and the subs build with "
                           "upstream/subs-fabric-seed.patch; see regtest/run-publication.sh")
    seeds = _subs_seed_line(run.stack)
    peers = Http(relay_url(), timeout=10).get("/peers")
    iso = {"namespace_isolated": isolated(), "relay": relay_url(), "subs_fabric_seeds": seeds,
           "relay_peers": peers, "relay_seeds": "none (regtest, --is-bootstrap, no --seed)"}
    run.report.meta["relay"] = {"url": relay_url(), "subs_fabric_seeds": seeds}
    r.step(scen, None, "isolation: subs seeds its fabric client with the local relay only", iso,
           required=False, note="the pinned subs has no seed option; this build has "
                                "upstream/subs-fabric-seed.patch (R19)")
    if seeds != relay_url() or not iso["namespace_isolated"]:
        raise RuntimeError(f"refusing to publish: subs fabric seeds {seeds!r}, isolated "
                           f"{iso['namespace_isolated']}")
    p = Publisher(run)
    p_bids = [b["bid"] for b in c.batches(SPACE_A) if b["state"] == "final"
              and any(run.registry.order(o)["status"] == "ready" for o in b["members"])]
    if not p_bids:
        raise RuntimeError("no final batch with ready members; run first_purchase first")
    for bid in p_bids:
        _publish_and_deliver(run, p, scen, bid)

    # A later batch. Publication is refused while it isn't final (L1) and
    # while no anchor covers it (L6), then proceeds (L2).
    m = run.mirror(SPACE_A)
    oid, _ = run.buy(scen, SPACE_A, _free_label(run, SPACE_A))
    run.mine(3)
    m.mine(3)
    run.compare_orders(scen, "P1", "payment at 3 conf converts the hold", [oid], SPACE_A)
    bid, mbid = run.prepare(scen, SPACE_A, [oid])
    c.issue(bid, FEE_RATE)
    m.step("check_and_issue", mbid, "ok")
    run.compare_batch(scen, "B3", f"{bid} broadcast", bid, {"txid": c.batch(bid)["txid"]})

    def refused_publish(case, what):
        # The members aren't ready, so the outstanding set is empty; the
        # controller's own guard is the live check, tried here with the
        # member as the chunk.
        p.db.execute("insert or ignore into publication(bid, oid, handle, state) "
                     "values (?, ?, ?, 'outstanding')", (bid, oid, run.registry.order(oid)["name"]))
        res = p.publish(bid, [oid])
        mok, mcount = m.step("publish", mbid, [oid])
        r.step(scen, case, what, res,
               {"ok": mok, "count": mcount if mok else 0, "why": mcount if not mok else ""},
               match=compare.same_publish(res, {"ok": mok, "count": mcount if mok else 0,
                                                "published": []}))
        p.db.execute("delete from publication where bid = ? and oid = ?", (bid, oid))

    run.mine(1)
    m.mine(1)
    c.watch(bid)
    run.compare_batch(scen, None, f"{bid} mined at d = 0", bid)
    run.mine(149)
    m.mine(149)
    c.watch(bid)
    run.compare_batch(scen, None, f"{bid} at d = 149", bid)
    refused_publish("L1", f"publish {bid} at d = 149")
    run.mine(1)
    m.mine(1)
    c.watch(bid)
    run.compare_batch(scen, None, f"{bid} at d = 150", bid)
    b = c.batch(bid)
    if c.root_anchors()[0]["block"]["height"] - b["mined_height"] < ANCHOR_FINALITY:
        refused_publish("L6", f"publish {bid} at d = 150 before an anchor covers it")
    else:
        r.step(scen, "L6", f"publish {bid} before anchor coverage",
               {"skipped": "an anchor already covered the commitment at d = 150"}, required=False)
    run.certify(scen, bid, SPACE_A)

    # L9 (R24): the batch is final and covered, and its member is published
    # while a later commitment of the space is at d = 149. subs builds the
    # certificate against that later root, so delivery waits until it is
    # final and covered too, then proceeds.
    oid2, _ = run.buy(scen, SPACE_A, _free_label(run, SPACE_A))
    run.mine(3)
    m.mine(3)
    run.compare_orders(scen, "P1", "payment at 3 conf converts the hold", [oid2], SPACE_A)
    later, mlater = run.prepare(scen, SPACE_A, [oid2])
    c.issue(later, FEE_RATE)
    m.step("check_and_issue", mlater, "ok")
    run.compare_batch(scen, "B3", f"{later} broadcast", later, {"txid": c.batch(later)["txid"]})
    run.mine(1)
    m.mine(1)
    c.watch(later)
    run.mine(149)
    m.mine(149)
    c.watch(later)
    c.watch(bid)
    run.compare_batch(scen, None, f"{later} at d = 149", later,
                      {"position": c.tx_position(c.batch(later)["txid"])})
    run.compare_batch(scen, None, f"{bid} still final while {later} is at d = 149", bid)
    _enroll_and_publish(run, p, scen, bid)
    _deliver(run, p, scen, bid, "L9", f"while {later}, the certificate's root, is at d = 149")
    run.mine(1)
    m.mine(1)
    c.watch(later)
    run.compare_batch(scen, None, f"{later} at d = 150", later)
    lb = c.batch(later)
    if c.root_anchors()[0]["block"]["height"] - lb["mined_height"] < ANCHOR_FINALITY:
        _deliver(run, p, scen, bid, "L9", f"while no anchor covers {later}, the certificate's root")
    else:
        r.step(scen, "L9", f"delivery before an anchor covers {later}",
               {"skipped": "an anchor already covered the commitment at d = 150"}, required=False)
    run.certify(scen, later, SPACE_A)
    _deliver(run, p, scen, bid, "L9", f"once {later}, the certificate's root, is final and covered")
    _nothing_outstanding(run, p, scen, bid)
    _publish_and_deliver(run, p, scen, later)
    r.step(scen, None, "every /publish call of the run", {"calls": p.calls}, required=False,
           note="no call had an empty list or more than 100 handles; the relay's /peek "
                "was never read")


def main(argv):
    from . import scenarios
    scenarios.publication = publication
    return scenarios.main(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
