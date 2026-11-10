#!/usr/bin/env bash
# The operator gate's recovery rehearsal on regtest (scenario 11): a
# separate network node stands for the world; the host, with its bitcoind,
# spaced, subs, store service and runner, is lost whole with batches in
# flight on four spaces and a refund broadcast; a fresh host is brought up
# from the off-host recovery set alone (journals, the latest coordinated
# snapshot, and the operator and store wallets' onboarding backups), is
# reconciled through the runner, and issues again to fulfilled. subs is the
# subs-combined build, with U1(b) and --fabric-seed. Writes
# regtest/.run/<run id>/report.md, labelled "regtest".
# Usage: regtest/run-recovery.sh [prefix]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
regtest/fetch.sh
(cd regtest/verifier && cargo build --locked --release)
regtest/build-combined.sh
export SUBSPACE_SUBS_BIN="$ROOT/regtest/.cache/bin/subs-combined" SUBSPACE_RELAY=1
RUN="$(regtest/run-id.sh "${1:-recovery}")"
echo "run id: $RUN"
exec regtest/in-netns.sh python3 -m regtest.harness.recovery "$RUN" recovery_rehearsal
