"""Publication to a relay and per-handle delivery confirmation.

The publication procedure of CONTROLLER-DESIGN.md, steps 1 to 6:
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

Which relay `subs` publishes to is `subs`' own configuration, not this
module's. On regtest the harness runs `subs` seeded with a local relay only
(`regtest/harness/publication.py`). Results from it are regtest results.
"""

import json
import sqlite3
import subprocess
import urllib.parse

from .core import ANCHOR_FINALITY, FINAL_D, Refused, label
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
    def __init__(self, controller, registry, journal, db_path, subs, relay_url):
        """`subs` is the client for writes to subs, as the controller's;
        `relay_url` the relay that delivery is confirmed through."""
        self.c = controller
        self.reg = registry
        self.journal = journal
        self.subs = subs
        self.db = sqlite3.connect(str(db_path), check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.relay = Http(relay_url, timeout=60)
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
        resp = self.subs.post(f"/spaces/{b['space']}/publish",
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

    def verify_message(self, msg_path, anchors_path):
        """libveritas's verdict on one relay message, from the verifier."""
        proc = subprocess.run([str(self.c.verifier_bin), str(msg_path), str(anchors_path)],
                              capture_output=True, text=True)
        (msg_path.parent / (msg_path.name.replace(".message.bin", "") + ".libveritas.json")
         ).write_text(proc.stdout + proc.stderr)
        return json.loads(proc.stdout) if proc.stdout.strip().startswith("{") else \
            {"verified": False, "error": proc.stderr[-500:]}

    def root_gate(self, space, root, height):
        """The certificate's own root, the one the relay's answer carries:
        it must be a commitment of the space on the active chain, at
        d >= 150, with an anchor that covers it (L9). `subs` builds a
        certificate against the space's latest commitment when it publishes
        the handle, so this root can be later than the batch's (R23, R24).
        The controller's own gate, which certificate verification uses too."""
        return self.c.root_gate(space, root, height)

    def lookup(self, bid, oid):
        """A verified lookup of one handle through the local relay. The relay
        answers `/query` with a message; libveritas verifies it against root
        anchors read from spaced directly. The zones must carry the handle
        and its script_pubkey, under a root that is a commitment of the
        space on chain, no earlier than the batch's. Whether that root is
        final and covered is reported separately, in `root_gate`."""
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
        res = self.verify_message(msg_path, out_dir / "anchors.json")
        zones = res.get("zones", [])
        zone = next((z for z in zones if z["handle"] == handle), None)
        space_zone = next((z for z in zones if z["handle"] == b["space"]), None)
        root = space_zone["commitment_root"] if space_zone else None
        height = space_zone["commitment_height"] if space_zone else None
        gate = self.root_gate(b["space"], root, height)
        live = self.c.onchain_commitment(b["space"]) or {}
        checks = {
            "verified": res.get("verified", False),
            "handle": zone is not None,
            "script_pubkey": bool(zone and zone["script_pubkey"] == o["recipient_spk"]),
            "root_on_chain": gate["on_chain"],
            "root_not_before_batch": bool(height is not None and b["mined_height"] is not None
                                          and height >= b["mined_height"]),
            # "pending" is libveritas waiting for an anchor that covers the
            # root (L6, R11), not a mismatch; confirm_delivery waits on it.
            "sovereign_or_pending": bool(zone and zone["sovereignty"] in ("sovereign", "pending")),
        }
        return {"handle": handle, "ok": all(checks.values()), "checks": checks,
                "sovereignty": zone["sovereignty"] if zone else None,
                "root_gate": gate,
                "root_is_the_batchs": root == b["root"],
                "root_is_live": bool(live and root == live.get("state_root")),
                "zone": zone, "space_zone": space_zone, "error": res.get("error"),
                "message_bytes": len(msg), "relay_answer": "HTTP 200", "artifacts": str(out_dir)}

    def confirm_delivery(self, bid, oid):
        """Step 6 for one handle: only a published handle is looked up, the
        live check runs again immediately before, and only a verified lookup
        that matches, under a root that is final and covered and with the
        handle sovereign, marks the order fulfilled. A matching answer whose
        root isn't final and covered yet, or that libveritas still answers
        "pending", is waiting, not a failure: nothing is alerted."""
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
        gate = found["root_gate"]
        if not gate["ok"] or found["sovereignty"] != "sovereign":
            why = (f"waiting: the certificate's root is at d = {gate['depth']}" if not gate["final"]
                   else "waiting: no anchor covers the certificate's root yet" if not gate["covered"]
                   else "waiting: libveritas still answers pending")
            return {"confirmed": False, "waiting": True, "why": why, "lookup": found,
                    "live": live}
        if row["state"] != "delivered":
            self.db.execute("update publication set state = 'delivered' where bid = ? and oid = ?",
                            (bid, oid))
            self._journal(bid)
            self.reg.mark_fulfilled(oid)
        return {"confirmed": True, "live": live, "lookup": found}
