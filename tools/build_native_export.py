"""Build owned, pinned native exporter inputs. No secrets or runtime RPCs."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import subprocess
import tomllib

parser = argparse.ArgumentParser()
parser.add_argument('--fetch', action='store_true', help='fetch only the exact locked crates before the offline build')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
def owned(path):
    if not path.parent.resolve().is_relative_to(root) or not path.resolve(strict=False).is_relative_to(root):
        raise SystemExit('native build output must remain inside its owned source tree')
    return path
crate = root / 'native/export'
target = owned(crate / 'target')
lock = tomllib.loads((crate / 'Cargo.lock').read_text())
for name, version in [('libveritas', '0.4.4'), ('spaces_nums', '0.4.2'), ('qrcode', '0.14.1')]:
    rows = [p for p in lock['package'] if p['name'] == name]
    if len(rows) != 1 or rows[0]['version'] != version or len(rows[0].get('checksum', '')) != 64:
        raise SystemExit('native dependency pin differs')
env = dict(os.environ, CARGO_TARGET_DIR=str(target))
cargo_home = Path(os.environ.get('CARGO_HOME', str(Path.home()/'.cargo'))).resolve()
env.pop('RUSTFLAGS', None)
env['CARGO_ENCODED_RUSTFLAGS'] = '\x1f'.join(['--remap-path-prefix='+str(root)+'=/build/source', '--remap-path-prefix='+str(cargo_home)+'=/build/cargo'])
if args.fetch:
    subprocess.run(['cargo', '+1.94.1', 'fetch', '--locked'], cwd=crate, env=env, check=True)
subprocess.run(['cargo', '+1.94.1', 'build', '--release', '--locked', '--offline'], cwd=crate, env=env, check=True)
binary = target / 'release/subspace-certificate-tools'
for private_path in [Path.home().resolve(), root, cargo_home]:
    if len(str(private_path)) > 1 and str(private_path).encode() in binary.read_bytes():
        raise SystemExit('unmapped local build path remains in executable')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
rustc = subprocess.check_output(['rustc', '+1.94.1', '-Vv'], text=True)
manifest = dict(version=1, tool='subspace-certificate-tools', library='libveritas-0.4.4', spacesNums='0.4.2',
    target=next(line.split(': ', 1)[1] for line in rustc.splitlines() if line.startswith('host: ')),
    rustc=rustc.splitlines()[0], cargoTomlSha256=sha(crate/'Cargo.toml'), lockSha256=sha(crate/'Cargo.lock'),
    sourceSha256=sha(crate/'src/main.rs'), binarySha256=sha(binary), remappedBuildPaths=True, profiles=['spacecert-v1','spacemsg-0.4.4'])
owned(target/'native-artifact.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps(dict(binary=str(binary.relative_to(root)), sha256=manifest['binarySha256'], manifest=str((target/'native-artifact.json').relative_to(root)))))
