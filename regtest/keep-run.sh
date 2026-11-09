#!/usr/bin/env bash
# Keep a finished run in the repository: its report as runs/<run id>.json and
# .md, with the repository's absolute path made relative, and its certificate
# verifications as evidence/<run id>/, the attended runner's under
# evidence/<run id>/runner/.
#
# It never overwrites or removes anything already kept. A run id that is
# already kept is refused. The copies are built and checked in a temporary
# directory first, and published only when they pass: no absolute local path,
# and every handle label one of the harness's numbered words. A run id must
# be a plain name, with no path separators and no "..".
# Usage: regtest/keep-run.sh <run id>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
RUN="${1:?usage: $0 <run id>}"

if ! [[ "$RUN" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || [[ "$RUN" == *..* ]]; then
  echo "refusing: '$RUN' is not a plain run id" >&2
  exit 3
fi
SRC="$HERE/.run/$RUN"
[ -f "$SRC/report.json" ] || { echo "no report for $RUN" >&2; exit 2; }
for dest in "$HERE/runs/$RUN.json" "$HERE/runs/$RUN.md" "$HERE/evidence/$RUN"; do
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    echo "refusing: $RUN is already kept ($dest exists); kept evidence is never replaced" >&2
    exit 3
  fi
done

STAGE="$(mktemp -d "$HERE/.keep-run.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/runs" "$STAGE/evidence"
for f in report.json report.md; do
  [ -f "$SRC/$f" ] || continue
  sed "s#$ROOT/##g" "$SRC/$f" > "$STAGE/runs/$RUN.${f##*.}"
done
if [ -d "$SRC/certs" ]; then
  mkdir "$STAGE/evidence/$RUN"
  cp -r "$SRC/certs/." "$STAGE/evidence/$RUN/"
fi
# The attended runner (scenario 10) keeps its own controller's
# verifications under runner/certs; they are kept under runner/.
if [ -d "$SRC/runner/certs" ]; then
  mkdir -p "$STAGE/evidence/$RUN/runner"
  cp -r "$SRC/runner/certs/." "$STAGE/evidence/$RUN/runner/"
fi

if ! python3 -I - "$STAGE" <<'PY'
import pathlib, re, sys
# Handle labels must be the harness's numbered words, and no absolute local
# path may remain.
allowed = {"one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
           "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
           "eighteen", "nineteen", "twenty"}
bad = []
for f in sorted(p for p in pathlib.Path(sys.argv[1]).rglob("*") if p.is_file() or p.is_symlink()):
    if f.is_symlink():
        bad.append(f"{f.name}: a symbolic link")
        continue
    text = f.name + "\n" + f.read_bytes().decode("latin-1")
    for label in sorted(set(re.findall(r"\b([a-z][a-z0-9-]*)@test\d+", text))):
        if label not in allowed:
            bad.append(f"{f.name}: handle label {label!r}")
    if re.search(r"/home/|/media/|/Users/|/root/", text):
        bad.append(f"{f.name}: absolute local path")
for b in bad:
    print(b, file=sys.stderr)
sys.exit(1 if bad else 0)
PY
then
  echo "refusing: the copies of $RUN didn't pass; nothing was kept" >&2
  exit 1
fi

# Publish, without replacing anything: the destinations were checked above.
mkdir -p "$HERE/runs" "$HERE/evidence"
for f in "$STAGE/runs/"*; do
  [ -e "$f" ] && mv -n "$f" "$HERE/runs/"
done
if [ -d "$STAGE/evidence/$RUN" ]; then
  mv -n "$STAGE/evidence/$RUN" "$HERE/evidence/"
fi
echo "kept regtest/runs/$RUN.json, .md and regtest/evidence/$RUN/"
