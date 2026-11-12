#!/usr/bin/env python3
"""One attended native installer; Alchemy invokes this same entrypoint."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import platform
import re
import shutil
import tempfile
import time

from common import Refused, atomic_json, command, config, json_file, paths, require, sync_directory
from checkpoint import checkpoint, recovery
from fence import acquire
from host import lifecycle, maintenance, pause, unknown_invoice_count
from release import digest_file, extract, verify
from units import control, prepare, stopped, unit


def capabilities(value):
    require(os.geteuid() == 0 and platform.system() == "Linux" and platform.machine() == "x86_64", "unsupported-host")
    require(Path("/proc/1/comm").read_text().strip() == "systemd", "systemd-pid1-required")
    version = command(["/usr/bin/systemctl", "--version"]).decode().splitlines()[0]
    require(int(version.split()[1]) == 255, "systemd-255-required")
    for name in ("releaseDirectory", "baseDirectory"):
        path = Path(value[name])
        while not path.exists():
            path = path.parent
        require(not path.is_symlink() and shutil.disk_usage(path).free >= value["minimumFreeBytes"], "insufficient-storage")


def stage(value, manifest, artifact):
    parent = Path(value["releaseDirectory"])
    parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    target = parent / manifest["release"]
    if target.exists():
        require(target.is_dir() and not target.is_symlink() and
                json_file(target / ".verified-manifest.json", 16 * 1024 * 1024).get("_digest") == manifest["_digest"], "release-id-reused")
        for name, entry in manifest["files"].items():
            require(not (target / name).is_symlink() and digest_file(target / name) == entry["sha256"], "installed-release-modified")
        return target
    temporary = parent / (".stage-" + next(tempfile._get_candidate_names()))
    extract(artifact, temporary, manifest)
    atomic_json(temporary / ".verified-manifest.json", manifest)
    os.rename(temporary, target)
    sync_directory(parent)
    return target


def current_receipt(value):
    file = paths(value)["receipt"]
    return json_file(file) if file.exists() else None


def select(value, target):
    path = Path(value["currentPath"])
    temporary = path.parent / (".current-" + next(tempfile._get_candidate_names()))
    os.symlink(target, temporary)
    os.replace(temporary, path)
    sync_directory(path.parent)


def fetch_runtime(value):
    roles = json_file(value["secretsConfig"])["roles"]
    for role in roles:
        command(["/usr/bin/systemctl", "start", "subspace-secrets-" + value["installation"] + "-" + role + ".service"], timeout=35)


def live_ready(value, release, minimum_review=0):
    report = maintenance(value)
    require(report["paused"] and report["ready"] and report["acknowledged"] and
            not report["blockers"] and report["chain"] is not None and
            report["reviewCount"] >= minimum_review, "replacement-not-ready")
    proof=lifecycle(value, release, "controllerReadiness")
    return {**report,'productionReady':proof.get('productionReady',True),'waitingSellerSetup':proof.get('waitingSellerSetup',False)}


def resume_admission(record, report, unknown):
    return not record['priorPaused'] and unknown==0 and report['reviewCount']==record['reviewCount'] and report.get('productionReady',True)


def status(value):
    state = paths(value)
    receipt = current_receipt(value)
    if os.path.lexists(state['lock'].parent/'recovery.json'):
        return {'ok':True,'ready':False,'paused':True,'release':None if receipt is None else receipt['release'],'diagnostic':'attended-recovery-required'}
    if os.path.lexists(state["latch"]):
        latch = json_file(state["latch"])
        return {"ok": True, "ready": False, "paused": True, "release": None if receipt is None else receipt["release"],
                "diagnostic": latch.get("diagnostic", latch.get("phase", "maintenance"))}
    if receipt is None:
        return {"ok": True, "ready": False, "paused": True, "release": None, "diagnostic": "not-installed"}
    try:
        report = maintenance(value)
        proof=lifecycle(value, Path(value["currentPath"]).resolve(), "controllerReadiness")
        return {"ok": True, "ready": report["acknowledged"] and report["chain"] is not None and
                not [b for b in report["blockers"] if b["kind"] != "admission_open"],
                "paused": report["paused"], "release": receipt["release"], "manifestDigest": receipt["manifestDigest"],
                'productionReady':proof.get('productionReady',True),'waitingSellerSetup':proof.get('waitingSellerSetup',False)}
    except Exception:
        return {"ok": True, "ready": False, "paused": True, "release": receipt["release"], "diagnostic": "readiness-unavailable"}


def _apply(value, manifest_file, signature, artifact, *, dry_run=False, rollback=False):
    manifest = verify(manifest_file, signature, artifact, value["trustKey"])
    capabilities(value)
    require(not os.path.lexists(paths(value)['lock'].parent/'recovery.json'),'attended-recovery-required')
    old = current_receipt(value)
    if old and old["manifestDigest"] != manifest["_digest"]:
        require(old["schemas"] == manifest["schemas"], "incompatible-schema")
        require(manifest["release"] in old.get("rollbackTo", []) if rollback else old["release"] in manifest["upgradeFrom"], "unsupported-upgrade")
    if dry_run:
        return {"ok": True, "dryRun": True, "release": manifest["release"]}
    target = stage(value, manifest, artifact)
    state = paths(value)
    resume = json_file(state["latch"]) if os.path.lexists(state["latch"]) else None
    if resume:
        if resume.get("target") != manifest["release"] or resume.get("manifestDigest") != manifest["_digest"]:
            require(rollback and old and manifest["release"] in old.get("rollbackTo", []), "different-update-pending")
            resume.update(target=manifest["release"], manifestDigest=manifest["_digest"])
    if not old:
        prepare(value, target)
    else:
        require(state["lock"].is_file(), "missing-lifecycle-ownership")
    if not resume and old and old["manifestDigest"] == manifest["_digest"] and status(value)["ready"]:
        return {"ok": True, "unchanged": True, **status(value)}
    # Checks happen while the previous release still runs.
    fetch_runtime(value)
    lifecycle(value, target, "preflight")
    command([str(target / "bin/node"), str(target / "native/proxy.mjs"), "--check-tls", value["_file"]])
    recovery(value, target, {"op": "probe"})
    if resume:
        record = resume
    elif old:
        before = maintenance(value)
        blockers = [b for b in before["blockers"] if b["kind"] != "admission_open"]
        if blockers:
            raise Refused("maintenance-blocked", blockers)
        require(before["acknowledged"] and before["chain"] is not None, "maintenance-blocked")
        pause(value)
        after = maintenance(value)
        require(after["paused"] and after["ready"] and not after["blockers"] and after["acknowledged"], "maintenance-blocked")
        record = {"version": 1, "phase": "stopping", "target": manifest["release"], "manifestDigest": manifest["_digest"],
                  "priorPaused": before["paused"], "reviewCount": before["reviewCount"], "checkpoint": None}
    else:
        record = {"version": 1, "phase": "stopping", "target": manifest["release"], "manifestDigest": manifest["_digest"],
                  "priorPaused": True, "reviewCount": 0, "checkpoint": None}
    atomic_json(state["latch"], record)
    ownership = None
    try:
        control(value, "stop")
        stopped(value)
        ownership = acquire(state["lock"], exclusive=True)
        # Runtime masking works because installer units live under /usr/lib.
        command(["/usr/bin/systemctl", "mask", "--runtime", unit(value, "subs")])
        require(command(["/usr/bin/systemctl", "show", unit(value, "subs"), "--property=LoadState", "--value"]).strip() == b"masked", "subs-restart-not-fenced")
        record["phase"] = "checkpointing"
        atomic_json(state["latch"], record)
        if old and not record["checkpoint"]:
            name = str(int(time.time() * 1000)) + "-update-" + next(tempfile._get_candidate_names())
            record["checkpoint"] = checkpoint(value, target, name)
            atomic_json(state["latch"], record)
        if not old:
            recovery(value, target, {"op": "snapshot-put", "snapshot": "onboarding-" + value["installation"],
                    "kind": "wallet-backups", "directory": value["walletBackupDirectory"]})
        prepare(value, target)
        select(value, target)
        atomic_json(state["receipt"], {"version": 1, "installation": value["installation"], "release": manifest["release"],
            "manifestDigest": manifest["_digest"], "schemas": manifest["schemas"], "reviewCount": record["reviewCount"],
            "rollbackTo": manifest["rollbackTo"],
            "priorPaused": record["priorPaused"], "checkpoint": record["checkpoint"]})
        record["phase"] = "starting-paused"
        atomic_json(state["latch"], record)
        # Never start a SH owner while holding EX. The durable latch lasts
        # through the complete release switch and is removed just before start.
        state["latch"].unlink()
        sync_directory(state["latch"].parent)
        os.close(ownership)
        ownership = None
        command(["/usr/bin/systemctl", "unmask", "--runtime", unit(value, "subs")])
        control(value, "start", ("subs",))
        runtime = json_file(value["storeConfig"])
        if not Path(runtime["database"]).exists():
            # The ordinary first start creates its own paused ledger. It is
            # then stopped before the same offline reconciliation boundary.
            control(value, "start", ("store",))
            deadline = time.monotonic() + 30
            while True:
                try:
                    initial = maintenance(value)
                    require(initial["paused"] and initial["acknowledged"], "fresh-store-not-paused")
                    break
                except Exception:
                    require(time.monotonic() < deadline, "fresh-store-not-ready")
                    time.sleep(0.1)
            control(value, "stop", ("store",))
        lifecycle(value, target, "reconcile")
        control(value, "start", ("store",))
        deadline = time.monotonic() + 30
        while True:
            try:
                report = live_ready(value, target, record["reviewCount"])
                break
            except Exception:
                require(time.monotonic() < deadline, "replacement-not-ready")
                time.sleep(0.1)
        control(value, "start", ("proxy",))
        deadline = time.monotonic() + 30
        while True:
            try:
                command([str(target / "bin/node"), str(target / "native/proxy.mjs"), "--check-live", value["_file"]])
                break
            except Exception:
                require(time.monotonic() < deadline, "https-not-ready")
                time.sleep(0.1)
        unknown = unknown_invoice_count(value)
        resume=resume_admission(record,report,unknown)
        if resume:
            # Fresh domain and controller checks gate restoration. Ambiguous
            # payment history must remain a domain blocker, never inferred late.
            pause(value, False)
        remain_paused = not resume
        command(['/usr/bin/systemctl','enable',*[unit(value,r) for r in ('store','subs','proxy')]])
        return {"ok": True, "ready": True, "release": manifest["release"], "paused": remain_paused,
                "manifestDigest": manifest["_digest"], "reviewCount": report["reviewCount"], "unknownInvoiceCount": unknown,
                "reviewRequired": unknown > 0 or report['reviewCount'] != record['reviewCount'] or report.get('waitingSellerSetup',False),
                'productionReady':report.get('productionReady',True),'waitingSellerSetup':report.get('waitingSellerSetup',False)}
    except BaseException as error:
        record["phase"] = "failed-paused"
        record["diagnostic"] = error.code if isinstance(error, Refused) else "maintenance-failed"
        atomic_json(state["latch"], record)
        try:
            pause(value)
        except Exception:
            pass
        try:
            control(value, "stop")
        except Exception:
            pass
        raise
    finally:
        if ownership is not None:
            os.close(ownership)


def apply(value, manifest_file, signature, artifact, *, dry_run=False, rollback=False):
    capabilities(value)
    if dry_run:return _apply(value,manifest_file,signature,artifact,dry_run=True,rollback=rollback)
    directory=paths(value)['lock'].parent
    directory.mkdir(parents=True,exist_ok=True,mode=0o755)
    require(not directory.is_symlink() and directory.stat().st_uid==0 and not directory.stat().st_mode&0o022,'unsafe-lifecycle-directory')
    fd=os.open(directory/'updater.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        info=os.fstat(fd);require(info.st_nlink==1 and info.st_uid==0 and not info.st_mode&0o077,'unsafe-updater-lock')
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise Refused('installation-update-busy') from None
        return _apply(value,manifest_file,signature,artifact,dry_run=dry_run,rollback=rollback)
    finally:os.close(fd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    sub = parser.add_subparsers(dest="operation", required=True)
    sub.add_parser("status")
    recovery_action=sub.add_parser('recover');recovery_action.add_argument('--confirm',required=True);recovery_action.add_argument('--attended-credentials',action='store_true')
    action = sub.add_parser("apply")
    for option in ("manifest", "signature", "artifact"):
        action.add_argument("--" + option, required=True)
    action.add_argument("--dry-run", action="store_true")
    action.add_argument("--rollback", action="store_true")
    args = parser.parse_args()
    try:
        value = config(args.config)
        if args.operation=='status':result=status(value)
        elif args.operation=='recover':
            from recover import recover
            result=recover(value,args.confirm,args.attended_credentials)
        else:result=apply(value,args.manifest,args.signature,args.artifact,dry_run=args.dry_run,rollback=args.rollback)
        print(json.dumps(result, sort_keys=True))
    except Exception as error:
        result = {"ok": False, "paused": True, "code": error.code if isinstance(error, Refused) else "installation-refused"}
        if isinstance(error, Refused) and error.code == "maintenance-blocked" and error.details is not None:
            result["blockers"] = error.details
        print(json.dumps(result))
        raise SystemExit(2)
