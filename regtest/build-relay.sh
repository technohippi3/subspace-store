#!/usr/bin/env bash
# Build what isolated publication needs, into regtest/.cache/bin:
# - subs-relay: subs at the pinned commit with
#   upstream/subs-fabric-seed.patch, which adds `--fabric-seed <url>` so the
#   fabric client bootstraps from the named relays instead of the built-in
#   public seeds (finding R19). Built from a separate clone of the pinned
#   checkout, so the pinned subs and its binary stay as they are.
# - certrelay: the relay at the commit subs locks, built with certrelay's own
#   Cargo.lock at that commit.
# Network use is limited to cloning certrelay and the crates cargo resolves,
# as in fetch.sh. Run fetch.sh first.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=pins.env
. "$HERE/pins.env"
SRC="$HERE/.cache/src"
BIN="$HERE/.cache/bin"
PATCH="$HERE/upstream/subs-fabric-seed.patch"

WT="$SRC/subs-relay"
[ -d "$WT/.git" ] || git clone -q "$SRC/subs" "$WT"
git -C "$WT" checkout -q --detach "$SUBS_COMMIT"
[ "$(git -C "$WT" rev-parse HEAD)" = "$SUBS_COMMIT" ] || { echo "$WT is not at $SUBS_COMMIT" >&2; exit 1; }
if git -C "$WT" apply --reverse --check "$PATCH" 2>/dev/null; then
  echo "patch already applied in $WT"
else
  git -C "$WT" apply "$PATCH"
fi
(cd "$WT" && cargo build --locked --release -p subs --bin subs)
cp "$WT/target/release/subs" "$BIN/subs-relay"

grep -q "certrelay.git#$CERTRELAY_COMMIT" "$SRC/subs/Cargo.lock" || {
  echo "subs' Cargo.lock does not lock certrelay at $CERTRELAY_COMMIT" >&2; exit 1; }
CR="$SRC/certrelay"
[ -d "$CR/.git" ] || git clone -q "$CERTRELAY_REPO" "$CR"
git -C "$CR" cat-file -e "$CERTRELAY_COMMIT^{commit}" 2>/dev/null || git -C "$CR" fetch -q origin
git -C "$CR" checkout -q --detach "$CERTRELAY_COMMIT"
(cd "$CR" && cargo build --locked --release -p relay --bin certrelay)
cp "$CR/target/release/certrelay" "$BIN/certrelay"
ls -l "$BIN/subs-relay" "$BIN/certrelay"
