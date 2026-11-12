"""Drive the real product snapshot method inside the disposable platform guest."""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import subprocess
import time
import types
from types import SimpleNamespace

release=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(release/'native'))
from common import config,json_file,paths
from fence import acquire
from controller.core import Controller
from controller.host import CommandSubs
from controller.rpc import Http
from controller.recovery_backend import RecoveryBackend,RemoteJournal

value=config(sys.argv[1]);runtime=json_file(value['storeConfig']);runner=json_file(value['runnerConfig'])
owner=acquire(paths(value)['lock'],latch=paths(value)['latch'])
role=Path(json_file(value['secretsConfig'])['outputRoot'])/'maintenance';settings=json_file(value['recoveryConfig'])
settings['identityFile']=str(role/'recovery-ssh-key');settings['encryptionKeyFile']=str(role/'recovery-key')
with tempfile.TemporaryDirectory(prefix='fixture-checkpoint-',dir=value['runtimeDirectory']) as temporary:
    file=Path(temporary)/'backend.json';file.write_text(json.dumps(settings));file.chmod(0o600)
    backend=RecoveryBackend(file,release/'client/client.mjs',release/'bin/node')
    commands=lambda op:['/usr/bin/python3',str(release/'native/subs-fence.py'),'--config',value['_file'],op]
    holder=SimpleNamespace(snapshots=0,snapshot_dir=Path(runner['controller']['snapshot_dir']),recovery_backend=backend,
        journal=RemoteJournal(backend),db=sqlite3.connect(Path(runner['controller']['dir'])/'controller.db'),
        registry=SimpleNamespace(db=sqlite3.connect(runtime['database'])),
        subs_process=CommandSubs(runner['subs']['data_dir'],commands('stop'),commands('start')),
        subs_read=Http(runner['subs']['url']),ready_timeout=10,snapshot_number=Controller.snapshot_number)
    for name in ('_subs_stopped','_subs_ready','_wait_subs_ready'):
        setattr(holder,name,types.MethodType(getattr(Controller,name),holder))
    original=shutil.copytree
    def held_copy(source,destination,*args,**kwargs):
        gate=Path(value['runtimeDirectory']);(gate/'normal-snapshot.ready').write_text('stopped-and-masked')
        deadline=time.monotonic()+30
        while not (gate/'normal-snapshot.continue').exists():
            if time.monotonic()>deadline:raise RuntimeError('fixture gate deadline')
            time.sleep(0.02)
        return original(source,destination,*args,**kwargs)
    shutil.copytree=held_copy
    print(json.dumps(Controller.snapshot(holder,'ordinary-platform')))
