"""Fresh bounded credential copies for the offline maintenance process only."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import stat
import tempfile
from common import atomic_json, json_file, require

def copy_cookie(source, target):
    fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        info=os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and 0<info.st_size<=4096 and not info.st_mode&0o077,'unsafe-native-cookie')
        raw=os.read(fd,4097);require(0<len(raw)<=4096,'unsafe-native-cookie')
    finally:os.close(fd)
    target.write_bytes(raw);target.chmod(0o600)

@contextmanager
def maintenance_view(value, release):
    require(os.geteuid()==0,'root-required')
    runtime=json_file(value['storeConfig']);runner=json_file(value['runnerConfig'])
    require('nativeRpc' in value and runtime.get('recoveryBackend') and runner.get('recovery_backend'),'complete-native-profile-required')
    root=Path(value['runtimeDirectory']);root.mkdir(parents=True,exist_ok=True,mode=0o700)
    with tempfile.TemporaryDirectory(prefix='maintenance-',dir=root) as temporary:
        directory=Path(temporary)
        for name in ('core','spaced'):copy_cookie(value['nativeRpc'][name]['cookiePath'],directory/(name+'.cookie'))
        runtime['core']['cookiePath']=str(directory/'core.cookie')
        runner['bitcoind']['cookie_file']=str(directory/'core.cookie');runner['spaced']['cookie_file']=str(directory/'spaced.cookie')
        if runtime.get('certificateExport'):runtime['certificateExport']['spaced']['cookiePath']=str(directory/'spaced.cookie')
        role=Path(json_file(value['secretsConfig'])['outputRoot'])/'maintenance'
        runtime['credentials']={'operator':str(role/'operator-token'),'subs':str(role/'registry-token')}
        runner['store']['operator_token_file']=str(role/'operator-token')
        recovery=json_file(value['recoveryConfig']);recovery['identityFile']=str(role/'recovery-ssh-key');recovery['encryptionKeyFile']=str(role/'recovery-key')
        atomic_json(directory/'recovery.json',recovery)
        backend={'version':1,'node':str(release/'bin/node'),'client':str(release/'client/client.mjs'),'config':str(directory/'recovery.json')}
        runtime['recoveryBackend']=backend;runner['recovery_backend']=backend
        atomic_json(directory/'store.json',runtime);atomic_json(directory/'runner.json',runner)
        yield directory/'store.json',directory/'runner.json'
