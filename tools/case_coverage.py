"""Report which named specification cases have model tests.

Reads the case tables in docs/spec/PAYMENT-SPEC.md and the test names in
tests/, and prints implemented and missing case identifiers. It is a
report, not a gate.
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


def main():
    spec = spec_cases()
    tested = tested_cases()
    unknown = sorted(tested - set(spec))
    missing = [c for c in spec if c not in tested]
    done = [c for c in spec if c in tested]
    print(f"spec cases: {len(spec)}, with model tests: {len(done)}, without: {len(missing)}")
    print("with model tests:", " ".join(done))
    print("without:", " ".join(missing))
    if unknown:
        print("tests naming unknown cases:", " ".join(unknown))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
