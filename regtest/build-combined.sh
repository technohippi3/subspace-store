#!/usr/bin/env bash
# Build subs with both upstream patches, U1(b) (subs-u1b-attach-commit-txid.patch)
# and --fabric-seed (subs-fabric-seed.patch), as regtest/.cache/bin/subs-combined,
# from a separate git worktree of the pinned checkout. The patches touch
# disjoint files. Also builds certrelay through build-relay.sh's certrelay
# part. Run fetch.sh first.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=pins.env
. "$HERE/pins.env"
SRC="$HERE/.cache/src"
BIN="$HERE/.cache/bin"
WT="$SRC/subs-combined"
PATCHES=("$HERE/upstream/subs-u1b-attach-commit-txid.patch" "$HERE/upstream/subs-fabric-seed.patch")

overlap="$(for p in "${PATCHES[@]}"; do grep '^+++ b/' "$p" | sort -u; done | sort | uniq -d)"
[ -z "$overlap" ] || { echo "the patches overlap in: $overlap" >&2; exit 1; }

if [ ! -d "$WT" ]; then
  git -C "$SRC/subs" worktree add -q --detach "$WT" "$SUBS_COMMIT"
  # Reuse the U1(b) build's compiled dependencies when they exist.
  [ -d "$SRC/subs-u1b/target" ] && cp -a "$SRC/subs-u1b/target" "$WT/target"
fi
[ "$(git -C "$WT" rev-parse HEAD)" = "$SUBS_COMMIT" ] || { echo "$WT is not at $SUBS_COMMIT" >&2; exit 1; }
for p in "${PATCHES[@]}"; do
  if git -C "$WT" apply --reverse --check "$p" 2>/dev/null; then
    echo "already applied: $(basename "$p")"
  else
    git -C "$WT" apply "$p"
  fi
done
(cd "$WT" && cargo build --locked --release -p subs --bin subs)
cp "$WT/target/release/subs" "$BIN/subs-combined"

CR="$SRC/certrelay"
[ -d "$CR/.git" ] || git clone -q "$CERTRELAY_REPO" "$CR"
git -C "$CR" cat-file -e "$CERTRELAY_COMMIT^{commit}" 2>/dev/null || git -C "$CR" fetch -q origin
git -C "$CR" checkout -q --detach "$CERTRELAY_COMMIT"
(cd "$CR" && cargo build --locked --release -p relay --bin certrelay)
cp "$CR/target/release/certrelay" "$BIN/certrelay"
ls -l "$BIN/subs-combined" "$BIN/certrelay"
