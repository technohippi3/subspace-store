"""Ed25519 manifests, deterministic release archives and bounded extraction."""
import argparse
import hashlib
import gzip
import json
import os
from pathlib import Path
import re
import stat
import tarfile
import tempfile

from source_provenance import validate_payload
from common import ID, Refused, command, json_file, public_directory, require, sync_directory

MAX_ARTIFACT = 4 * 1024**3
# Semantic versions are part of the rollback fence, independently of SQLite DDL.
SCHEMAS = {"store": 1, "controller": 1, "storeJournal": 2, "controllerJournal": 2,
           "applicationRecords": 2, "controllerRecords": 2, "recoveryEnvelope": 1}


def digest_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        while data := file.read(1024 * 1024):
            digest.update(data)
    return digest.hexdigest()


def safe_path(value):
    require(isinstance(value, str) and 1 <= len(value) <= 4096 and
            not value.startswith("/") and all(p and p not in (".", "..")
            and re.fullmatch(r"[a-zA-Z0-9_.@+,:=-]+", p) for p in value.split("/")), "unsafe-release-path")


def verify(manifest_path, signature, artifact, trust_key):
    require(Path(manifest_path).stat().st_size <= 16 * 1024 * 1024 and Path(signature).stat().st_size == 64,
            "invalid-release-signature")
    # The pre-existing trust key is never sourced from this release/download.
    key = Path(trust_key)
    require(key.is_file() and not key.is_symlink() and key.stat().st_uid in (0,os.geteuid()) and not key.stat().st_mode & 0o022, "unsafe-release-key")
    raw_manifest = Path(manifest_path).read_bytes()
    raw_signature = Path(signature).read_bytes()
    require(len(raw_manifest) <= 16 * 1024 * 1024 and len(raw_signature) == 64, "invalid-release-signature")
    try:
        public_type = command(["/usr/bin/openssl", "pkey", "-pubin", "-in", str(key), "-text", "-noout"])
        require(public_type.startswith(b"ED25519 Public-Key:"), "unsupported-release-key")
        with tempfile.TemporaryDirectory(prefix="subspace-verify-") as temporary:
            saved_manifest, saved_signature = Path(temporary) / "manifest", Path(temporary) / "signature"
            saved_manifest.write_bytes(raw_manifest)
            saved_signature.write_bytes(raw_signature)
            command(["/usr/bin/openssl", "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", str(key),
                     "-in", str(saved_manifest), "-sigfile", str(saved_signature)])
    except Refused:
        raise Refused("invalid-release-signature") from None
    manifest = json.loads(raw_manifest)
    require(set(manifest) == {"format", "release", "sourceCommit", "platform", "schemas", "upgradeFrom", "rollbackTo", "artifact", "files"} and
            manifest["format"] == 1 and ID.fullmatch(manifest["release"]) and
            re.fullmatch(r"[0-9a-f]{40}", manifest["sourceCommit"]), "invalid-release-manifest")
    require(manifest["platform"] == "linux-x86_64" and manifest["schemas"] == SCHEMAS, "unsupported-release-schema")
    require(isinstance(manifest["upgradeFrom"], list) and all(ID.fullmatch(r) for r in manifest["upgradeFrom"]))
    require(isinstance(manifest["rollbackTo"], list) and all(ID.fullmatch(r) for r in manifest["rollbackTo"]))
    item = manifest["artifact"]
    require(set(item) == {"size", "sha256"} and type(item["size"]) is int and
            0 < item["size"] <= MAX_ARTIFACT and Path(artifact).stat().st_size == item["size"] and
            digest_file(artifact) == item["sha256"], "artifact-digest-mismatch")
    require(isinstance(manifest["files"], dict) and 1 <= len(manifest["files"]) <= 100000)
    for path, entry in manifest["files"].items():
        safe_path(path)
        require(set(entry) == {"sha256", "size", "executable"} and
                re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]) and type(entry["size"]) is int and
                0 <= entry["size"] <= 512 * 1024 * 1024 and type(entry["executable"]) is bool)
    manifest["_digest"] = hashlib.sha256(raw_manifest).hexdigest()
    return manifest


def extract(artifact, destination, manifest):
    destination = Path(destination)
    public_directory(destination)
    seen = set()
    total = 0
    with tarfile.open(artifact, "r:gz") as archive:
        for member in archive:
            safe_path(member.name)
            require(member.isfile() and member.name not in seen and member.name in manifest["files"], "unsafe-release-archive")
            entry = manifest["files"][member.name]
            total += member.size
            require(member.size == entry["size"] and total <= MAX_ARTIFACT and len(seen) < 100000, "unsafe-release-archive")
            seen.add(member.name)
            path = destination / member.name
            public_directory(path.parent, parents=True, exist_ok=True)
            with archive.extractfile(member) as source, path.open("xb") as target:
                remaining = member.size
                while remaining:
                    data = source.read(min(1024 * 1024, remaining))
                    require(data, "truncated-release")
                    target.write(data)
                    remaining -= len(data)
                target.flush()
                os.fsync(target.fileno())
            require(digest_file(path) == entry["sha256"], "release-file-digest-mismatch")
            path.chmod(0o755 if entry["executable"] else 0o644)
    require(seen == set(manifest["files"]), "incomplete-release")
    for path in sorted((p for p in destination.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        sync_directory(path)
    sync_directory(destination)


def build(source, output, release, source_commit, signing_key, upgrade_from, rollback_to=None):
    source, output, signing_key = Path(source).resolve(), Path(output).resolve(), Path(signing_key).resolve()
    require(ID.fullmatch(release) and re.fullmatch(r"[0-9a-f]{40}", source_commit))
    require(not signing_key.is_relative_to(source) and not output.is_relative_to(source), "release-input-overlap")
    require(signing_key.is_file() and not signing_key.stat().st_mode & 0o077, "unsafe-signing-key")
    validate_payload(source, source_commit, safe_path)
    output.mkdir(parents=True, exist_ok=True)
    files = {}
    total = 0
    artifact = output / (release + ".tar.gz")
    with artifact.open("xb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed, tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for path in sorted(source.rglob("*")):
            require(not path.is_symlink(), "unsafe-release-source")
            if path.is_dir():
                continue
            relative = path.relative_to(source).as_posix()
            safe_path(relative)
            require(path.is_file() and path.stat().st_nlink == 1 and
                    not any(p in (".git", ".alchemy", ".env", "__pycache__") for p in path.relative_to(source).parts) and
                    path.suffix not in (".pem", ".key", ".db", ".sqlite", ".cookie", ".cred"), "private-release-input")
            info = path.stat()
            total += info.st_size
            require(info.st_size <= 512 * 1024 * 1024 and total <= MAX_ARTIFACT and len(files) < 100000, "release-too-large")
            files[relative] = {"sha256": digest_file(path), "size": info.st_size, "executable": bool(info.st_mode & 0o111)}
            member = tarfile.TarInfo(relative)
            member.size = info.st_size
            member.mode = 0o755 if info.st_mode & 0o111 else 0o644
            member.mtime = 0
            with path.open("rb") as file:
                archive.addfile(member, file)
    manifest = {"format": 1, "release": release, "sourceCommit": source_commit, "platform": "linux-x86_64",
                "schemas": dict(SCHEMAS), "upgradeFrom": upgrade_from, "rollbackTo": rollback_to or [],
                "artifact": {"size": artifact.stat().st_size, "sha256": digest_file(artifact)}, "files": files}
    manifest_path = output / (release + ".manifest.json")
    manifest_path.write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n")
    signature = output / (release + ".manifest.sig")
    command(["/usr/bin/openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(signing_key),
             "-in", str(manifest_path), "-out", str(signature)])
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--release", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--signing-key", required=True)
    parser.add_argument("--upgrade-from", action="append", default=[])
    parser.add_argument("--rollback-to", action="append", default=[])
    args = parser.parse_args()
    try:
        result = build(args.source, args.output, args.release, args.source_commit, args.signing_key, args.upgrade_from, args.rollback_to)
        print(json.dumps({"ok": True, "release": result["release"], "sha256": result["artifact"]["sha256"]}))
    except Exception:
        print(json.dumps({"ok": False, "code": "release-build-refused"}))
        raise SystemExit(2)
