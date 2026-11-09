#!/usr/bin/env bash
# The checkout pages and the attended runner on regtest (scenario 10): a
# purchase through the pages, carried through issuance by the runner to a
# verified certificate on the order page and delivery through a local
# relay, then a cancellation and refund through the same pages and runner.
# The store service runs as its own process; every operator step after
# listing a name is a runner command. subs runs with
# upstream/subs-fabric-seed.patch so that it seeds the local relay only.
# Writes regtest/.run/<run id>/report.md, labelled "regtest".
# Usage: regtest/run-checkout.sh [prefix]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
regtest/fetch.sh
(cd regtest/verifier && cargo build --locked --release)
regtest/build-relay.sh
export SUBSPACE_SUBS_BIN="$ROOT/regtest/.cache/bin/subs-relay" SUBSPACE_RELAY=1
RUN="$(regtest/run-id.sh "${1:-checkout}")"
echo "run id: $RUN"
exec regtest/in-netns.sh python3 -m regtest.harness.checkout "$RUN" checkout_purchase checkout_refund
