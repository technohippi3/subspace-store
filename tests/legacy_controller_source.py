"""Export exact repository revisions as disposable, non-Git test fixtures."""
import io
import pathlib
import subprocess
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
REVISIONS = ("c63e96b", "a2d0afb", "8bb7312", "7d43c77")


def export_revision(destination, revision, *paths):
    if revision not in REVISIONS:
        raise ValueError("unsupported legacy fixture revision")
    commit = subprocess.check_output(["git", "rev-parse", revision + "^{commit}"], cwd=ROOT, text=True).strip()
    raw = subprocess.check_output(["git", "archive", "--format=tar", commit, *paths], cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        archive.extractall(destination, filter="data")
    return commit
