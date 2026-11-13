#!/usr/bin/env bash
# Fresh fixture wallets and a separate network node. Only the seller host
# is replaced; recovery uses its onboarding backups and off-host journals.
# Dependencies are prebuilt. No downloads occur in the test namespace.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export SUBSPACE_SUBS_BIN="$ROOT/regtest/.cache/bin/subs-combined" SUBSPACE_RELAY=1
export SUBSPACE_TYPESCRIPT_STACK_ISOLATED=1
RUN="$(regtest/run-id.sh "${1:-typescript-recovery}")"
printf 'run id: %s\n' "$RUN"
exec regtest/in-netns.sh python3 -m regtest.harness.typescript_sale "$RUN" whole-host
