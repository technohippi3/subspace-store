"""Bind the native assembly's copied source inputs to one clean Git commit."""
import fnmatch
import hashlib
from pathlib import Path
import re

from common import command, json_file, require

REQUIRED = {"node", "bitcoind", "bitcoin-cli", "spaced", "space-cli", "subs", "subs-prover", "certrelay", "subspace-verifier", "subspace-export"}
EXTRA_INPUTS = {"regtest/pins.env", "regtest/verifier/Cargo.toml", "regtest/verifier/Cargo.lock",
    "regtest/verifier/src/main.rs", "regtest/verifier/src/lib.rs", "native/export/Cargo.toml",
    "native/export/Cargo.lock", "native/export/src/main.rs", "native/export/rust-toolchain.toml",
    "tools/build_native_export.py", *{"regtest/upstream/" + name for name in
        ("subs-u1b-attach-commit-txid.patch", "subs-fabric-seed.patch", "subs-loopback.patch")}}


def copied_path(relative):
    parts = Path(relative).parts
    if relative in {"ts/package.json", "ts/package-lock.json"} or parts[:2] == ("ts", "src"):
        return "app/" + relative
    if parts and parts[0] in {"controller", "runner", "service"}:
        return None if any(p == "__pycache__" or p.endswith(".pyc") for p in parts) else "app/" + relative
    if len(parts) >= 2 and parts[0] == "deploy" and parts[1] in {"native", "client", "recovery"}:
        return None if any(fnmatch.fnmatch(p, "test*") or p == "__pycache__" or p.endswith(".pyc") for p in parts[2:]) else "/".join(parts[1:])
    return None


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while data := file.read(1024 * 1024):
            digest.update(data)
    return digest.hexdigest()


def snapshot(repository):
    repository = Path(repository).resolve()
    git = ["git", "--no-optional-locks", "-C", str(repository)]
    require(Path(command(git + ["rev-parse", "--show-toplevel"]).decode().strip()).resolve() == repository,
            "canonical-source-root-required")
    commit = command(git + ["rev-parse", "HEAD"]).decode().strip()
    require(re.fullmatch(r"[0-9a-f]{40}", commit) and not command(git + ["status", "--porcelain=v1", "--untracked-files=all"]),
            "clean-source-commit-required")
    inputs, payload = {}, {}
    for raw in command(git + ["ls-tree", "-rz", "HEAD"]).split(b"\0"):
        if not raw:
            continue
        attributes, name = raw.split(b"\t", 1)
        relative = name.decode("utf-8")
        target = copied_path(relative)
        if target is None and relative not in EXTRA_INPUTS:
            continue
        mode, kind, blob = attributes.decode().split()
        path = repository / relative
        require(kind == "blob" and mode in {"100644", "100755"} and path.is_file() and not path.is_symlink()
                and path.resolve().is_relative_to(repository), "unsafe-tracked-source-input")
        data = path.read_bytes()
        require(hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest() == blob and
                bool(path.stat().st_mode & 0o111) == (mode == "100755"), "tracked-source-input-differs")
        inputs[relative] = hashlib.sha256(data).hexdigest()
        if target is not None:
            payload[target] = inputs[relative]
    require(EXTRA_INPUTS <= set(inputs), "native-build-inputs-not-tracked")
    actual = set()
    for prefix in ("ts/src", "controller", "runner", "service", "deploy/native", "deploy/client", "deploy/recovery"):
        for path in (repository / prefix).rglob("*"):
            if copied_path(path.relative_to(repository).as_posix()) is not None:
                require(not path.is_symlink() and path.resolve().is_relative_to(repository), "unsafe-copied-source-input")
                if not path.is_dir():
                    actual.add(path.relative_to(repository).as_posix())
    actual.update({"ts/package.json", "ts/package-lock.json"})
    require(actual == {relative for relative in inputs if copied_path(relative) is not None}, "untracked-copied-source-input")
    return {"version": 1, "sourceCommit": commit, "repositoryInputs": inputs, "payloadInputs": payload}


def validate_payload(source, source_commit, safe_path):
    source = Path(source)
    profile_path = source / "native-artifacts.json"
    if not profile_path.exists():
        return  # Generic signed archives need not contain a native inventory.
    profile = json_file(profile_path)
    require(profile.get("version") == 1 and isinstance(profile.get("artifacts"), dict) and
            set(profile["artifacts"]) == REQUIRED, "complete-native-profile-required")
    require((source / "source-provenance.json").is_file(), "native-source-provenance-required")
    proof = json_file(source / "source-provenance.json", 16 * 1024 * 1024)
    require(set(proof) == {"version", "sourceCommit", "repositoryInputs", "payloadInputs"} and proof["version"] == 1 and
            proof["sourceCommit"] == source_commit and isinstance(proof["repositoryInputs"], dict) and proof["repositoryInputs"] and
            isinstance(proof["payloadInputs"], dict) and proof["payloadInputs"], "native-source-provenance-required")
    for relative, digest in proof["repositoryInputs"].items():
        safe_path(relative)
        require(isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest), "invalid-native-source-input")
    expected = {copied_path(relative): digest for relative, digest in proof["repositoryInputs"].items() if copied_path(relative) is not None}
    require(expected == proof["payloadInputs"], "native-source-provenance-differs")
    actual = set()
    for prefix in ("app/ts/src", "app/controller", "app/runner", "app/service", "native", "client", "recovery"):
        actual.update(path.relative_to(source).as_posix() for path in (source / prefix).rglob("*") if not path.is_dir())
    actual.update({"app/ts/package.json", "app/ts/package-lock.json"})
    require(actual == set(expected), "native-source-file-set-differs")
    for relative, digest in expected.items():
        safe_path(relative)
        path = source / relative
        require(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(source.resolve()) and sha(path) == digest,
                "native-source-file-differs")
