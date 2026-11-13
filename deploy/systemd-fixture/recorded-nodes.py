"""Explicit recorded native RPCs for package/application composition only."""
import argparse
import base64
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import json
from pathlib import Path
import threading

parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('role',choices=['core','subs']);args=parser.parse_args()
settings=json.loads(Path(args.config).read_bytes());calls={};mutex=threading.Lock()

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*unused):pass
    def reply(self,value,status=200):
        body=json.dumps(value).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def state(self):return json.loads(Path(settings['stateFile']).read_bytes())
    def do_GET(self):
        if args.role!='subs':self.reply({},404);return
        state=self.state()
        if self.path=='/rpc/endpoints':value={'wallet':settings['operatorWallet']}
        elif self.path=='/config':value={'registry_auth_token_set':True,'registry_auto_sync':False,'registry_endpoint':settings['registryUrl']}
        elif self.path=='/status':value={'ready':True,'network':settings['spacesNetwork']}
        else:value={'root':None,'txid':None}
        self.reply(value)
    def do_POST(self):
        raw=self.rfile.read(min(int(self.headers.get('Content-Length','0')),65537))
        if len(raw)>65536:self.reply({},413);return
        body=json.loads(raw or b'{}');state=self.state()
        if args.role=='subs':
            if self.path=='/rpc/spaced':self.reply({'result':{'network':settings['spacesNetwork'],'tip':{'hash':settings['tipHash'],'height':100}}})
            else:self.reply({'success':True})
            return
        if not state.get('coreAvailable',True):self.reply({},503);return
        credential=Path(settings['coreCookie']).read_bytes().strip()
        if self.headers.get('Authorization')!='Basic '+base64.b64encode(credential).decode():self.reply({},401);return
        method=body['method'];params=body.get('params',[])
        with mutex:
            calls[method]=calls.get(method,0)+1
            Path(settings['callsFile']).write_text(json.dumps(calls))
        value=None;error=None
        if method=='getblockchaininfo':value={'chain':settings['coreNetwork'],'blocks':100,'headers':100,'bestblockhash':settings['tipHash'],'initialblockdownload':False}
        elif method=='getnetworkinfo':value={'version':310200}
        elif method=='getmempoolinfo':value={'loaded':True}
        elif method=='getindexinfo':value={'txindex':{'synced':True,'best_block_height':100}}
        elif method=='getblockhash':value=settings['genesis'] if params[0]==0 else settings['tipHash']
        elif method=='getblockheader':value={'hash':params[0],'height':100,'confirmations':1}
        elif method=='getblockcount':value=100
        elif method=='getbestblockhash':value=settings['tipHash']
        elif method=='getwalletinfo':value={'walletname':settings['paymentWallet'],'descriptors':True,'private_keys_enabled':True,'scanning':False,'lastprocessedblock':{'height':100,'hash':settings['tipHash']}}
        elif method=='listdescriptors':value={'wallet_name':settings['paymentWallet'],'descriptors':[{'desc':settings['publicDescriptor'],'active':True,'internal':False}]}
        elif method=='listsinceblock':value={'lastblock':settings['tipHash'],'transactions':[]}
        elif method=='getserverinfo':value={'network':settings['spacesNetwork'],'tip':{'hash':settings['tipHash'],'height':100},'ready':True}
        elif method=='walletgetinfo':value={'tip':100,'scanning':False}
        elif method=='walletlisttransactions':value=[]
        elif method in ('getcommitment','getdelegation'):value=None
        elif method=='getnewaddress':value='fixture-payment-address'
        elif method=='getaddressinfo':value={'address':params[0],'scriptPubKey':settings['paymentScript'],'ismine':True}
        elif method=='getrootanchors':value=[]
        else:error={'code':-32601,'message':'recorded RPC is unavailable'}
        self.reply({'jsonrpc':'2.0','id':body.get('id'),'result':value,'error':error})

if args.role=='subs':
    data=Path(settings['subsDirectory']);(data/'state').write_bytes(b'recorded subs state for package composition')
server=ThreadingHTTPServer(('127.0.0.1',settings['corePort'] if args.role=='core' else settings['subsPort']),Handler)
server.serve_forever()
