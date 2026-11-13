#!/usr/bin/env python3
"""Run the shipped seller CLI with fresh maintenance-role references."""
import argparse
from pathlib import Path
import sys
from common import command,config
from maintenance_view import maintenance_view

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('arguments',nargs=argparse.REMAINDER);args=parser.parse_args()
    try:
        value=config(args.config);release=Path(value['currentPath']).resolve(strict=True)
        command(['/usr/bin/systemctl','start','subspace-secrets-'+value['installation']+'-maintenance.service'],timeout=35)
        with maintenance_view(value,release) as (store_file,_runner_file):
            result=command([str(release/'bin/node'),str(release/'app/ts/src/seller.ts'),str(store_file),*args.arguments],cwd=release/'app/ts',timeout=60)
        sys.stdout.buffer.write(result)
    except Exception:sys.stderr.write('seller command unavailable; inspect private host diagnostics\n');raise SystemExit(2)
