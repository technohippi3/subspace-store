"""Named spec coverage, separated by implementation and evidence type.

--check is the development gate. --release pilot additionally requires
production tests of the shipped TS store and Python controller/runner.
Discovery does not execute tests; CI must run the corresponding suites.
"""

import argparse
import ast
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SPEC_FILES = ('PAYMENT-SPEC.md', 'PRIVATE-PURCHASE.md', 'PILOT-SPEC.md', 'STORAGE-SPEC.md',
              'CHECKOUT-SPEC.md', 'CORE-SPEC.md', 'REFUND-PREPARATION.md', 'REFUND-SENDING.md',
              'REFUND-FAMILIES.md', 'REFUND-OBLIGATIONS.md', 'REFUND-ESTIMATES.md',
              'EXCESS-DEADLINES.md', 'OPERATOR-INSPECTION.md', 'REGISTRY-ENTRY.md', 'ENTRY-RECOVERY.md',
              'ENTRY-RELEASE.md', 'COMMITMENT-TRACKING.md', 'CERTIFICATES.md', 'FULFILLMENT.md', 'RUNTIME.md', 'ATTENDED-REFUNDS.md', 'SUPERSESSION.md', 'APPLICATION-RESTORE.md', 'RECONCILIATION.md')
KINDS = ('python-model', 'python-store', 'python-controller', 'ts-model', 'ts-store')
CONTROLLER_FILES = {'test_controller_host.py', 'test_controller_lock.py',
                    'test_runner.py', 'test_runner_recovery.py',
                    'test_interrupted_broadcast.py', 'test_entry_recovery.py', 'test_entry_release.py',
                    'test_commitment_tracking.py', 'test_bound_certificates.py', 'test_bound_delivery.py', 'test_attended_refunds.py', 'test_supersession.py', 'test_bound_recovery.py'}
SERVICE_PREFIXES = 'VHCASTY'
TS_LEXEMES = re.compile(r'//[^\n]*|/\*[\s\S]*?\*/|`(?:\\.|[^`\\])*`|'
                        r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'')
TS_CASE = re.compile(r'^\s*test(?P<method>\.(?:skip|todo|only))?\(\s*'
                     r'(?P<quote>["\'])(?P<id>[A-Z]\d+):[^\n]*?(?P=quote)\s*,', re.M)


def ordered(cases):
    return sorted(cases, key=lambda c: (c[0], int(c[1:])))


def spec_locations(root=ROOT):
    paths = [root / 'docs/spec' / name for name in SPEC_FILES]
    locations = {}
    for path in paths:
        if not path.exists():
            continue
        for number, line in enumerate(path.read_text().splitlines(), 1):
            match = re.match(r'^\| ([A-Z]\d+) \|', line)
            if match:
                locations.setdefault(match[1], []).append(f'{path.name}:{number}')
    return locations


def spec_cases(root=ROOT):
    return ordered(spec_locations(root))


def deferred(case):
    return case[0] in 'DE' or case == 'N6'


def pilot_target(case):
    if case[0] in 'ABLX' or (case[0] == 'J' and int(case[1:]) <= 10):
        return 'python-controller'
    return 'ts-store'


def supersessions(root):
    path = root / 'docs/spec/PILOT-SPEC.md'
    if not path.exists():
        return {}
    # The separate applicability table is not a case-status system.
    return dict(re.findall(r'^\| baseline ([A-Z]\d+) \| ([A-Z]\d+) \|',
                           path.read_text(), re.M))


def evidence(root=ROOT):
    found = {kind: set() for kind in KINDS}
    errors = []
    for path in sorted((root / 'tests').glob('test_*.py')):
        tree = ast.parse(path.read_text(), filename=str(path))
        parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            match = re.match(r'test_([A-Z]\d+)_', node.name)
            if not match:
                continue
            case = match[1]
            decorators = list(node.decorator_list)
            parent = parents.get(node)
            while parent is not None:
                if isinstance(parent, ast.ClassDef):
                    decorators.extend(parent.decorator_list)
                parent = parents.get(parent)
            if any('skip' in ast.unparse(d).lower() or 'expectedFailure' in ast.unparse(d)
                   for d in decorators):
                errors.append(f'{path.name}: {case} cannot use a skip/expected-failure decorator')
                continue
            kind = ('python-controller' if case.startswith('A') or path.name in CONTROLLER_FILES else
                    'python-store' if case[0] in SERVICE_PREFIXES else 'python-model')
            found[kind].add(case)
    for path in sorted((root / 'ts/test').rglob('*.test.ts')):
        # Remove comments and template bodies, preserving offsets/newlines and
        # quoted strings. Thus example test names in comments are not evidence.
        def mask(match):
            value = match[0]
            return re.sub(r'[^\n]', ' ', value) if value.startswith(('//', '/*', '`')) else value
        source = TS_LEXEMES.sub(mask, path.read_text())
        for match in TS_CASE.finditer(source):
            case = match['id']
            tail = source[match.end():]
            if match['method'] or not re.match(r'\s*(?:async\s*)?\([^)]*\)\s*=>', tail):
                errors.append(f'{path.relative_to(root)}: {case} requires an unconditional callback')
                continue
            relative = path.relative_to(root / 'ts/test')
            kind = {'model': 'ts-model', 'production': 'ts-store'}.get(relative.parts[0])
            if kind is None:
                errors.append(f'{relative}: named cases belong in model/ or production/')
                continue
            found[kind].add(case)
    return found, errors


def tested_cases(root=ROOT):
    found, _ = evidence(root)
    return set().union(*found.values())


def main(argv=None, root=ROOT):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--release', choices=['pilot'])
    args = parser.parse_args(argv)
    locations = spec_locations(root)
    spec = set(locations)
    found, errors = evidence(root)
    for case in ordered(locations):
        if len(locations[case]) > 1:
            errors.append(f'duplicate spec case {case}: ' + ', '.join(locations[case]))
    tested = set().union(*found.values())
    unknown = tested - spec
    if unknown:
        errors.append('tests naming unknown cases: ' + ' '.join(ordered(unknown)))
    pilot_spec = root / 'docs/spec/PILOT-SPEC.md'
    model_cases = set(re.findall(r'^\| ([A-Z]\d+) \|', pilot_spec.read_text(), re.M)) if pilot_spec.exists() else set()
    missing_model = model_cases - found['ts-model']
    if (args.check or args.release) and missing_model:
        errors.append('independent TS model tests missing for ' + ' '.join(ordered(missing_model)))
    replacements = supersessions(root)
    for old, new in replacements.items():
        if old not in spec or new not in spec or old == new or deferred(new) or new in replacements:
            errors.append(f'invalid pilot supersession: {old} -> {new}')
    mvp = {case for case in spec if not deferred(case)}
    missing = mvp - tested
    print(f'spec cases: {len(spec)}, with tests: {len(tested & spec)}, '
          f'without: {len(spec - tested)}')
    for kind in KINDS:
        print(f'{kind}: {len(found[kind] & spec)}')
    print(f'fixed-price MVP cases: {len(mvp)}, without tests: {len(missing)}')
    if missing:
        print('missing:', ' '.join(ordered(missing)))
    if args.check and missing:
        errors.append('check failed: every fixed-price MVP case needs a test')
    if args.release:
        required = mvp - {case for case in mvp if case.startswith('Y')} - replacements.keys()
        gaps = {case for case in required if case not in found[pilot_target(case)]}
        print(f'pilot production cases: {len(required)}, without production tests: {len(gaps)}')
        if gaps:
            errors.append('release blocked: production tests missing for ' + ' '.join(ordered(gaps)))
    for error in errors:
        print(error)
    return int(bool(errors))


if __name__ == '__main__':
    sys.exit(main())
