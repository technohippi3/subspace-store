#!/usr/bin/env bash
# Start the local regtest stack (bitcoind, spaced, the fault proxies,
# subs-prover and subs) inside an isolated network namespace, and open a shell
# in that namespace to drive it. Leaving the shell stops the stack. Run
# fetch.sh first.
# Usage: regtest/start.sh [prefix]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RUN="$(regtest/run-id.sh "${1:-manual}")"
echo "run id: $RUN"
exec regtest/in-netns.sh sh -c 'python3 -m regtest.harness.procs start "$1" && echo "inside the regtest namespace; exit to stop" && ${SHELL:-sh}; python3 -m regtest.harness.procs stop "$1"' sh "$RUN"
