#!/usr/bin/env python3
"""Prepare one complete native payload from reviewed source and digest pins."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

from common import command, json_file, require
from release import digest_file
from source_provenance import snapshot, sha, REQUIRED

UPSTREAM = {'spaced','space-cli','subs','subs-prover','certrelay'}
PATCHES = {'subs-u1b-attach-commit-txid.patch','subs-fabric-seed.patch','subs-loopback.patch'}

# Cargo.lock digests from the exact upstream commits in regtest/pins.env.
LOCKS = {'spaces':'5fce772195dabf62ccbec43e873ed0ecbd249bcc958630775393ce69fb8c29c1',
         'subs':'ed20b7420f32c7f55f0a5c8853516b38c03af2a8c20aed91643c354668720434',
         'certrelay':'68e032f219a2fb43fa1e32d671277ef432633489f031d960bb68e7389b40ae77'}
VERIFIER_INPUTS = {'regtest/verifier/Cargo.toml','regtest/verifier/Cargo.lock','regtest/verifier/src/main.rs','regtest/verifier/src/lib.rs'}


def public_manifest(source, destination, maximum=65536):
    json_file(source, maximum)  # Preserve the protected producer boundary.
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        require(digest_file(destination) == digest_file(source), 'native-build-manifest-mismatch')
    else:
        shutil.copyfile(source, destination)
        destination.chmod(0o644)
    return json_file(destination, maximum)  # Validate the actual copied bytes.


def upstream(repository, built, name, record, source):
    component = {'spaced':'spaces','space-cli':'spaces','subs':'subs','subs-prover':'subs','certrelay':'certrelay'}[name]
    pins = dict(line.split('=',1) for line in (repository/'regtest/pins.env').read_text().splitlines()
                if line.startswith(('SPACES_COMMIT=','SUBS_COMMIT=','CERTRELAY_COMMIT=')))
    expected = pins[{'spaces':'SPACES_COMMIT','subs':'SUBS_COMMIT','certrelay':'CERTRELAY_COMMIT'}[component]]
    rows = [row for row in built.get('sources',[]) if row.get('name') == component]
    row = built.get('artifacts',{}).get(name,{})
    arguments = {'spaces':['-p','spaces_client','--bin','spaced','--bin','space-cli'],
        'subs':['-p','subs','--bin','subs'],'subs-prover':['-p','subs-prover','--bin','subs-prover'],
        'certrelay':['-p','relay','--bin','certrelay']}['subs-prover' if name=='subs-prover' else component]
    require(built.get('version') == 1 and built.get('complete') is True and set(built.get('artifacts',{})) == UPSTREAM and
        len(rows) == 1 and rows[0].get('commit') == expected and row.get('component') == component and row.get('sourceCommit') == expected and
        rows[0].get('cargoLockSha256') == row.get('cargoLockSha256') == LOCKS[component] and
        row.get('version') == record['version'] and row.get('sha256') == record['sha256'] and row.get('bytes') == source.stat().st_size and
        row.get('operatorPrivatePathPrefixesPresent') is False and isinstance(row.get('effectivePackageFeatures'),list) and
        set(row['effectivePackageFeatures']) <= {'default'} and
        row.get('command') == ['cargo','+1.94.1','build','--release','--locked','--offline',*arguments], 'unqualified-upstream-artifact')
    policy = built.get('buildPolicy',{})
    require(policy.get('toolchain') == '1.94.1' and policy.get('target') == 'x86_64-unknown-linux-gnu' and
        policy.get('gpuFeatures') is False and policy.get('testRigFeature') is False and policy.get('publishedGuestProgramsRebuilt') is False,
        'unsupported-upstream-build-profile')
    patches = {patch:digest_file(repository/'regtest/upstream'/patch) for patch in PATCHES}
    require(row.get('appliedPatches') == (patches if component == 'subs' else {}) and
        (component != 'subs' or built.get('patches') == patches), 'required-subs-capabilities-not-pinned')
    return row


def assemble(repository, native_profile, destination, packaging_source):
    repository, destination, packaging_source = Path(repository).resolve(), Path(destination).resolve(), Path(packaging_source).resolve()
    require(packaging_source == repository/"deploy", "canonical-packaging-source-required")
    before = snapshot(repository)
    require(not destination.exists() and not destination.is_relative_to(repository), "payload-path-overlap")
    profile = json_file(native_profile)
    require(set(profile) == {"version", "artifacts"} and profile["version"] == 1 and set(profile["artifacts"]) == REQUIRED,
            "complete-native-profile-required")
    destination.mkdir(mode=0o755, parents=True)
    (destination / "bin").mkdir()
    native = {}
    for name, record in profile["artifacts"].items():
        required = {"source", "sha256", "version"} | ({"artifactManifest"} if name in UPSTREAM | {'subspace-export','subspace-verifier'} else set())
        require(set(record) == required and isinstance(record["version"], str) and record["version"], "invalid-native-profile")
        source = Path(record["source"])
        require(source.is_file() and not source.is_symlink() and source.stat().st_size > 0 and
                digest_file(source) == record["sha256"], "native-artifact-digest-mismatch")
        shutil.copyfile(source, destination / "bin" / name)
        (destination / "bin" / name).chmod(0o755)
        require(digest_file(destination/"bin"/name) == record["sha256"], "copied-native-artifact-digest-mismatch")
        native[name] = {"path": "bin/" + name, "sha256": record["sha256"], "version": record["version"]}
        if name in UPSTREAM:
            manifest_path=destination/'share/native/upstream-build.manifest.json'
            built=public_manifest(record['artifactManifest'],manifest_path,1024*1024)
            row=upstream(repository,built,name,record,source)
            require(not Path(row['path']).is_absolute() and '..' not in Path(row['path']).parts and
                (Path(record['artifactManifest']).parent/row['path']).resolve()==source.resolve(),'upstream-artifact-path-mismatch')
            native[name]['artifactManifest']=manifest_path.relative_to(destination).as_posix()
        if name=='subspace-verifier':
            manifest_path=destination/'share/native/subspace-verifier.manifest.json'
            verified=public_manifest(record['artifactManifest'],manifest_path)
            require(verified.get('binarySha256')==record['sha256'] and verified.get('library')=='libveritas-0.4.4' and
                verified.get('spacesNums')=='0.4.2' and verified.get('remappedBuildPaths') is True and
                verified.get('target')=='x86_64-unknown-linux-gnu' and set(verified.get('inputs',{}))==VERIFIER_INPUTS and
                all(digest_file(repository/path)==digest for path,digest in verified['inputs'].items()),'verifier-source-profile-mismatch')
            native[name]['artifactManifest']=manifest_path.relative_to(destination).as_posix()
        if name == "subspace-export":
            manifest_path = destination / "share/native/subspace-export.manifest.json"
            exported = public_manifest(record["artifactManifest"],manifest_path)
            require(exported.get("binarySha256") == record["sha256"] and exported.get("remappedBuildPaths") is True and
                    exported.get("library")=="libveritas-0.4.4" and exported.get("spacesNums")=="0.4.2" and exported.get("target")=="x86_64-unknown-linux-gnu" and
                    exported.get("profiles") == ["spacecert-v1", "spacemsg-0.4.4"], "export-artifact-profile-mismatch")
            inputs={'native/export/Cargo.toml':'cargoTomlSha256','native/export/Cargo.lock':'lockSha256','native/export/src/main.rs':'sourceSha256'}
            require(all(digest_file(repository/path)==exported.get(field) for path,field in inputs.items()),'export-source-profile-mismatch')
            native[name]['sourceInputs']={path:digest_file(repository/path) for path in [*inputs,'tools/build_native_export.py','native/export/rust-toolchain.toml']}
            native[name]["artifactManifest"] = manifest_path.relative_to(destination).as_posix()
    require(native["node"]["version"] == "24.14.0" and native["bitcoind"]["version"] == native["bitcoin-cli"]["version"] == "31.2", "unsupported-native-version")
    (destination / "app/ts").mkdir(parents=True)
    shutil.copytree(repository / "ts/src", destination / "app/ts/src")
    for name in ("package.json", "package-lock.json"):
        shutil.copyfile(repository / "ts" / name, destination / "app/ts" / name)
    command(["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=destination / "app/ts", timeout=300)
    for name in ("controller", "runner", "service"):
        shutil.copytree(repository / name, destination / "app" / name, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for name in ("native", "client", "recovery"):
        shutil.copytree(packaging_source / name, destination / name, ignore=shutil.ignore_patterns("test*", "__pycache__", "*.pyc"))
    (destination / "native-artifacts.json").write_text(json.dumps({"version": 1, "requires": {
        "platform": "linux-x86_64", "systemd": 255, "python": "3.12", "opensslMajor": 3}, "artifacts": native}, sort_keys=True) + "\n")
    (destination / "native-artifacts.json").chmod(0o644)
    require(snapshot(repository) == before, 'source-changed-during-assembly')
    require(all(sha(destination/path) == digest for path,digest in before['payloadInputs'].items()), 'copied-source-input-differs')
    provenance = destination/'source-provenance.json'
    provenance.write_text(json.dumps(before,sort_keys=True,separators=(',',':'))+'\n')
    provenance.chmod(0o644)
    return {"sourceCommit": before['sourceCommit'], "artifacts": {name: record["sha256"] for name, record in native.items()}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for option in ("repository", "native-profile", "destination", "packaging-source"):
        parser.add_argument("--" + option, required=True)
    args = parser.parse_args()
    try:
        result = assemble(args.repository, args.native_profile, args.destination, args.packaging_source)
        print(json.dumps({"ok": True, **result}))
    except Exception:
        print(json.dumps({"ok": False, "code": "complete-native-payload-unavailable"}))
        raise SystemExit(2)
