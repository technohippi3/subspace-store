#!/usr/bin/env python3
"""Start pinned loopback subs and install only its per-start registry binding."""
import argparse
import json
import os
from pathlib import Path
import signal
import sqlite3
import fcntl
import subprocess
import time
import urllib.request
from urllib.parse import urlsplit
from common import config, json_file, paths, require
from credential_file import protected
from fence import acquire

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise RuntimeError('local subs redirected')

def prepare_config(value,runner,credential_directory):
    token=protected(credential_directory/'registry-token',256);require(32<=len(token)<=256,'registry-credential-unavailable')
    runtime=json_file(value['storeConfig']);endpoint='http://127.0.0.1:'+str(runtime['listen']['subs'])
    file=Path(runner['subs']['data_dir'])/'config.db'
    require(not file.is_symlink() and (not file.exists() or file.is_file() and file.stat().st_nlink==1),'unsafe-subs-config')
    if not file.exists():fd=os.open(file,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
    with sqlite3.connect(file,isolation_level=None) as database:
        tables=database.execute("select name from sqlite_master where type='table'").fetchall()
        require(not tables or tables==[('config',)],'unsupported-subs-config')
        if tables:require([(r[1],r[2],r[3],r[5]) for r in database.execute('pragma table_info(config)')]==
            [('key','TEXT',0,1),('value','TEXT',1,0)],'unsupported-subs-config')
        database.execute('pragma synchronous=full');database.execute('begin immediate')
        database.execute('create table if not exists config(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
        for name,data in {'registry_endpoint':endpoint,'registry_auth_token':token.decode().strip(),'registry_auto_sync':'0','prover_endpoint':value['proverUrl']}.items():
            database.execute('insert or replace into config values(?,?)',(name,data))
        database.execute('commit')
    fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)
    from common import sync_directory
    sync_directory(file.parent)

def configured(value,runner):
    runtime=json_file(value['storeConfig']);endpoint='http://127.0.0.1:'+str(runtime['listen']['subs'])
    request=urllib.request.Request(runner['subs']['url']+'/config')
    with urllib.request.build_opener(NoRedirect()).open(request,timeout=3) as response:
        raw=response.read(65537);require(len(raw)<=65536,'subs-response-oversize')
    result=json.loads(raw);require(result.get('registry_auth_token_set') is True and
        result.get('registry_endpoint')==endpoint and result.get('registry_auto_sync') is False,'subs-registry-binding-refused')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);args=parser.parse_args();child=None
    try:
        value=config(args.config);owner=acquire(paths(value)['lock'],latch=paths(value)['latch'])
        subs_owner=acquire(paths(value)['subsLock'],latch=paths(value)['subsLatch'])
        runner=json_file(value['runnerConfig']);release=Path(value['currentPath']).resolve(strict=True)
        directory=Path(os.environ['CREDENTIALS_DIRECTORY']);cookie=directory/'spaced-cookie'
        data_lock=os.open(Path(runner['subs']['data_dir'])/'writer.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
        fcntl.flock(data_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        prepare_config(value,runner,directory)
        # The profile pins subs-combined's reviewed loopback/U1(b)/relay build.
        arguments=[str(release/'bin/subs'),'--port',str(urlsplit(runner['subs']['url']).port),
            '--data-dir',runner['subs']['data_dir'],'--wallet',runner['controller']['operator_wallet'],'--rpc-url',runner['spaced']['url'],
            '--rpc-cookie',str(cookie),'--fabric-seed',runner['relay']['url']]
        child=subprocess.Popen(arguments,pass_fds=(owner,subs_owner,data_lock),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        def stop(*unused):
            if child.poll() is None:child.terminate()
        signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
        deadline=time.monotonic()+30
        while True:
            require(child.poll() is None,'subs-exited-before-binding')
            try:configured(value,runner);break
            except Exception:require(time.monotonic()<deadline,'subs-binding-not-ready');time.sleep(0.1)
        raise SystemExit(child.wait())
    except Exception:
        if child and child.poll() is None:
            child.terminate()
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:child.kill();child.wait()
        raise SystemExit(75)
