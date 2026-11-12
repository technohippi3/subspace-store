#!/usr/bin/env python3
"""Persistent restart fencing for one attended controller checkpoint."""
import argparse
import fcntl
import os
from pathlib import Path
import sys
import pwd
from common import Refused, atomic_json, command, config, json_file, paths, require, sync_directory
from fence import acquire
from units import unit

def fingerprint(pid):
    process=Path('/proc')/str(pid);stat=(process/'stat').read_text();fields=stat[stat.rfind(')')+2:].split()
    return {'pid':pid,'uid':process.stat().st_uid,'start':fields[19],'boot':Path('/proc/sys/kernel/random/boot_id').read_text().strip()}

def controller_owner(value):
    require(os.geteuid()==0,'root-required')
    pid=os.getppid();owner=fingerprint(pid)
    args=(Path('/proc')/str(pid)/'cmdline').read_bytes().split(b'\0');require(sum(map(len,args))<=16384,'unsupported-controller-owner')
    require(owner['uid']==0 and args[1:3] in ([b'-m',b'runner'],[b'-m',b'runner.recover_store']) and
        (Path('/proc')/str(pid)/'cwd').resolve()==(Path(value['currentPath']).resolve()/'app') and
        (Path('/proc')/str(pid)/'exe').resolve()==Path(sys.executable).resolve(),'unsupported-controller-owner')
    return owner

def control(value,operation,confirm=None):
    require(os.geteuid()==0,'root-required');state=paths(value)
    require(not os.path.lexists(state['latch']),'installation-maintenance-active')
    fd=os.open(state['subsLock'].with_suffix('.control'),os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if operation=='stop':
            owner=controller_owner(value)
            if os.path.lexists(state['subsLatch']):require(json_file(state['subsLatch'])['owner']==owner,'subs-checkpoint-owned')
            atomic_json(state['subsLatch'],{'version':1,'owner':owner,'phase':'stopping'})
            command(['/usr/bin/systemctl','mask','--runtime',unit(value,'subs')])
            command(['/usr/bin/systemctl','stop',unit(value,'subs')],timeout=35)
            require(command(['/usr/bin/systemctl','show',unit(value,'subs'),'--property=MainPID','--value']).strip()==b'0','subs-still-active')
            lock=acquire(state['subsLock'],exclusive=True);os.close(lock)
            require(command(['/usr/bin/systemctl','show',unit(value,'subs'),'--property=LoadState','--value']).strip()==b'masked','subs-not-masked')
            atomic_json(state['subsLatch'],{'version':1,'owner':owner,'phase':'stopped'})
        else:
            old=json_file(state['subsLatch']);require(old.get('version')==1 and old.get('phase')=='stopped','subs-stop-not-established')
            if operation=='start':require(old['owner']==controller_owner(value),'subs-checkpoint-owner-changed')
            else:
                require(confirm==value['installation'],'explicit-installation-confirmation-required')
                try:alive=fingerprint(old['owner']['pid'])==old['owner']
                except (OSError,IndexError):alive=False
                require(not alive,'subs-checkpoint-owner-still-live')
                from host import maintenance
                report=maintenance(value);require(report['paused'] and report['acknowledged'] and report['chain'] is not None,'paused-owner-review-required')
            lock=acquire(state['subsLock'],exclusive=True)
            if os.path.lexists(state['lock'].parent/'recovery.json'):
                from recover import private_tree
                runner=json_file(value['runnerConfig']);user=pwd.getpwnam(value['services']['subs']['user'])
                private_tree(runner['subs']['data_dir'],user.pw_uid,user.pw_gid)
            state['subsLatch'].unlink();sync_directory(state['subsLatch'].parent);os.close(lock)
            try:
                command(['/usr/bin/systemctl','unmask','--runtime',unit(value,'subs')])
                command(['/usr/bin/systemctl','start',unit(value,'subs')],timeout=35)
            except BaseException:
                atomic_json(state['subsLatch'],old);raise
    finally:os.close(fd)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('operation',choices=['stop','start','recover']);parser.add_argument('--confirm');args=parser.parse_args()
    try:control(config(args.config),args.operation,args.confirm)
    except Exception as error:
        sys.stderr.write((error.code if isinstance(error,Refused) else 'subs-checkpoint-fence-refused')+'\n');raise SystemExit(75)
