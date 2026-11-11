#!/usr/bin/env bash
# Fetch only the pinned Core binaries; no Rust or upstream source builds.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=pins.env
. "$HERE/pins.env"
CACHE="$HERE/.cache"
BIN="$CACHE/bin"
mkdir -p "$BIN" "$CACHE/dl"

is_pinned() {
  local version
  version="$("$BIN/bitcoind" -version 2>/dev/null | head -1 | grep -oE 'v[0-9]+(\.[0-9]+)+')" || return 1
  [[ $version == "v$BITCOIN_VERSION" || $version == "v$BITCOIN_VERSION.0" ]]
}
if [[ -x $BIN/bitcoind && -x $BIN/bitcoin-cli ]] && is_pinned; then
  exit 0
fi
tarball="$CACHE/dl/$BITCOIN_TARBALL"
if [[ ! -f $tarball ]]; then
  partial=$(mktemp "$CACHE/dl/bitcoin-download.XXXXXX")
  trap 'rm -f -- "$partial"' EXIT
  curl -fsSL "$BITCOIN_URL" -o "$partial"
  echo "$BITCOIN_SHA256  $partial" | sha256sum -c -
  mv -- "$partial" "$tarball"
fi
echo "$BITCOIN_SHA256  $tarball" | sha256sum -c -
tar -xzf "$tarball" -C "$CACHE/dl"
cp "$CACHE/dl/bitcoin-$BITCOIN_VERSION/bin/bitcoind" "$CACHE/dl/bitcoin-$BITCOIN_VERSION/bin/bitcoin-cli" "$BIN/"
is_pinned || { echo 'installed Bitcoin Core does not match the pin' >&2; exit 1; }
