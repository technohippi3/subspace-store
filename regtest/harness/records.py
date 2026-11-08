"""Signed records through a local relay (regtest only).

The buyer gate's record check (docs/BUYER-GATE.md, P3 and M9), exercised
with the harness as the client. A handle is sold to a script whose key the
run holds, issued, published and delivered through the local relay as in
scenario 6. Record sets for it are then signed, sent to the relay's
`/message`, and read back from its `/query`. Each answer is verified with
libveritas against root anchors read from `spaced` directly, never trusting
the relay: libveritas attaches a record set to a zone only if its BIP-340
signature verifies against the zone's current script_pubkey for the zone's
canonical name, and drops one that doesn't without failing the message
(`regtest/verifier`). So each check compares the verified records with the
ones signed, not just the verdict:
- before any record is sent, the answer carries none;
- a set signed with another key is dropped, offline and in the relay's
  answer;
- a set signed with the handle's key is verified and equal to what was
  signed;
- a later set (seq 2) replaces it;
- the earlier set sent again, and a set with seq 3 signed with another key,
  leave seq 2 in place.

The keys are fresh, made by `subspace-regtest-records keygen`, kept in the
run directory outside the kept evidence, and deleted when the scenario
ends. What the relay answers to `/message` is recorded, not required.

Usage: python3 -m regtest.harness.records <run> first_purchase records

It is harness code. Results from it are regtest results.
"""

import json
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

from .procs import relay_enabled, relay_url
from .publication import Publisher, _free_label, _publish_and_deliver, _subs_seed_line


def _tool(run):
    return run.controller.verifier_bin.parent / "subspace-regtest-records"


def _json(proc):
    out = proc.stdout.strip()
    return json.loads(out) if out.startswith("{") else {"error": proc.stderr[-500:]}


class Records:
    def __init__(self, run, handle, space):
        self.run, self.c = run, run.controller
        self.handle, self.space = handle, space
        self.keys = run.stack.dir / "record-signer"
        self.keys.mkdir(mode=0o700)

    def keygen(self, name):
        proc = subprocess.run([str(_tool(self.run)), "keygen", str(self.keys / f"{name}.key")],
                              capture_output=True, text=True)
        out = _json(proc)
        if proc.returncode != 0 or "script_pubkey" not in out:
            raise RuntimeError(f"keygen failed: {out}")
        return out["script_pubkey"]

    def _dir(self, what):
        n = len([d for d in self.c.workdir.iterdir() if d.is_dir()]) + 1
        d = self.c.workdir / f"{n:03d}-records-{what}"
        d.mkdir(parents=True)
        (d / "anchors.json").write_text(json.dumps(self.c.root_anchors()))
        return d

    def verify(self, msg_path):
        proc = subprocess.run([str(self.c.verifier_bin), str(msg_path),
                               str(msg_path.parent / "anchors.json")],
                              capture_output=True, text=True)
        (msg_path.parent / f"{self.handle}.libveritas.json").write_text(proc.stdout + proc.stderr)
        res = _json(proc)
        rec = next((x for x in res.get("records", []) if x["handle"] == self.handle), None)
        zone = next((z for z in res.get("zones", []) if z["handle"] == self.handle), None)
        return {"verified": res.get("verified", False), "error": res.get("error"),
                "script_pubkey": zone and zone["script_pubkey"],
                "sovereignty": zone and zone["sovereignty"],
                "carried": rec and rec["carried"], "dropped": rec and rec["dropped"],
                "records": rec["verified"] if rec else None}

    def query(self, what):
        """The relay's answer for the handle, verified."""
        d = self._dir(what)
        q = urllib.parse.urlencode({"q": f"{self.space},{self.handle}"})
        try:
            with urllib.request.urlopen(relay_url() + f"/query?{q}", timeout=30) as resp:
                msg = resp.read()
        except urllib.error.HTTPError as e:
            return {"verified": False, "relay_answer": f"HTTP {e.code}",
                    "error": e.read().decode(errors="replace")[:300]}
        path = d / f"{self.handle}.message.bin"
        path.write_bytes(msg)
        self.last_answer = path
        return dict(self.verify(path), relay_answer="HTTP 200")

    def sign(self, what, base, records, key):
        """A message for the handle carrying `records` signed with `key`,
        built from the verified relay answer `base`; verified offline
        before it is sent."""
        d = self._dir(what)
        (d / "records.json").write_text(json.dumps(records))
        out = d / f"{self.handle}.message.bin"
        proc = subprocess.run([str(_tool(self.run)), "sign", str(base), str(d / "anchors.json"),
                               self.handle, str(d / "records.json"), str(self.keys / f"{key}.key"),
                               str(out)], capture_output=True, text=True)
        signed = _json(proc)
        if proc.returncode != 0 or not signed.get("signed"):
            raise RuntimeError(f"signing failed: {signed}")
        return out, dict(self.verify(out), signing_ids=signed["signing_ids"])

    def send(self, path):
        req = urllib.request.Request(relay_url() + "/message", data=path.read_bytes(),
                                     method="POST",
                                     headers={"Content-Type": "application/octet-stream"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return {"status": resp.status, "body": resp.read().decode(errors="replace")[:300]}
        except urllib.error.HTTPError as e:
            return {"status": e.code, "body": e.read().decode(errors="replace")[:300]}

    def close(self):
        shutil.rmtree(self.keys, ignore_errors=True)
        return not self.keys.exists()


def _unsigned(records):
    """The records of a verified set other than its signature record."""
    return [x for x in (records or []) if x.get("type") != "sig"]


def _signed_for(records, handle):
    sigs = [x for x in (records or []) if x.get("type") == "sig"]
    return len(sigs) == 1 and sigs[0]["canonical"] == handle and sigs[0]["handle"] == handle


def _expected(seq):
    return [{"type": "seq", "value": seq},
            {"type": "txt", "key": "note", "values": [f"regtest record {seq}"]}]


def _spec(seq):
    return [{"seq": seq}, {"txt": "note", "values": [f"regtest record {seq}"]}]


def records(run):
    from .scenarios import FEE_RATE, SPACE_A

    scen = "9. signed records"
    r, c = run.report, run.controller
    if not relay_enabled():
        raise RuntimeError("records needs SUBSPACE_RELAY=1 and the subs build with "
                           "upstream/subs-fabric-seed.patch; see regtest/run-records.sh")
    seeds = _subs_seed_line(run.stack)
    if seeds != relay_url():
        raise RuntimeError(f"refusing to publish: subs fabric seeds {seeds!r}")
    label = _free_label(run, SPACE_A)
    handle = f"{label}{SPACE_A}"
    rc = Records(run, handle, SPACE_A)
    try:
        owner = rc.keygen("owner")
        other = rc.keygen("other")
        r.step(scen, None, "fresh keys for the handle's owner and for another signer",
               {"owner_script_pubkey": owner, "other_script_pubkey": other,
                "distinct": owner != other}, required=False,
               note="the secrets stay in the run directory, outside kept evidence, "
                    "and are deleted at the end of the scenario")

        m = run.mirror(SPACE_A)
        oid, _ = run.buy(scen, SPACE_A, label, spk=owner)
        run.mine(3)
        m.mine(3)
        run.compare_orders(scen, "P1", "payment at 3 conf converts the hold", [oid], SPACE_A)
        bid, mbid = run.prepare(scen, SPACE_A, [oid])
        c.issue(bid, FEE_RATE)
        m.step("check_and_issue", mbid, "ok")
        run.compare_batch(scen, "B3", f"{bid} broadcast", bid, {"txid": c.batch(bid)["txid"]})
        run.finalize(scen, bid, SPACE_A)
        run.certify(scen, bid, SPACE_A)
        _publish_and_deliver(run, Publisher(run), scen, bid)

        def check(what, got, seq, note=""):
            """A relay answer must verify, for the owner's script, with the
            records of `seq` (None: no records)."""
            want = _expected(seq) if seq else []
            ok = (got["verified"] and got["script_pubkey"] == owner
                  and _unsigned(got["records"]) == want
                  and (seq is None or _signed_for(got["records"], handle)))
            r.step(scen, None, what, got,
                   {"expected (record rule, not the model)":
                    {"verified": True, "script_pubkey": owner, "records": want,
                     "signed_for": handle if seq else None}},
                   match=ok, note=note)
            return ok

        base = rc.query("before")
        check("the relay's answer before any record is sent carries none", base, None)
        base_path = rc.last_answer

        # Another key's set: dropped offline, and absent from the relay's answer.
        wrong, off = rc.sign("other-key-seq1", base_path, _spec(1), "other")
        r.step(scen, None, "a set signed with another key, verified offline", off,
               {"expected (record rule, not the model)": {"verified": True, "carried": True,
                                                          "dropped": True, "records": []}},
               match=bool(off["verified"] and off["carried"] and off["dropped"]
                          and off["records"] == []),
               note="libveritas drops it without failing the message")
        r.step(scen, None, "the relay's answer to that message", rc.send(wrong), required=False)
        check("the relay's answer after another key's set", rc.query("after-other-key"), None)

        # The owner's set: verified, and equal to what was signed.
        first, off = rc.sign("owner-seq1", base_path, _spec(1), "owner")
        r.step(scen, None, "a set signed with the handle's key, verified offline", off,
               {"expected (record rule, not the model)": {"verified": True, "dropped": False,
                                                          "records": _expected(1)}},
               match=bool(off["verified"] and off["carried"] and not off["dropped"]
                          and _unsigned(off["records"]) == _expected(1)
                          and _signed_for(off["records"], handle)))
        r.step(scen, None, "the relay's answer to that message", rc.send(first), required=False)
        check("the relay's answer after the owner's seq 1", rc.query("after-owner-seq1"), 1)

        second, _ = rc.sign("owner-seq2", base_path, _spec(2), "owner")
        r.step(scen, None, "the relay's answer to the owner's seq 2", rc.send(second),
               required=False)
        check("the relay's answer after the owner's seq 2", rc.query("after-owner-seq2"), 2)

        r.step(scen, None, "the relay's answer to the owner's seq 1 sent again",
               rc.send(first), required=False)
        check("the relay's answer after seq 1 is sent again", rc.query("after-replay"), 2,
              note="an older set doesn't replace a newer one")

        late, _ = rc.sign("other-key-seq3", base_path, _spec(3), "other")
        r.step(scen, None, "the relay's answer to another key's seq 3", rc.send(late),
               required=False)
        check("the relay's answer after another key's seq 3", rc.query("after-other-seq3"), 2)
    finally:
        deleted = rc.close()
        r.step(scen, None, "signer keys deleted from the run directory", {"deleted": deleted},
               {"expected (harness rule, not the model)": {"deleted": True}}, match=deleted)


def main(argv):
    from . import scenarios
    scenarios.records = records
    return scenarios.main(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
