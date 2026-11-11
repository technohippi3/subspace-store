#!/usr/bin/env bash
# Fetch and build the pinned upstream software for the regtest harness.
#
# Network use is limited to this script: the git clones, the Bitcoin Core
# tarball and the crates that cargo resolves from the pinned Cargo.lock files.
# Everything lands in regtest/.cache, which is not committed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=pins.env
. "$HERE/pins.env"
CACHE="$HERE/.cache"
SRC="$CACHE/src"
BIN="$CACHE/bin"
mkdir -p "$SRC" "$BIN" "$CACHE/dl"

checkout() { # repo dir rev
  local repo="$1" dir="$2" rev="$3"
  if [ ! -d "$dir/.git" ]; then
    git clone -q "$repo" "$dir"
  fi
  git -C "$dir" fetch -q --tags origin
  git -C "$dir" checkout -q --detach "$rev"
  local got
  got="$(git -C "$dir" rev-parse HEAD)"
  echo "checked out $dir at $got"
}

# The same checksum-qualified fetch is used by the standalone TS Core tests.
"$HERE/fetch-bitcoin.sh"

# spaced and space-cli at the pinned tag.
checkout "$SPACES_REPO" "$SRC/spaces" "$SPACES_COMMIT"
if [ "$(git -C "$SRC/spaces" rev-parse "$SPACES_TAG^{commit}")" != "$SPACES_COMMIT" ]; then
  echo "tag $SPACES_TAG does not point at $SPACES_COMMIT" >&2
  exit 1
fi
if [ ! -x "$BIN/spaced" ]; then
  (cd "$SRC/spaces" && cargo build --locked --release -p spaces_client --bin spaced --bin space-cli)
  cp "$SRC/spaces/target/release/spaced" "$SRC/spaces/target/release/space-cli" "$BIN/"
fi

# subs and subs-prover at the pinned commit, without the test-rig feature, so
# that subs drives the separately started spaced above.
checkout "$SUBS_REPO" "$SRC/subs" "$SUBS_COMMIT"
if [ ! -x "$BIN/subs" ] || [ ! -x "$BIN/subs-prover" ]; then
  (cd "$SRC/subs" && cargo build --locked --release -p subs --bin subs -p subs-prover --bin subs-prover)
  cp "$SRC/subs/target/release/subs" "$SRC/subs/target/release/subs-prover" "$BIN/"
fi

# The preset regtest chain and test wallets that ship with spaces' test
# utilities. They are upstream test fixtures, unpacked into the cache and
# never copied into this repository.
if [ ! -d "$CACHE/preset/bitcoin_core_regtest_data" ]; then
  mkdir -p "$CACHE/preset"
  python3 -I -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' \
    "$SRC/spaces/testutil/testdata/regtest.zip" "$CACHE/preset"
fi

ls -l "$BIN"
