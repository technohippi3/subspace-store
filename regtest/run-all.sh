#!/usr/bin/env bash
# Run every regtest scenario in order on one fresh local regtest network inside
# an isolated network namespace: the first purchase, a second commitment that
# needs a proof, a host loss and restore, and a lost broadcast response. CPU
# proving makes it slow. Writes regtest/.run/<run id>/report.md, labelled
# "regtest". Exit status as in run-first-purchase.sh.
# Usage: regtest/run-all.sh [prefix]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
regtest/fetch.sh
(cd regtest/verifier && cargo build --locked --release)
RUN="$(regtest/run-id.sh "${1:-all}")"
echo "run id: $RUN"
exec regtest/in-netns.sh python3 -m regtest.harness.scenarios "$RUN" all
