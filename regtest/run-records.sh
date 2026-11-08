#!/usr/bin/env bash
# Signed records through a local relay: the first purchase, then a handle
# sold to a script whose key the run holds, published and delivered through
# a certrelay inside the run's network namespace, and record sets for it
# signed, sent to the relay and read back, each answer verified with
# libveritas against root anchors read from spaced (scenario 9). subs runs
# with upstream/subs-fabric-seed.patch so that it seeds the local relay
# only. Writes regtest/.run/<run id>/report.md, labelled "regtest".
# Usage: regtest/run-records.sh [prefix]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
regtest/fetch.sh
(cd regtest/verifier && cargo build --locked --release)
regtest/build-relay.sh
export SUBSPACE_SUBS_BIN="$ROOT/regtest/.cache/bin/subs-relay" SUBSPACE_RELAY=1
RUN="$(regtest/run-id.sh "${1:-records}")"
echo "run id: $RUN"
exec regtest/in-netns.sh python3 -m regtest.harness.records "$RUN" first_purchase records
