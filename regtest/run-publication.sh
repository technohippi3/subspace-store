#!/usr/bin/env bash
# Publication and delivery through a local relay: the first purchase, then
# publication of its batch to a certrelay started inside the run's network
# namespace, delivery confirmed per handle by a verified lookup through that
# relay, and a later batch whose publication waits for finality and anchor
# coverage (scenario 6). subs runs with upstream/subs-fabric-seed.patch so
# that it seeds the local relay only, and nothing can reach the public relay
# network from the namespace. Writes regtest/.run/<run id>/report.md,
# labelled "regtest".
# Usage: regtest/run-publication.sh [prefix]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
regtest/fetch.sh
(cd regtest/verifier && cargo build --locked --release)
regtest/build-relay.sh
export SUBSPACE_SUBS_BIN="$ROOT/regtest/.cache/bin/subs-relay" SUBSPACE_RELAY=1
RUN="$(regtest/run-id.sh "${1:-publication}")"
echo "run id: $RUN"
exec regtest/in-netns.sh python3 -m regtest.harness.publication "$RUN" first_purchase publication
