#!/usr/bin/env bash
# Verify the kept certificate messages offline (regtest evidence).
# Exit 0 if every message verifies and matches its saved libveritas output:
# its zones and, where the run saved them, its verified records.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
verifier="$here/verifier/target/release/subspace-regtest-verifier"
[ -x "$verifier" ] || { echo "build the verifier first: (cd regtest/verifier && cargo build --release)" >&2; exit 2; }
pass=0; fail=0
while IFS= read -r msg; do
  dir="$(dirname "$msg")"; handle="$(basename "$msg" .message.bin)"
  if out="$("$verifier" "$msg" "$dir/anchors.json" 2>&1)" && python3 - "$out" "$dir/$handle.libveritas.json" <<'PY'
import json, sys
got = json.loads(sys.argv[1])
saved = json.load(open(sys.argv[2]))
# Older runs saved no "records"; where a run did, they must match too.
same_records = "records" not in saved or got.get("records") == saved["records"]
sys.exit(0 if got.get("verified") is True and got["zones"] == saved["zones"] and same_records else 1)
PY
  then pass=$((pass + 1)); echo "ok   ${msg#$here/evidence/}"
  else fail=$((fail + 1)); echo "FAIL ${msg#$here/evidence/}"; fi
done < <(find "$here/evidence" -name '*.message.bin' | sort)
echo "regtest evidence: $pass verified, $fail failed"
[ "$fail" -eq 0 ] && [ "$pass" -gt 0 ]
