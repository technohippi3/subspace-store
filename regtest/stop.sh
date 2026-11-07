#!/usr/bin/env bash
# Stop every process of a regtest run. Its data stays in regtest/.run/<run id>.
# Usage: regtest/stop.sh <run id>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec python3 -m regtest.harness.procs stop "$1"
