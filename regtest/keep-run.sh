#!/usr/bin/env bash
# Keep a finished run in the repository: its report as runs/<run id>.json and
# .md, with the repository's absolute path made relative, and its certificate
# verifications as evidence/<run id>/. Refuses if the copies would contain an
# absolute local path, or a handle label that isn't one of the numbered words.
# Usage: regtest/keep-run.sh <run id>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
RUN="${1:?usage: $0 <run id>}"
SRC="$HERE/.run/$RUN"
[ -f "$SRC/report.json" ] || { echo "no report for $RUN" >&2; exit 2; }
for f in report.json report.md; do
  ext="${f##*.}"
  sed "s#$ROOT/##g" "$SRC/$f" > "$HERE/runs/$RUN.$ext"
done
if [ -d "$SRC/certs" ]; then
  mkdir -p "$HERE/evidence/$RUN"
  cp -r "$SRC/certs/." "$HERE/evidence/$RUN/"
fi
if ! python3 -I - "$HERE/runs/$RUN.json" "$HERE/runs/$RUN.md" "$HERE/evidence/$RUN" <<'PY'
import pathlib, re, sys
# Handle labels must be the harness's numbered words, never a name, and no
# absolute local path may remain.
allowed = {"one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
           "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
           "eighteen", "nineteen", "twenty"}
bad = []
for arg in sys.argv[1:]:
    root = pathlib.Path(arg)
    files = [root] if root.is_file() else [f for f in root.rglob("*") if f.is_file()] if root.exists() else []
    for f in files:
        text = f.name + "\n" + f.read_bytes().decode("latin-1")
        for label in set(re.findall(r"\b([a-z][a-z0-9-]*)@test\d+", text)):
            if label not in allowed:
                bad.append(f"{f}: handle label {label!r}")
        if re.search(r"/home/|/media/|/Users/", text):
            bad.append(f"{f}: absolute local path")
for b in bad:
    print(b, file=sys.stderr)
sys.exit(1 if bad else 0)
PY
then
  echo "refusing: the kept copies contain a local path or a label that isn't a numbered word" >&2
  rm -f "$HERE/runs/$RUN".json "$HERE/runs/$RUN".md
  rm -rf "$HERE/evidence/$RUN"
  exit 1
fi
echo "kept regtest/runs/$RUN.json, .md and regtest/evidence/$RUN/"
