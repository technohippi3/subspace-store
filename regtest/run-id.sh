#!/usr/bin/env bash
# Print a fresh run id: <prefix>-<UTC time>-<random>. Run ids are never reused,
# and run directories are never deleted by the harness.
set -euo pipefail
printf '%s-%s-%s\n' "${1:-run}" "$(date -u +%Y%m%dT%H%M%SZ)" "$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
