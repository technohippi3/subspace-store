#!/usr/bin/env python3
"""Read public identity facts for explicit existing-wallet profile inputs."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
from common import require

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    for name in ('core-url','core-cookie','payment-wallet','spaced-url','spaced-cookie','operator-wallet'):
        parser.add_argument('--'+name,required=True)
    args=parser.parse_args()
    try:
        spec=importlib.util.spec_from_file_location('native_preflight',Path(__file__).with_name('host-preflight.py'))
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);rpc=module.rpc
        chain=rpc(args.core_url,args.core_cookie,'getblockchaininfo');require(chain['chain'] in ('main','regtest'))
        wallet=rpc(args.core_url,args.core_cookie,'getwalletinfo',wallet=args.payment_wallet)
        require(wallet.get('walletname')==args.payment_wallet and wallet.get('descriptors') is True and wallet.get('scanning') is False,'explicit-wallet-not-ready')
        reply=rpc(args.core_url,args.core_cookie,'listdescriptors',[False],wallet=args.payment_wallet)
        values=[row['desc'] for row in reply['descriptors']]
        require(1<=len(values)<=1000 and len(set(values))==len(values) and all(isinstance(v,str) and 1<=len(v)<=16384 and all(32<=ord(c)<=126 for c in v) for v in values))
        operator=rpc(args.spaced_url,args.spaced_cookie,'walletgetinfo',[args.operator_wallet])
        print(json.dumps({'network':'mainnet' if chain['chain']=='main' else 'regtest','core':{'url':args.core_url,'cookiePath':args.core_cookie,
            'wallet':args.payment_wallet,'genesis':rpc(args.core_url,args.core_cookie,'getblockhash',[0]),
            'descriptorHash':hashlib.sha256(json.dumps(sorted(values),separators=(',',':')).encode()).hexdigest()},
            'spaced':{'url':args.spaced_url,'cookiePath':args.spaced_cookie,'operatorWallet':args.operator_wallet},
            'readOnly':True,'operatorWalletHeight':operator.get('tip')}))
    except Exception:print(json.dumps({'readOnly':True,'ready':False,'code':'existing-wallet-identity-unavailable'}));raise SystemExit(2)
