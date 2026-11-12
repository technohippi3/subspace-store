"""Certificate verification through the configured libveritas executable."""
import hashlib
import json
import subprocess

from .commitments import ANCHOR_FINALITY
from .errors import Refused


class CertificateVerification:
    def verify_certificates(self, bid):
        """Fetch each member's certificate message from subs, read the root
        anchors from spaced directly, verify with libveritas, and compare
        handle, script_pubkey and root with the batch record. The root is
        the batch's own, or a later commitment of the same space that is on
        the active chain, final and covered (A19)."""
        self.require_restored()
        typed = getattr(self.registry, "bound_entries", False)
        current = None
        if typed:
            self.watch(bid)
        b = self.batch(bid)
        if b["state"] != "final":
            raise Refused("not final")
        if typed:
            current = self.registry.commitment_status(b)
            if not current["acknowledged"] or not current["observation"] or not current["observation"]["covered"]:
                raise Refused("certificate observation not confirmed and covered")
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
            if typed and (not isinstance(msg, bytes) or not 0 < len(msg) <= 1_048_576):
                raise Refused("certificate message exceeds its bound or is empty")
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
            root = space_zone and space_zone.get("commitment_root")
            height = space_zone and space_zone.get("commitment_height")
            own = root == b["root"] and height == b["mined_height"]
            gate = None
            if space_zone and not own and root != b["root"] and height is not None \
                    and height > b["mined_height"]:
                # subs builds a certificate on the space's latest commitment
                # when it is fetched, so after a later batch it proves
                # inclusion in that later root (R23, R24). It counts once
                # that root is a commitment of the space on the active chain
                # at the height the certificate states, final and covered,
                # with the batch's own root still on chain.
                gate = self.root_gate(b["space"], root, height)
                gate["own_root_on_chain"] = self._on_chain_at(b["space"], b["root"],
                                                              b["mined_height"])
            later_ok = bool(gate and gate["ok"] and gate["own_root_on_chain"])
            checks = {
                "verified": out.get("verified", False),
                "handle": zone is not None,
                "script_pubkey": bool(zone and zone["script_pubkey"] == o["recipient_spk"]),
                "root": own or later_ok,
                "root_height": own or later_ok,
                "sovereign": bool(zone and zone["sovereignty"] == "sovereign"),
            }
            if typed:
                checks["verified"] = out.get("verified") is True and proc.returncode == 0
            ok = all(checks.values())
            # A later root on chain that isn't final or covered yet is
            # waiting, not a failure: nothing is alerted, and the
            # certificate is checked again later (L9). Only a sovereign or
            # pending zone waits; libveritas's dependent state is a failure
            # whatever the root's depth, and is alerted.
            waiting = bool(not ok and gate and gate["on_chain"] and gate["own_root_on_chain"]
                           and not gate["ok"] and checks["verified"] and checks["handle"]
                           and checks["script_pubkey"]
                           and zone["sovereignty"] in ("sovereign", "pending"))
            results[m] = {"handle": handle, "ok": ok, "checks": checks, "zone": zone,
                          "artifacts": str(out_dir),
                          "space_zone": space_zone,
                          "root_basis": "batch" if own else ("later" if gate else None),
                          "root_gate": gate, "waiting": waiting,
                          "error": out.get("error"), "message_bytes": len(msg)}
            if ok and typed:
                observed = self._commitment_observation(b)
                if any(observed[k] != current["observation"][k] for k in observed):
                    raise Refused("chain changed during certificate verification; observe and retry")
                digest = hashlib.sha256(msg).hexdigest()
                self.journal.append("certificate_verification", bid=bid, oid=m, entry_key=b["entry_key"],
                                    revision=current["revision"], root=root, height=height, digest=digest, length=len(msg))
                receipt = self.registry.accept_certificate(b, current["revision"], m, root, height, msg)
                if not receipt["acknowledged"]:
                    raise Refused("certificate not acknowledged; readiness withheld")
                results[m]["stored"] = True
            elif ok and o["status"] == "issuing":
                self.registry.mark_ready(m)
            if not ok and not waiting:
                self.alert("certificate_failed", bid, handle)
        return results
