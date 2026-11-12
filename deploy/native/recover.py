"""Explicit installed-profile recovery, with persistent masks during raw SH work."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import pwd
import sqlite3
import stat
import tempfile
import time
from common import Refused, atomic_json, command, json_file, paths, require, sync_directory
from checkpoint import store_prefix
from fence import acquire
from maintenance_view import maintenance_view
from units import control, prepare, stopped, unit

def private_tree(directory,uid,gid):
    directory=Path(directory)
    require(directory.is_dir() and not directory.is_symlink(),'unsafe-restored-directory')
    device=directory.stat().st_dev
    selected=[directory]
    for path in directory.rglob('*'):
        require(len(selected)<16384,'restored-tree-too-large');selected.append(path)
    for path in selected:
        info=path.lstat();require(not stat.S_ISLNK(info.st_mode) and info.st_dev==device and info.st_uid in (0,uid),'unsafe-restored-owner')
        require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) and info.st_nlink==1,'unsafe-restored-object')
        require(not info.st_mode&0o077,'unsafe-restored-permissions')
    for path in reversed(selected):
        if path.lstat().st_uid==0:os.chown(path,uid,gid,follow_symlinks=False)
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        try:os.fsync(fd)
        finally:os.close(fd)

def adopt_store(value,release):
    runtime=json_file(value['storeConfig']);file=Path(runtime['database']);identity={'version':1,'network':runtime['network'],
        'wallet':runtime['core']['wallet'],**runtime['installation']}
    require(runtime.get('version')==2 and file.is_file() and not file.is_symlink(),'recognized-v2-restore-required')
    with sqlite3.connect(file.as_uri()+'?mode=ro',uri=True) as database:
        row=database.execute("select value from records where kind='installation_identity' and key='global'").fetchone()
        require(row and json.loads(row[0])==identity,'restored-installation-identity-mismatch')
        store_prefix(database,value,release)
    user=pwd.getpwnam(value['services']['store']['user'])
    for suffix in ('','-wal','-shm','-journal','.lock'):
        path=Path(str(file)+suffix)
        if not os.path.lexists(path):continue
        info=path.lstat();require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid in (0,user.pw_uid) and not info.st_mode&0o077,'unsafe-restored-store-file')
        if info.st_uid==0:os.chown(path,user.pw_uid,user.pw_gid,follow_symlinks=False)
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        try:os.fsync(fd)
        finally:os.close(fd)
    for directory in [Path(str(file)+'.certificates'),Path(runtime.get('certificateExport',{}).get('directory',str(file)+'.exports'))]:
        require(directory!=file.parent and directory.is_relative_to(file.parent),'restored-cache-outside-application')
        if os.path.lexists(directory):private_tree(directory,user.pw_uid,user.pw_gid)

@contextmanager
def secret_source(value,release,attended):
    if not attended:
        yield value;return
    root=Path(value['runtimeDirectory']);root.mkdir(parents=True,exist_ok=True,mode=0o700)
    with tempfile.TemporaryDirectory(prefix='attended-source-',dir=root) as temporary:
        selected=dict(value);secrets=json_file(value['secretsConfig']);secrets['source']='attended'
        file=Path(temporary)/'secrets.json';atomic_json(file,secrets);file.chmod(0o644)
        # The retrieval user must read only this configuration reference. The
        # supplied credential files remain in the fixed private attended root.
        selected['secretsConfig']=str(file)
        prepare(selected,release)
        try:yield selected
        finally:prepare(value,release)

def reset_failed_secrets(value,selected):
    for role in json_file(selected['secretsConfig'])['roles']:
        name='subspace-secrets-'+value['installation']+'-'+role+'.service'
        # Completed oneshots can be unloaded. reset-failed refuses unloaded
        # units, so inspect the specific role before attempting that action.
        if command(['/usr/bin/systemctl','show',name,'--property=ActiveState','--value']).strip()==b'failed':
            command(['/usr/bin/systemctl','reset-failed',name])

def recover(value,confirm,attended=False):
    from installer import capabilities, current_receipt, fetch_runtime, live_ready
    from release import digest_file, SCHEMAS
    capabilities(value);require(confirm==value['installation'],'explicit-installation-confirmation-required')
    state=paths(value);receipt=current_receipt(value);require(receipt is not None,'installed-release-required')
    release=Path(value['currentPath']).resolve(strict=True);manifest=json_file(release/'.verified-manifest.json',16*1024*1024)
    require(manifest['_digest']==receipt['manifestDigest'] and manifest['schemas']==SCHEMAS,'verified-recovery-release-required')
    for path,item in manifest['files'].items():require(not (release/path).is_symlink() and digest_file(release/path)==item['sha256'],'installed-release-modified')
    updater=os.open(state['lock'].parent/'updater.lock',os.O_RDWR|os.O_NOFOLLOW)
    prepared=False
    try:
        try:fcntl.flock(updater,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise Refused('installation-update-busy') from None
        require(current_receipt(value)['manifestDigest']==receipt['manifestDigest'] and Path(value['currentPath']).resolve(strict=True)==release,
            'installed-release-changed-before-recovery')
        record={'version':1,'phase':'recovery-stopping','target':receipt['release'],'manifestDigest':receipt['manifestDigest'],
            'priorPaused':True,'reviewCount':receipt['reviewCount'],'checkpoint':receipt.get('checkpoint'),'applicationPath':str(release/'app')}
        atomic_json(state['latch'],record);atomic_json(state['lock'].parent/'recovery.json',record)
        prepared=True
        control(value,'stop');stopped(value)
        # Persistent masks survive a process death or reboot during the narrow
        # normal-SH restore window. All credential-bearing listeners stay off.
        command(['/usr/bin/systemctl','mask',*[unit(value,r) for r in ('store','proxy','subs')]])
        exclusive=acquire(state['lock'],exclusive=True)
        try:
            with secret_source(value,release,attended) as selected:
                reset_failed_secrets(value,selected)
                fetch_runtime(selected)
                # No normal shared owner is called while EX is held. The
                # fixed service masks retain the persistent exclusion here.
                state['latch'].unlink();sync_directory(state['latch'].parent);os.close(exclusive);exclusive=None
                runtime=json_file(value['storeConfig'])
                if not Path(runtime['database']).exists():
                    with maintenance_view(value,release) as (store_file,runner_file):
                        report=json.loads(command([str(release/'bin/node'),str(release/'app/ts/src/main.ts'),'restore',str(store_file)],cwd=release/'app/ts',timeout=300))
                    require(report.get('acknowledged') is True,'restored-application-not-acknowledged')
                # An old ordinary checkpoint latch cannot be abandoned while
                # its exact controller process is still alive.
                if os.path.lexists(state['subsLatch']):
                    old=json_file(state['subsLatch']);from importlib.util import spec_from_file_location,module_from_spec
                    spec=spec_from_file_location('subs_fence',release/'native/subs-fence.py');module=module_from_spec(spec);spec.loader.exec_module(module)
                    try:alive=module.fingerprint(old['owner']['pid'])==old['owner']
                    except (OSError,IndexError):alive=False
                    require(not alive,'subs-checkpoint-owner-still-live');state['subsLatch'].unlink();sync_directory(state['subsLatch'].parent)
                runner=json_file(value['runnerConfig']);user=pwd.getpwnam(value['services']['subs']['user'])
                private_tree(runner['subs']['data_dir'],user.pw_uid,user.pw_gid)
                command(['/usr/bin/systemctl','unmask',unit(value,'subs')]);command(['/usr/bin/systemctl','unmask','--runtime',unit(value,'subs')])
                control(value,'start',('subs',))
                # A controller restore may replace subs from the remote set.
                # Its fixed start helper adopts only that stopped private tree.
                result=json.loads(command(['/usr/bin/python3',str(release/'native/reconcile.py'),'--config',value['_file']],timeout=300))
                require(result.get('ready') is True and result.get('acknowledged') is True,'paused-recovery-proof-required')
                adopt_store(value,release)
                # Read-only recovery and exact ownership adoption are complete.
                # Normal shared owners may now start only this paused package.
                (state['lock'].parent/'recovery.json').unlink();sync_directory(state['lock'].parent)
                for role in ('store','proxy'):
                    command(['/usr/bin/systemctl','unmask',unit(value,role)]);command(['/usr/bin/systemctl','unmask','--runtime',unit(value,role)])
                control(value,'start',('store',))
                deadline=time.monotonic()+30
                while True:
                    try:report=live_ready(value,release,receipt['reviewCount']);break
                    except Exception:require(time.monotonic()<deadline,'restored-store-not-ready');time.sleep(0.1)
                control(value,'start',('proxy',))
                deadline=time.monotonic()+30
                while True:
                    try:command([str(release/'bin/node'),str(release/'native/proxy.mjs'),'--check-live',value['_file']]);break
                    except Exception:require(time.monotonic()<deadline,'restored-https-not-ready');time.sleep(0.1)
                atomic_json(state['receipt'],{**receipt,'reviewCount':report['reviewCount'],'priorPaused':True})
                command(['/usr/bin/systemctl','enable',*[unit(value,r) for r in ('store','subs','proxy')]])
                return {'ok':True,'ready':True,'paused':True,'release':receipt['release'],'productionReady':report.get('productionReady',True),
                    'waitingSellerSetup':report.get('waitingSellerSetup',False),'recovered':True,'credentialSource':'attended' if attended else 'infisical'}
        finally:
            if exclusive is not None:os.close(exclusive)
    except BaseException:
        if not prepared:raise
        record={'version':1,'phase':'failed-paused','diagnostic':'attended-recovery-required','target':receipt['release'],'manifestDigest':receipt['manifestDigest'],
            'priorPaused':True,'reviewCount':receipt['reviewCount'],'checkpoint':receipt.get('checkpoint'),'applicationPath':str(release/'app')}
        atomic_json(state['latch'],record);atomic_json(state['lock'].parent/'recovery.json',record)
        try:control(value,'stop');command(['/usr/bin/systemctl','mask',*[unit(value,r) for r in ('store','subs','proxy')]])
        except Exception:pass
        raise
    finally:os.close(updater)
