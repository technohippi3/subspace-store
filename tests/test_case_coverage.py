"""The release gate must not mistake model/baseline names for TS production."""

import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from tools import case_coverage as coverage


class Coverage(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.write('docs/spec/PAYMENT-SPEC.md', '| P1 | scenario |\n| A1 | scenario |\n')
        self.write('tests/test_baseline.py', 'def test_P1_baseline(): pass\n')
        self.write('tests/test_runner.py', 'def test_A1_controller(): pass\n')

    def write(self, name, source):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(source)

    def run_gate(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            result = coverage.main(list(args), root=self.root)
        return result, out.getvalue()

    def test_models_and_python_baseline_cannot_satisfy_release(self):
        self.write('ts/test/model/pilot.test.ts', 'test("P1: model", () => {});')
        self.assertEqual(self.run_gate('--check')[0], 0)
        result, text = self.run_gate('--release', 'pilot')
        self.assertEqual(result, 1)
        self.assertIn('production tests missing for P1', text)
        self.write('ts/test/production/store.test.ts', 'test("P1: runtime", async () => {});')
        self.assertEqual(self.run_gate('--release', 'pilot')[0], 0)

    def test_duplicate_spec_definitions_fail_despite_a_passing_named_test(self):
        self.write('docs/spec/ENTRY-RECOVERY.md', '| A1 | unrelated new rule |\n')
        for arguments in ((), ('--check',), ('--release', 'pilot')):
            result, text = self.run_gate(*arguments)
            self.assertEqual(result, 1)
            self.assertIn('duplicate spec case A1', text)
            self.assertIn('PAYMENT-SPEC.md:2', text)
            self.assertIn('ENTRY-RECOVERY.md:1', text)

    def test_unknown_typescript_ids_and_arguments_fail(self):
        self.write('ts/test/model/pilot.test.ts', 'test("K99: unknown", () => {});')
        result, text = self.run_gate('--check')
        self.assertEqual(result, 1)
        self.assertIn('unknown cases: K99', text)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.run_gate('--relese', 'pilot')

    def test_comments_skips_and_unclassified_tests_are_not_evidence(self):
        self.write('ts/test/model/pilot.test.ts', '''
/* test("K99: example", () => {}); */
// test("K98: example", () => {});
const example = `
test("K97: example", () => {});
`;
''')
        self.assertEqual(self.run_gate('--check')[0], 0)
        for source in ['test.skip("P1: skipped", () => {});',
                       'test("P1: skipped", { skip: true }, () => {});',
                       'test.only("P1: focused", () => {});']:
            self.write('ts/test/model/pilot.test.ts', source)
            self.assertEqual(self.run_gate('--check')[0], 1)
        self.write('ts/test/model/pilot.test.ts', '')
        self.write('ts/test/loose.test.ts', 'test("P1: wrong directory", () => {});')
        self.assertEqual(self.run_gate('--check')[0], 1)

    def test_supersession_requires_real_known_replacement_production_case(self):
        self.write('docs/spec/PILOT-SPEC.md', '| K1 | new rule |\n| baseline P1 | K1 |\n')
        self.write('ts/test/model/pilot.test.ts', 'test("K1: model", () => {});')
        self.assertEqual(self.run_gate('--check')[0], 0)
        self.assertEqual(self.run_gate('--release', 'pilot')[0], 1)
        self.write('ts/test/production/store.test.ts', 'test("K1: runtime", () => {});')
        self.assertEqual(self.run_gate('--release', 'pilot')[0], 0)
        self.write('docs/spec/PILOT-SPEC.md', '| K1 | new rule |\n| baseline P1 | K99 |\n')
        self.assertEqual(self.run_gate('--release', 'pilot')[0], 1)

    def test_python_comments_and_skipped_classes_do_not_supply_coverage(self):
        self.write('tests/test_baseline.py', '# def test_P1_example(): pass\n')
        self.assertEqual(self.run_gate('--check')[0], 1)
        self.write('tests/test_baseline.py',
                   '@unittest.skip("unbuilt")\nclass Cases:\n    def test_P1_skipped(self): pass\n')
        self.assertEqual(self.run_gate('--check')[0], 1)

    def test_pilot_cases_require_independent_ts_model_evidence(self):
        self.write('docs/spec/PILOT-SPEC.md', '| K1 | pilot rule |\n')
        self.write('tests/test_pilot.py', 'def test_K1_python(): pass\n')
        self.write('ts/test/production/store.test.ts', 'test("K1: production", () => {});')
        result, text = self.run_gate('--check')
        self.assertEqual(result, 1)
        self.assertIn('independent TS model tests missing for K1', text)
        self.write('ts/test/model/pilot.test.ts', 'test("K1: model", () => {});')
        self.assertEqual(self.run_gate('--check')[0], 0)
