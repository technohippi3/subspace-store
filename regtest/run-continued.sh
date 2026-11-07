#!/usr/bin/env bash
# Continued operation after recovery: the first purchase, the second
# commitment, the host restore and the lost broadcast answer, then another
# batch on the first space while subs holds no txid for its last commitment
# (scenario 5). With "pinned" it
# shows what the pinned subs does; with "u1b" it runs subs with the U1(b)
# patch, which lets the controller attach the adopted txid. Writes
# regtest/.run/<run id>/report.md, labelled "regtest".
# Usage: regtest/run-continued.sh [pinned|u1b]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VARIANT="${1:-pinned}"
regtest/fetch.sh
(cd regtest/verifier && cargo build --locked --release)
case "$VARIANT" in
  pinned) unset SUBSPACE_SUBS_BIN ;;
  u1b) regtest/build-u1b.sh; export SUBSPACE_SUBS_BIN="$ROOT/regtest/.cache/bin/subs-u1b" ;;
  *) echo "usage: $0 [pinned|u1b]" >&2; exit 3 ;;
esac
RUN="$(regtest/run-id.sh "continued-$VARIANT")"
echo "run id: $RUN"
exec regtest/in-netns.sh python3 -m regtest.harness.scenarios "$RUN" \
  first_purchase second_commitment restore lost_broadcast continued_operation
