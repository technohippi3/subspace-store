#!/usr/bin/env bash
# Build the private-test subs: U1(b), explicit relay seeds, and IPv4 loopback
# binding. Uses a separate pinned worktree and binary; existing builds stay
# unchanged. Run fetch.sh first, and build-relay.sh for the regtest relay.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=pins.env
. "$HERE/pins.env"
SRC="$HERE/.cache/src"
BIN="$HERE/.cache/bin"
WT="$SRC/subs-private"
PATCHES=(
  "$HERE/upstream/subs-u1b-attach-commit-txid.patch"
  "$HERE/upstream/subs-fabric-seed.patch"
  "$HERE/upstream/subs-loopback.patch"
)

[ -d "$SRC/subs" ] || { echo "run regtest/fetch.sh first" >&2; exit 1; }
exec 9>"$HERE/.cache/subs-private-build.lock"
flock -n 9 || { echo "private subs build already running" >&2; exit 1; }
if [ ! -d "$WT" ]; then
  git -C "$SRC/subs" worktree add -q --detach "$WT" "$SUBS_COMMIT"
  if [ -d "$SRC/subs-combined/target" ]; then
    cp -a --reflink=auto "$SRC/subs-combined/target" "$WT/target"
  fi
fi
[ "$(git -C "$WT" rev-parse HEAD)" = "$SUBS_COMMIT" ] || {
  echo "private subs source does not match the pin" >&2; exit 1; }
# The relay and loopback patches edit different hunks of main.rs.
for p in "${PATCHES[@]}"; do
  if git -C "$WT" apply --reverse --check "$p" 2>/dev/null; then
    echo "already applied: $(basename "$p")"
  else
    git -C "$WT" apply --check "$p"
    git -C "$WT" apply "$p"
  fi
done
(cd "$WT" && cargo build --locked --offline --release -p subs --bin subs)
mkdir -p "$BIN"
cp "$WT/target/release/subs" "$BIN/subs-private"
echo "built regtest/.cache/bin/subs-private (IPv4 loopback only)"
