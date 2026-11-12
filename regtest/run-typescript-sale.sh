#!/usr/bin/env bash
# Fresh fixture wallets only, with real Core, Spaces, subs, libveritas and
# a local relay. Dependencies must already be fetched/built. No downloads
# or public relay traffic occur inside the loopback-only namespace.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export SUBSPACE_SUBS_BIN="$ROOT/regtest/.cache/bin/subs-relay" SUBSPACE_RELAY=1
export SUBSPACE_TYPESCRIPT_STACK_ISOLATED=1
RUN="$(regtest/run-id.sh "${1:-typescript-sale}")"
printf 'run id: %s\n' "$RUN"
exec regtest/in-netns.sh python3 -m regtest.harness.typescript_sale "$RUN"
