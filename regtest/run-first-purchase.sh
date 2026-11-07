#!/usr/bin/env bash
# Run the first purchase end to end on a fresh local regtest network inside an
# isolated network namespace, then stop everything. Writes
# regtest/.run/<run id>/report.md and report.json, labelled "regtest".
# Exits 0 when every required step agrees with the model, 1 when one
# disagrees, 2 on an error, 3 when it refuses to run.
# Usage: regtest/run-first-purchase.sh [prefix]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
regtest/fetch.sh
(cd regtest/verifier && cargo build --locked --release)
RUN="$(regtest/run-id.sh "${1:-first-purchase}")"
echo "run id: $RUN"
exec regtest/in-netns.sh python3 -m regtest.harness.scenarios "$RUN" first_purchase
