"""Execute a fresh actual application 10,000-order encrypted SSH replay."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

DRAFT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(DRAFT/'systemd-fixture'))
from fixtures import Hosts,run,write

class ReplayHost(Hosts):
    def start_api(self):pass
    def start_native(self):pass

def replay(repository):
    host=ReplayHost()
    try:
        source=host.root/'source/ts';source.mkdir(parents=True)
        shutil.copytree(repository/'ts/src',source/'src')
        for name in ('package.json','package-lock.json'):shutil.copyfile(repository/'ts'/name,source/name)
        (source/'test/production').mkdir(parents=True)
        shutil.copyfile(repository/'ts/test/production/application-fixture.ts',source/'test/production/application-fixture.ts')
        for name,target in [('prepare.mjs','prepare.mjs'),('run.mjs','run.mjs')]:shutil.copyfile(Path(__file__).parent/name,source/target)
        result=subprocess.run(['npm','ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],cwd=source,capture_output=True,timeout=300)
        if result.returncode:raise RuntimeError('locked replay dependency preparation failed')
        hashes={str(p.relative_to(repository)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((repository/'ts/src').rglob('*')) if p.is_file()}
        commit=subprocess.run(['git','rev-parse','HEAD'],cwd=repository,capture_output=True,text=True).stdout.strip() or 'source-snapshot'
        config={'version':1,'installation':'fixture','host':'127.0.0.1','port':host.recovery_port,'user':'recovery',
          'knownHostsFile':str(host.root/'known-hosts'),'identityFile':str(host.client_key),'encryptionKeyFile':str(host.root/'encryption.key'),
          'connectTimeoutSeconds':2,'operationTimeoutSeconds':30}
        write(config['knownHostsFile'],host.known.replace('10.0.2.2','127.0.0.1'),0o600);write(config['encryptionKeyFile'],os.urandom(32),0o600)
        file=host.root/'recovery.json';write(file,config,0o600)
        env={**os.environ,'SUBSPACE_PACKAGE_CLIENT_DIRECTORY':str(DRAFT/'client'),'SUBSPACE_PACKAGE_SOURCE_COMMIT':commit}
        prepared=subprocess.run(['node',str(source/'prepare.mjs'),str(file),str(host.root/'ciphertext')],env=env,capture_output=True,timeout=180)
        if prepared.returncode:raise RuntimeError('validated application-history preparation failed: '+prepared.stderr.decode()[-2000:])
        generation=json.loads(prepared.stdout)
        run(['docker','cp',str(host.root/'ciphertext')+'/.',host.remote+':/recovery']);run(['docker','exec',host.remote,'chown','-R','recovery:recovery','/recovery'])
        run(['docker','exec',host.remote,'python3','-c',
          "import os; from pathlib import Path; root=Path('/recovery'); paths=list(root.rglob('*')); "
          "[(lambda fd:(os.fsync(fd),os.close(fd)))(os.open(p,os.O_RDONLY)) for p in paths if p.is_file()]; "
          "[(lambda fd:(os.fsync(fd),os.close(fd)))(os.open(p,os.O_RDONLY|os.O_DIRECTORY)) for p in [*sorted((p for p in paths if p.is_dir()),key=lambda p:len(p.parts),reverse=True),root]]"],timeout=180)
        shutil.rmtree(host.root/'ciphertext');target=host.root/'seller';target.mkdir(mode=0o700)
        began=time.monotonic();process=subprocess.Popen(['timeout','180','node',str(source/'run.mjs'),str(file),str(target)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        first=process.stdout.readline();elapsed=time.monotonic()-began;tail,errors=process.communicate(timeout=max(1,185-elapsed))
        if process.returncode:raise RuntimeError('actual production replay failed: '+errors[-2000:])
        evidence={'scope':'fresh actual production restoreApplication over encrypted pinned OpenSSH','source':generation,'sourceHashes':hashes,
          'wallMilliseconds':round(elapsed*1000),**json.loads(first),'guard':json.loads(tail),'withinRestoreRequirement':elapsed<60}
        output=os.environ.get('SUBSPACE_PACKAGE_EVIDENCE_DIRECTORY')
        if output:Path(output).mkdir(parents=True,exist_ok=True);write(Path(output)/'O149-live-replay.json',evidence)
        print(json.dumps(evidence))
        if elapsed>=60:raise AssertionError('10,000-order restore exceeded one minute')
    finally:host.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source-root',required=True);args=parser.parse_args();replay(Path(args.source_root).resolve())
