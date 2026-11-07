"""Publication to a local relay and per-handle delivery confirmation
(regtest only).

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
   directly, must show the handle, its `script_pubkey` and the batch's
   root. The live check of step 4 runs again first. A relay's `/peek` is
   never read.

`subs` must be the build with `upstream/subs-fabric-seed.patch` and the run
must have SUBSPACE_RELAY=1, so that `subs` seeds its fabric client with the
local relay only (finding R19). The scenario refuses to run otherwise.

Usage: python3 -m regtest.harness.publication <run> first_purchase publication

It is harness code. Results from it are regtest results.
"""

import json
import sqlite3
import subprocess
import sys
import urllib.parse

from . import compare
from .controller import ANCHOR_FINALITY, FINAL_D, Refused, label
from .procs import relay_enabled, relay_url
from .rpc import Http, HttpError

CHUNK = 100  # CONTROLLER-DESIGN.md step 3, well under subs' cap of 1,000

SCHEMA = """
create table if not exists publication (
  bid text not null, oid text not null, handle text not null,
  state text not null, publish_status text, calls integer not null default 0,
  primary key (bid, oid)
);
"""


class Publisher:
    def __init__(self, run):
        self.run = run
        self.c = run.controller
        self.reg = run.registry
        self.stack = run.stack
        self.journal = run.controller_journal
        self.db = sqlite3.connect(run.host / "publication.db", check_same_thread=False,
                                  isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.relay = Http(relay_url(), timeout=60)
        self.calls = []  # every /publish call made, for the report

    # 1. The outstanding set, journaled

    def _journal(self, bid):
        rows = [dict(r) for r in self.db.execute(
            "select oid, handle, state, publish_status from publication where bid = ? order by oid",
            (bid,))]
        self.journal.append("publication", bid=bid, handles=rows)

    def enroll(self, bid):
        """Add the batch's members whose certificate verified at d >= 150
        (status "ready") to its outstanding set."""
        b = self.c.batch(bid)
        added = []
        for m in b["members"]:
            o = self.reg.order(m)
            if o["status"] != "ready":
                continue
            cur = self.db.execute("insert or ignore into publication(bid, oid, handle, state) "
                                  "values (?, ?, ?, 'outstanding')", (bid, m, o["name"]))
            if cur.rowcount:
                added.append(m)
        self._journal(bid)
        return added

    def outstanding(self, bid):
        return [r["oid"] for r in self.db.execute(
            "select oid from publication where bid = ? and state != 'delivered' order by oid",
            (bid,))]

    def published(self, bid):
        return [r["oid"] for r in self.db.execute(
            "select oid from publication where bid = ? and state in ('published', 'delivered') "
            "order by oid", (bid,))]

    def row(self, bid, oid):
        r = self.db.execute("select * from publication where bid = ? and oid = ?",
                            (bid, oid)).fetchone()
        return dict(r) if r else None

    # 4. The live commitment

    def live_check(self, bid):
        """The live chain carries the batch's root at d >= 150, read from
        spaced and Bitcoin Core immediately, and an anchor covers it."""
        b = self.c.batch(bid)
        self.c.wait_synced()
        live = self.c.onchain_commitment(b["space"], b["root"]) if b["root"] else None
        pos = self.c.tx_position(b["txid"]) if b["txid"] else None
        newest = self.c.root_anchors()[0]["block"]["height"]
        out = {
            "root_on_chain": bool(live and live.get("state_root") == b["root"]),
            "commitment_height": live.get("block_height") if live else None,
            "depth": pos[1] if pos else None,
            "newest_anchor": newest,
        }
        out["ok"] = (out["root_on_chain"] and pos is not None and pos[1] >= FINAL_D
                     and out["commitment_height"] == pos[0]
                     and newest - pos[0] >= ANCHOR_FINALITY)
        return out

    # 2, 3 and 5. Publish chunks

    def publish(self, bid, chunk):
        """One `/publish` call for an explicit chunk, after the live check.
        Returns what happened; the chunk's handles stay outstanding unless
        their publish_status reads "final"."""
        b = self.c.batch(bid)
        if not chunk:
            return {"called": False, "why": "empty chunk: never call /publish with an empty list"}
        if len(chunk) > CHUNK:
            raise Refused(f"chunk of {len(chunk)} is over {CHUNK}")
        live = self.live_check(bid)
        if not live["ok"]:
            return {"called": False, "why": "live commitment check failed", "live": live}
        labels = [label(self.row(bid, o)["handle"]) for o in chunk]
        resp = self.stack.subs(via_proxy=True).post(f"/spaces/{b['space']}/publish",
                                                    {"handles": labels})
        self.calls.append({"bid": bid, "handles": labels, "response": resp})
        statuses = {}
        for o in chunk:
            h = self.c.handle(b["space"], label(self.row(bid, o)["handle"]))
            st = h.get("publish_status")
            statuses[o] = st
            new = "published" if st == "final" else "outstanding"
            self.db.execute("update publication set state = ?, publish_status = ?, "
                            "calls = calls + 1 where bid = ? and oid = ?", (new, st, bid, o))
            if st == "temp":
                self.c.alert("publish_temp", bid, o)
        self._journal(bid)
        return {"called": True, "live": live, "chunk": len(chunk), "response": resp,
                "publish_status": statuses,
                "final": sorted(o for o, s in statuses.items() if s == "final")}

    def publish_outstanding(self, bid):
        """Steps 2 and 3: every chunk of the outstanding, not yet published
        set, never an empty call."""
        todo = [o for o in self.outstanding(bid) if self.row(bid, o)["state"] == "outstanding"]
        return [self.publish(bid, todo[i:i + CHUNK]) for i in range(0, len(todo), CHUNK)]

    # 6. Delivery

    def lookup(self, bid, oid):
        """A verified lookup of one handle through the local relay. The relay
        answers `/query` with a message; libveritas verifies it against root
        anchors read from spaced directly, and the zones must carry the
        handle, its script_pubkey and the batch's root at its height."""
        b = self.c.batch(bid)
        o = self.reg.order(oid)
        handle = o["name"]
        anchors = self.c.root_anchors()
        n = len([d for d in self.c.workdir.iterdir() if d.is_dir()]) + 1
        out_dir = self.c.workdir / f"{n:03d}-{bid}-relay"
        out_dir.mkdir(parents=True)
        (out_dir / "anchors.json").write_text(json.dumps(anchors))
        q = urllib.parse.urlencode({"q": f"{b['space']},{handle}"})
        try:
            msg = self.relay.get(f"/query?{q}", raw=True)
        except HttpError as e:
            (out_dir / f"{handle}.relay-answer.txt").write_text(f"HTTP {e.status}: {e.body[:500]}")
            return {"handle": handle, "ok": False, "relay_answer": f"HTTP {e.status}",
                    "error": e.body[:300], "artifacts": str(out_dir)}
        msg_path = out_dir / f"{handle}.message.bin"
        msg_path.write_bytes(msg)
        proc = subprocess.run([str(self.c.verifier_bin), str(msg_path),
                               str(out_dir / "anchors.json")], capture_output=True, text=True)
        (out_dir / f"{handle}.libveritas.json").write_text(proc.stdout + proc.stderr)
        res = json.loads(proc.stdout) if proc.stdout.strip().startswith("{") else \
            {"verified": False, "error": proc.stderr[-500:]}
        zones = res.get("zones", [])
        zone = next((z for z in zones if z["handle"] == handle), None)
        space_zone = next((z for z in zones if z["handle"] == b["space"]), None)
        checks = {
            "verified": res.get("verified", False),
            "handle": zone is not None,
            "script_pubkey": bool(zone and zone["script_pubkey"] == o["recipient_spk"]),
            "root": bool(space_zone and space_zone["commitment_root"] == b["root"]),
            "root_height": bool(space_zone and space_zone["commitment_height"] == b["mined_height"]),
            "sovereign": bool(zone and zone["sovereignty"] == "sovereign"),
        }
        return {"handle": handle, "ok": all(checks.values()), "checks": checks,
                "zone": zone, "space_zone": space_zone, "error": res.get("error"),
                "message_bytes": len(msg), "relay_answer": "HTTP 200", "artifacts": str(out_dir)}

    def confirm_delivery(self, bid, oid):
        """Step 6 for one handle: only a published handle is looked up, the
        live check runs again immediately before, and only a verified lookup
        that matches marks the order fulfilled."""
        row = self.row(bid, oid)
        if row is None or row["state"] not in ("published", "delivered"):
            return {"confirmed": False, "why": "not published"}
        live = self.live_check(bid)
        if not live["ok"]:
            return {"confirmed": False, "why": "live commitment check failed", "live": live}
        found = self.lookup(bid, oid)
        if not found["ok"]:
            self.c.alert("delivery_unconfirmed", bid, oid)
            return {"confirmed": False, "why": "verified lookup does not match", "lookup": found,
                    "live": live}
        if row["state"] != "delivered":
            self.db.execute("update publication set state = 'delivered' where bid = ? and oid = ?",
                            (bid, oid))
            self._journal(bid)
            self.reg.mark_fulfilled(oid)
        return {"confirmed": True, "live": live, "lookup": found}


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
                    "zone": lk.get("zone"), "space_zone": lk.get("space_zone"),
                    "error": lk.get("error")})
    if res.get("live"):
        out["live"] = res["live"]
    return out


def _publish_and_deliver(run, p, scen, bid):
    """Steps 1 to 6 for one batch, each compared with the model."""
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
    for oid in list(p.outstanding(bid)):
        res = p.confirm_delivery(bid, oid)
        mok, mwhy = m.step("confirm_delivery", mbid, oid)
        got = {"confirmed": res["confirmed"], "status": run.registry.order(oid)["status"]}
        exp = {"ok": mok, "status": m.order_status(oid)}
        r.step(scen, "L2", f"delivery of {oid} confirmed by a verified lookup through the relay",
               dict(_lookup_cell(res), status=got["status"]),
               dict(exp, why=mwhy if not mok else ""),
               match=compare.same_delivery(got, exp))
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


def publication(run):
    """Publish the first purchase's batch to the local relay and confirm
    delivery, then issue another batch and show that publication waits for
    finality and anchor coverage, then publish and deliver that one."""
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
    oid, _ = run.buy(scen, SPACE_A, "two")
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
    _publish_and_deliver(run, p, scen, bid)
    r.step(scen, None, "every /publish call of the run", {"calls": p.calls}, required=False,
           note="no call had an empty list or more than 100 handles; the relay's /peek "
                "was never read")


def main(argv):
    from . import scenarios
    scenarios.publication = publication
    return scenarios.main(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
