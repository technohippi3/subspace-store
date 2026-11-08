#!/usr/bin/env bash
# The store service (service/) on regtest, as its own process, restarted with
# SIGKILL along the way: a purchase through its API to verified delivery
# (scenario 7), and a cancellation refund with a real refund transaction
# (scenario 8). subs runs with upstream/subs-fabric-seed.patch so that it
# seeds the local relay only. Writes regtest/.run/<run id>/report.md,
# labelled "regtest".
# Usage: regtest/run-service.sh [prefix]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
regtest/fetch.sh
(cd regtest/verifier && cargo build --locked --release)
regtest/build-relay.sh
export SUBSPACE_SUBS_BIN="$ROOT/regtest/.cache/bin/subs-relay" SUBSPACE_RELAY=1
RUN="$(regtest/run-id.sh "${1:-service}")"
echo "run id: $RUN"
exec regtest/in-netns.sh python3 -m regtest.harness.service "$RUN" service_purchase service_refund
