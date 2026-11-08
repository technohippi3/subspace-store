"""Check the format of public recipient requests.

Usage: python3 tools/check_request.py <request.json> [...]

Each file holds one public request, such as a Nacho export. Its format is
checked as `POST /requests` checks a body before it reads any state
(PAYMENT-SPEC.md, "Recipient requests"): at most 65,536 bytes, a JSON object
with no repeated member and exactly the members `handle` and
`script_pubkey`, both strings, a canonical handle and a 34-byte P2TR script
with a valid key. It also reports whether the scripts are distinct.

It is a format checker only. It doesn't run the store's stateful checks,
which need the store: whether the name is for sale and free, whether the
script is one of the store's destination scripts, and whether a paid order
for another handle claims it.

It prints only the handle and a verdict for each file. A refused request is
never echoed, because a malformed export could carry a secret: the reason
names no member. Exit status 0 if every request passes, 1 otherwise.

Local and read-only: no network, no store, nothing written.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from service.app import MAX_BODY, REQUEST_FIELDS, BadRequest, _unique_members  # noqa: E402
from service.ledger import canonical_handle, valid_p2tr  # noqa: E402


def check(data):
    """`data` is the request's bytes. Returns (handle or None, None if it
    passes or the reason)."""
    if isinstance(data, str):
        data = data.encode()
    if len(data) > MAX_BODY:
        return None, f"over {MAX_BODY} bytes"
    try:
        body = json.loads(data, object_pairs_hook=_unique_members)
    except BadRequest:
        return None, "repeated member"
    except ValueError:
        return None, "not JSON"
    if not isinstance(body, dict):
        return None, "not a JSON object"
    if set(body) != REQUEST_FIELDS:
        return None, "members other than exactly handle and script_pubkey"
    if not all(isinstance(body[k], str) for k in REQUEST_FIELDS):
        return None, "handle and script_pubkey must be strings"
    if not canonical_handle(body["handle"]):
        return None, "handle is not canonical"
    if not valid_p2tr(body["script_pubkey"]):
        return body["handle"], "script_pubkey is not a 34-byte P2TR script with a valid key"
    return body["handle"], None


def main(paths):
    if not paths:
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        return 2
    ok, scripts = True, []
    for p in paths:
        data = Path(p).read_bytes()
        handle, reason = check(data)
        label = handle if handle and canonical_handle(handle) else "(handle withheld)"
        if reason:
            ok = False
            print(f"{Path(p).name}: {label}: refused: {reason}")
        else:
            scripts.append(json.loads(data)["script_pubkey"])
            print(f"{Path(p).name}: {label}: passes")
    if len(scripts) > 1:
        distinct = len(set(scripts)) == len(scripts)
        print("scripts: " + ("all distinct" if distinct else "REUSED across requests"))
        ok = ok and distinct
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
