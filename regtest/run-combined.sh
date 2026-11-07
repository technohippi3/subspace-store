#!/usr/bin/env bash
# Recovery, continued issuance and delivery in one run, with subs patched for
# both U1(b) and --fabric-seed: the first purchase, the second commitment,
# the host restore, the lost broadcast answer, then another batch after the
# recovery (scenario 5), then publication to a local relay and delivery
# confirmed per handle by a verified lookup (scenario 6). Writes
# regtest/.run/<run id>/report.md, labelled "regtest".
# Usage: regtest/run-combined.sh [prefix]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
regtest/fetch.sh
(cd regtest/verifier && cargo build --locked --release)
regtest/build-combined.sh
export SUBSPACE_SUBS_BIN="$ROOT/regtest/.cache/bin/subs-combined" SUBSPACE_RELAY=1
RUN="$(regtest/run-id.sh "${1:-combined}")"
echo "run id: $RUN"
exec regtest/in-netns.sh python3 -m regtest.harness.publication "$RUN" \
  first_purchase second_commitment restore lost_broadcast continued_operation publication
