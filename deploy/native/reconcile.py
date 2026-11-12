#!/usr/bin/env python3
"""One shipped offline maintenance or full-restore reconciliation command."""
import argparse
import json
from pathlib import Path
import sqlite3
from common import command, config, json_file, require
from maintenance_view import maintenance_view

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--config',required=True)
    args=parser.parse_args()
    try:
        value=config(args.config);release=Path(value['currentPath']).resolve(strict=True)
        runtime=json_file(value['storeConfig'])
        with sqlite3.connect(Path(runtime['database']).as_uri()+'?mode=ro',uri=True) as database:
            row=database.execute('select version,restored from store_meta where id=1').fetchone()
            require(row is not None and row[0]==1 and row[1] in (0,1),'unrecognized-store-schema')
        mode='reconcile' if row[1] else 'maintain'
        command(['/usr/bin/systemctl','start','subspace-secrets-'+value['installation']+'-maintenance.service'],timeout=35)
        with maintenance_view(value,release) as (store_file,runner_file):
            result=json.loads(command([str(release/'bin/node'),str(release/'app/ts/src/main.ts'),mode,
                str(store_file),str(runner_file)],cwd=release/'app/ts',timeout=300))
        require(result.get('ready') is True and result.get('acknowledged') is True and result.get('sales_paused') is True,
            'paused-reconciliation-not-ready')
        print(json.dumps(result))
    except Exception:
        print(json.dumps({'ready':False,'acknowledged':False,'sales_paused':True,'code':'paused-reconciliation-refused'}))
        raise SystemExit(2)
