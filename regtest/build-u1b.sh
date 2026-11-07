#!/usr/bin/env bash
# Build subs with the U1(b) patch (regtest/upstream/subs-u1b-attach-commit-txid.patch)
# as regtest/.cache/bin/subs-u1b, from a separate git worktree of the pinned
# subs checkout, so the pinned subs and its binary stay as they are. It adds
# POST /spaces/:space/commit/txid, which attaches a txid to the last local
# commitment after checking it against the chain. Run fetch.sh first.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=pins.env
. "$HERE/pins.env"
SRC="$HERE/.cache/src"
WT="$SRC/subs-u1b"
PATCH="$HERE/upstream/subs-u1b-attach-commit-txid.patch"
if [ ! -d "$WT" ]; then
  git -C "$SRC/subs" worktree add -q --detach "$WT" "$SUBS_COMMIT"
fi
[ "$(git -C "$WT" rev-parse HEAD)" = "$SUBS_COMMIT" ] || { echo "$WT is not at $SUBS_COMMIT" >&2; exit 1; }
if git -C "$WT" apply --reverse --check "$PATCH" 2>/dev/null; then
  echo "patch already applied in $WT"
else
  git -C "$WT" apply "$PATCH"
fi
(cd "$WT" && cargo build --locked --release -p subs --bin subs)
cp "$WT/target/release/subs" "$HERE/.cache/bin/subs-u1b"
echo "built $HERE/.cache/bin/subs-u1b"
