import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from common import Refused, public_directory
from release import build, extract, verify, SCHEMAS, INSTALLED_MANIFEST


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "application.txt").write_text("fixture application")
        self.private, self.public = self.keys("trusted")

    def tearDown(self):
        self.temporary.cleanup()

    def keys(self, name):
        private, public = self.root / (name + ".key"), self.root / (name + ".pub")
        subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(private)], check=True, capture_output=True)
        private.chmod(0o600)
        subprocess.run(["openssl", "pkey", "-in", str(private), "-pubout", "-out", str(public)], check=True, capture_output=True)
        public.chmod(0o644)
        return private, public

    def make(self, output="release"):
        directory = self.root / output
        manifest = build(self.source, directory, "fixture-v1", "1" * 40, self.private, [])
        return directory, manifest

    def validate(self, directory, public=None):
        return verify(directory / "fixture-v1.manifest.json", directory / "fixture-v1.manifest.sig",
                      directory / "fixture-v1.tar.gz", public or self.public)

    def test_signed_archive_extracts_only_verified_exact_bytes(self):
        directory, manifest = self.make()
        verified = self.validate(directory)
        destination = self.root / "installed"
        extract(directory / "fixture-v1.tar.gz", destination, verified)
        self.assertEqual((destination / "application.txt").read_text(), "fixture application")
        self.assertEqual(manifest["schemas"], SCHEMAS)

    def test_cached_stage_rejects_unsigned_codec_before_any_payload_execution(self):
        import installer
        directory, _ = self.make()
        manifest = self.validate(directory)
        value = {"releaseDirectory": str(self.root / "releases")}
        artifact = directory / "fixture-v1.tar.gz"
        target = installer.stage(value, manifest, artifact)
        self.assertEqual(installer.stage(value, manifest, artifact), target)
        codec = target / "app/controller/journal_protocol.py"
        codec.parent.mkdir(parents=True)
        marker = self.root / "unsigned-code-executed"
        codec.write_text("from pathlib import Path\nPath(" + repr(str(marker)) + ").touch()\n")
        with self.assertRaises(Refused):
            installer.stage(value, manifest, artifact)
        self.assertFalse(marker.exists())

    def test_status_rejects_unsigned_content_before_calling_payload_readiness(self):
        import installer
        directory, _ = self.make(); manifest = self.validate(directory)
        value = {'releaseDirectory': str(self.root / 'releases'), 'baseDirectory': str(self.root / 'state'),
                 'currentPath': str(self.root / 'current')}
        target = installer.stage(value, manifest, directory / 'fixture-v1.tar.gz')
        Path(value['currentPath']).symlink_to(target)
        (target / 'unsigned.py').write_text('raise RuntimeError()')
        receipt = {'release':manifest['release'],'manifestDigest':manifest['_digest'],'schemas':manifest['schemas']}
        with patch.object(installer,'current_receipt',return_value=receipt), patch.object(installer,'lifecycle') as execute, \
                patch.object(installer,'maintenance') as maintenance:
            result = installer.status(value)
        self.assertFalse(result['ready']);self.assertTrue(result['paused'])
        execute.assert_not_called();maintenance.assert_not_called()

    def test_cached_stage_rejects_import_caches_missing_bytes_links_and_unsafe_permissions(self):
        import installer
        nested = self.source / 'app'
        nested.mkdir(); (nested / 'module.py').write_text('value = 1\n')
        directory, _ = self.make()
        manifest = self.validate(directory)
        artifact = directory / 'fixture-v1.tar.gz'
        for fault in ('extra-file', 'bytecode', 'extra-directory', 'missing', 'changed', 'executable',
                      'writable-file', 'writable-directory', 'symlink-file', 'symlink-directory', 'hardlink', 'fifo'):
            with self.subTest(fault=fault):
                value = {'releaseDirectory': str(self.root / fault)}
                target = installer.stage(value, manifest, artifact)
                file = target / 'application.txt'
                if fault == 'extra-file': (target / 'unsigned.py').write_text('raise RuntimeError()')
                elif fault == 'bytecode':
                    cache = target / 'app/__pycache__'; cache.mkdir(); (cache / 'module.cpython-312.pyc').write_bytes(b'unsigned')
                elif fault == 'extra-directory': (target / 'unsigned').mkdir()
                elif fault == 'missing': file.unlink()
                elif fault == 'changed': file.write_text('changed application')
                elif fault == 'executable': file.chmod(0o755)
                elif fault == 'writable-file': file.chmod(0o666)
                elif fault == 'writable-directory': (target / 'app').chmod(0o777)
                elif fault == 'symlink-directory':
                    outside = self.root / 'outside-app'; (target / 'app').rename(outside); (target / 'app').symlink_to(outside)
                else:
                    outside = self.root / ('outside-' + fault); file.rename(outside)
                    if fault == 'symlink-file': file.symlink_to(outside)
                    elif fault == 'hardlink': os.link(outside, file)
                    elif fault == 'fifo': os.mkfifo(file)
                with self.assertRaises((Refused, OSError)):
                    installer.stage(value, manifest, artifact)

    def test_release_cache_rejects_writable_or_symlinked_ancestors(self):
        import installer
        directory, _ = self.make()
        manifest = self.validate(directory); artifact = directory / 'fixture-v1.tar.gz'
        real = self.root / 'real'; real.mkdir()
        link = self.root / 'link'; link.symlink_to(real)
        for parent in (link / 'releases', real / 'releases'):
            if parent.parent == real: real.chmod(0o777)
            with self.assertRaises(Refused):
                installer.stage({'releaseDirectory': str(parent)}, manifest, artifact)
            self.assertFalse((real / 'releases').exists())

    def test_installer_metadata_cannot_be_a_signed_payload_file(self):
        directory, manifest = self.make()
        manifest['files'][INSTALLED_MANIFEST] = dict(manifest['files']['application.txt'])
        self.resign(directory, manifest)
        with self.assertRaisesRegex(Refused, 'reserved-release-path'):
            self.validate(directory)
        (self.source / INSTALLED_MANIFEST).write_text('{}')
        with self.assertRaisesRegex(Refused, 'reserved-release-path'):
            self.make('reserved')

    def test_signed_legacy_journal_release_cannot_be_verified_as_a_current_release(self):
        directory, manifest = self.make()
        manifest['schemas']['controllerJournal'] = 2
        self.resign(directory, manifest)
        with self.assertRaisesRegex(Refused, 'unsupported-release-schema'):
            self.validate(directory)

    def resign(self, directory, manifest):
        file = directory / 'fixture-v1.manifest.json'
        file.write_text(json.dumps(manifest))
        subprocess.run(['openssl', 'pkeyutl', '-sign', '-rawin', '-inkey', str(self.private), '-in', str(file),
                        '-out', str(directory / 'fixture-v1.manifest.sig')], check=True, capture_output=True)

    def test_forward_journal_upgrade_is_explicit_and_old_installer_refuses_new_receipt(self):
        import installer
        directory, manifest = self.make()
        manifest['upgradeFrom'] = ['legacy-v1']
        self.resign(directory, manifest)
        old_schemas = dict(SCHEMAS, controllerJournal=2)
        receipt = dict(schemas=old_schemas, manifestDigest='0' * 64, release='legacy-v1', rollbackTo=['fixture-v1'])
        with patch.object(installer, 'capabilities'), patch.object(installer, 'current_receipt', return_value=receipt), \
                patch.object(installer, 'paths', return_value={'lock': self.root / 'ownership'}), patch.object(installer, 'stage') as stage:
            result = installer._apply({'trustKey': str(self.public)}, directory / 'fixture-v1.manifest.json',
                directory / 'fixture-v1.manifest.sig', directory / 'fixture-v1.tar.gz', dry_run=True)
            self.assertTrue(result['dryRun']); stage.assert_not_called()
        repository = Path(os.environ.get('SUBSPACE_PACKAGE_APPLICATION_SOURCE', Path(__file__).resolve().parents[2]))
        import sys
        sys.path.insert(0, str(repository))
        from tests.legacy_controller_source import export_revision
        manifest['schemas'] = old_schemas
        self.resign(directory, manifest)
        script = '''import sys,json,pathlib
sys.path.insert(0,sys.argv[1]);import installer
calls=[]
installer.capabilities=lambda value:None
installer.paths=lambda value:{'lock':pathlib.Path(sys.argv[2])/'ownership'}
receipt=dict(schemas=json.loads(sys.argv[3]),manifestDigest='0'*64,release='legacy-v1',rollbackTo=['fixture-v1'])
installer.current_receipt=lambda value:receipt
installer.stage=lambda *args:calls.append('stage')
value={'trustKey':sys.argv[7]}
args=sys.argv[4:7]
try:
 result=installer._apply(value,*args,dry_run=True,rollback=True)
 print(json.dumps(dict(accepted=True,calls=calls)))
except Exception as error:print(json.dumps(dict(accepted=False,error=str(error),calls=calls)))
'''
        for revision in ('c63e96b', '7d43c77'):
            old = self.root / revision
            export_revision(old, revision, 'deploy/native')
            for schemas, accepted in ((old_schemas, True), (SCHEMAS, False)):
                result = subprocess.run([sys.executable, '-c', script, str(old / 'deploy/native'), str(self.root), json.dumps(schemas),
                    str(directory / 'fixture-v1.manifest.json'), str(directory / 'fixture-v1.manifest.sig'),
                    str(directory / 'fixture-v1.tar.gz'), str(self.public)], capture_output=True, text=True, check=True)
                outcome = json.loads(result.stdout)
                self.assertEqual(outcome['accepted'], accepted, (revision, outcome))
                self.assertEqual(outcome['calls'], [])
                if not accepted: self.assertEqual(outcome['error'], 'incompatible-schema')

    def test_corrupt_archive_wrong_signature_and_unknown_signer_refuse(self):
        directory, manifest = self.make()
        artifact = directory / "fixture-v1.tar.gz"
        original = artifact.read_bytes()
        artifact.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
        with self.assertRaisesRegex(Refused, ""):
            self.validate(directory)
        artifact.write_bytes(original)
        _, other = self.keys("unknown")
        with self.assertRaises(Refused):
            self.validate(directory, other)
        file = directory / "fixture-v1.manifest.json"
        file.write_text(file.read_text().replace("fixture-v1", "fixture-v2"))
        with self.assertRaises(Refused):
            self.validate(directory)

    def test_restrictive_umask_preserves_public_release_traversal_and_private_ancestors(self):
        nested = self.source / "native" / "nested"
        nested.mkdir(parents=True)
        (nested / "public.py").write_text("fixture")
        directory, _ = self.make()
        verified = self.validate(directory)
        self.root.chmod(0o700)
        previous = os.umask(0o077)
        try:
            public_directory(self.root / "new" / "releases", parents=True)
            destination = self.root / "new" / "releases" / "installed"
            extract(directory / "fixture-v1.tar.gz", destination, verified)
        finally:
            os.umask(previous)
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        for path in [self.root / "new", destination.parent, destination,
                     destination / "native", destination / "native" / "nested"]:
            self.assertEqual(path.stat().st_mode & 0o777, 0o755)
        self.assertEqual((destination / "native/nested/public.py").stat().st_mode & 0o777, 0o644)
        private = self.root / "private"
        private.mkdir(mode=0o700)
        public_directory(private, exist_ok=True)
        self.assertEqual(private.stat().st_mode & 0o777, 0o700)
        link = self.root / "link"
        link.symlink_to(private)
        with self.assertRaises(Refused):
            public_directory(link, exist_ok=True)

    def test_extraction_rejects_manifest_path_escape_and_incomplete_archive(self):
        directory, _ = self.make()
        manifest = self.validate(directory)
        manifest["files"]["../escape"] = manifest["files"]["application.txt"]
        with self.assertRaises(Refused):
            extract(directory / "fixture-v1.tar.gz", self.root / "incomplete", manifest)
        self.assertFalse((self.root / "escape").exists())

    def test_builder_rejects_symlinks_signing_key_and_private_state_inputs(self):
        (self.source / "outside").symlink_to(self.private)
        with self.assertRaises(Refused):
            self.make()
        (self.source / "outside").unlink()
        (self.source / "wallet.db").write_bytes(b"fixture")
        with self.assertRaises(Refused):
            self.make("another")

    def test_identical_sources_create_identical_artifact_digests(self):
        _, first = self.make("first")
        _, second = self.make("second")
        self.assertEqual(first["artifact"], second["artifact"])


if __name__ == "__main__":
    unittest.main()
