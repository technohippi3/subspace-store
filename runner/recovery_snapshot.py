"""Validate the TypeScript coordinated recovery set before copying subs."""
import hashlib
import sqlite3
from pathlib import Path

from controller.errors import Refused


def validate_snapshot(snapshot, manifest, inventory, controller_position):
    files = manifest.get("files")
    if not isinstance(files, dict) or any(Path(p).is_absolute() or ".." in Path(p).parts for p in files):
        raise Refused("invalid coordinated recovery manifest")
    actual = {str(p.relative_to(snapshot)) for p in snapshot.rglob("*") if p.is_file() and p.relative_to(snapshot) != Path("manifest.json")}
    if any(p.is_symlink() for p in snapshot.rglob("*")) or actual != set(files) or any((snapshot / p).is_symlink() or hashlib.sha256((snapshot / p).read_bytes()).hexdigest() != h for p, h in files.items()):
        raise Refused("coordinated recovery set does not match its manifest")
    if type(manifest.get("store_journal")) is not int or not 0 <= manifest["store_journal"] <= inventory["sequence"] or \
            type(manifest.get("controller_journal")) is not int or not 0 <= manifest["controller_journal"] <= controller_position:
        raise Refused("coordinated snapshot exceeds journal history")
    with sqlite3.connect((snapshot / "registry.db").resolve().as_uri() + "?mode=ro", uri=True) as db:
        row = db.execute("select store from store_meta where id=1").fetchone()
        if not row or row[0] != inventory["store"]:
            raise Refused("coordinated snapshot belongs to a different store")
