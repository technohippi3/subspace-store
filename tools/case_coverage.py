"""Report which named specification cases have tests.

Reads the case tables in docs/spec/PAYMENT-SPEC.md and the test names in
tests/, and prints implemented and missing case identifiers. Most cases are
tested against the reference model. The recipient-request cases (V) and
the service restore cases (H) are the service's own; their tests are
service API tests or, for H7, a model-twin test, and they are reported
separately, never as model results.

With --check it is also a gate: it exits non-zero when a fixed-price MVP
case has no test, or a test names a case the specification doesn't
have. Deferred auction cases are reported but never fail the check.
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def spec_cases():
    text = (ROOT / "docs/spec/PAYMENT-SPEC.md").read_text()
    return sorted(set(re.findall(r"^\| ([A-Z]\d+) \|", text, re.M)),
                  key=lambda c: (c[0], int(c[1:])))


def tested_cases():
    found = set()
    for path in (ROOT / "tests").glob("test_*.py"):
        found.update(re.findall(r"def test_([A-Z]\d+)_", path.read_text()))
    return found


DEFERRED_AFTER_MVP = lambda c: c[0] in "DE" or c == "N6"
SERVICE_CASES = lambda c: c[0] in "VH"


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    strict = "--check" in argv
    spec = spec_cases()
    tested = tested_cases()
    mvp = [c for c in spec if not DEFERRED_AFTER_MVP(c)]
    mvp_missing = [c for c in mvp if c not in tested]
    unknown = sorted(tested - set(spec))
    missing = [c for c in spec if c not in tested]
    done = [c for c in spec if c in tested]
    service = [c for c in spec if SERVICE_CASES(c)]
    print(f"spec cases: {len(spec)}, with tests: {len(done)}, without: {len(missing)}")
    print("with tests:", " ".join(done))
    print(f"of which service tests (API or model twin), not model results: "
          f"{len([c for c in service if c in tested])} of {len(service)}")
    print("without:", " ".join(missing))
    print(f"fixed-price MVP cases: {len(mvp)}, without tests: {len(mvp_missing)}"
          + (": " + " ".join(mvp_missing) if mvp_missing else ""))
    if unknown:
        print("tests naming unknown cases:", " ".join(unknown))
        return 1
    if strict and mvp_missing:
        print("check failed: every fixed-price MVP case needs a test")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
