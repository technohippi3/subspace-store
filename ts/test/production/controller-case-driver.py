"""Actual controller/runner and HTTP client; only upstream boundaries are recorded.
No simulated store, controller reducer, model imports or chain transaction is used.
"""
import json, os, sys
from pathlib import Path
repo=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(repo))
from controller.core import Clients, Controller, Capabilities
from controller.journal import Journal
from controller.errors import Refused
from controller.publication import Publisher
from runner.cli import Runner
from runner.store import configured_store
from runner.recovery_bridge import RecoveryStore, digest

mode,url,token,database,journal_directory,test_root,bid=sys.argv[1:]
root=Path(test_root); cfg_file=root/'chain.json'; state_file=root/'subs.json'
if not state_file.exists(): state_file.write_text(json.dumps(dict(handles={},broadcasts=[],rollbacks=0,publishes=0,commits=0,calls=[])))
def cfg(): return json.loads(cfg_file.read_text())
def state(): return json.loads(state_file.read_text())
def save(s): state_file.write_text(json.dumps(s))
store=RecoveryStore(json.loads((root/'inventory.json').read_text())) if mode=='offline-proof' else configured_store(dict(implementation='typescript',url=url,operator_token_file=token,db=database,journal_dir=journal_directory))
journal=Journal(root/'controller-journal','runner')
if mode=='journal-up':journal.set_down(False)
class Rpc:
 def call(self,method,*params):
  x=cfg(); tip=x['tipHeight']; height=x.get('minedHeight'); txid=x['txid']; delegate=x['delegate']; parent,vout=delegate.split(':')
  if method=='getblockchaininfo':return dict(blocks=tip,bestblockhash=x['tipHash'],chain='regtest')
  if method=='getbestblockhash':return x['tipHash']
  if method=='getserverinfo':return dict(network='regtest',tip=dict(hash=x['tipHash']),ready=True)
  if method=='getblockcount':return tip
  if method=='getdelegation':return 'mock-num'
  if method=='getnum':return dict(txid=parent,n=int(vout),spent=False)
  if method=='getrootanchors':return [dict(block=dict(height=x['anchorHeight']))] if x.get('anchorHeight') is not None else []
  if method=='getcommitment':
   r=params[1] if len(params)>1 and params[1] else x.get('latestRoot',x['root'])
   h=x['roots'].get(r)
   return dict(state_root=r,block_height=h) if h is not None else None
  if method=='getrawmempool':return [txid] if x.get('known') and x.get('mempool') else []
  if method=='getrawtransaction':
   if params[0]==x.get('conflictTxid'):
    if not x.get('conflictActive'):raise LookupError('recorded conflict absent')
    return dict(txid=params[0],blockhash='e'*64,vin=[dict(txid=parent,vout=int(vout))],vout=[])
   if params[0]!=txid or not x.get('known'):raise LookupError('recorded transaction absent')
   if len(params)==1:return '00'
   return dict(txid=txid,hex='00',vin=[dict(txid=parent,vout=int(vout))],vout=[dict(scriptPubKey=dict(hex='6a20'+x['root']))],
     **(dict(blockhash='b'*64,confirmations=tip-height+1) if height is not None else {}))
  if method=='getblockheader':
   if params[0]=='e'*64:return dict(height=x.get('conflictHeight',290),confirmations=tip-x.get('conflictHeight',290)+1 if x.get('conflictActive') else -1)
   return dict(height=height if height is not None else tip,confirmations=tip-height+1 if height is not None else 1)
  if method=='getblockhash':return 'e'*64 if params[0]==x.get('conflictHeight') else 'b'*64
  if method=='getmempoolentry':
   if not x.get('known') or not x.get('mempool'):raise LookupError('absent')
   return {}
  if method=='walletlisttransactions':return [dict(txid=txid,block_height=height)] if x.get('known') else []
  if method=='walletgetinfo':return dict(tip=tip)
  if method=='decoderawtransaction':return dict(txid=txid,vin=[dict(txid=parent,vout=int(vout))],vout=[dict(scriptPubKey=dict(hex='6a20'+x['root']))])
  if method=='sendrawtransaction':
   s=state();s.setdefault('raw_sends',[]).append(params[0]);save(s);x['known']=True;x['mempool']=True;cfg_file.write_text(json.dumps(x));return txid
  raise AssertionError((method,params))
rpc=Rpc()
class Subs:
 def get(self,path,raw=False,**kwargs):
  x=cfg();s=state()
  if path=='/rpc/endpoints':return dict(wallet='mock-wallet')
  if path=='/status':return dict(status='ready')
  if '/pipeline' in path:
   waiting=mode=='prepare-wait-prove' and not (root/'allow-proof').exists()
   if waiting:(root/'prove-entered').touch()
   return dict(root=x['root'],txid=x['txid'] if x.get('known') else None,steps=dict(proving='pending' if waiting else 'complete'),pending_proofs=1 if waiting else 0,proving_job_active=waiting)
  if '/commit/status' in path:return dict(txid=x['txid'] if x.get('known') else None)
  if '/certs/' in path:
   handle=path.split('/')[2];o=next(o for o in [store.order(m) for m in x['oids']] if o['name']==handle)
   certroot=x.get('certificateRoot',x['root']);h=x['roots'].get(certroot,x.get('certificateHeight',50))
   return json.dumps(dict(verified=True,zones=[dict(handle=handle,script_pubkey=o['recipient_spk'],sovereignty=x.get('sovereignty','sovereign')),
    dict(handle='@space',commitment_root=certroot,commitment_height=h)])).encode()
  if '/handles?' in path:return dict(handles=[dict(name=n,**v) for n,v in s['handles'].items() if v['commitment_root'] is None],total_pages=1)
  if '/handles/' in path:return s['handles'][path.rsplit('/',1)[1]]
  raise AssertionError(path)
 def post(self,path,body=None,raw=False,**kwargs):
  x=cfg();s=state();s['calls'].append(dict(path=path,body=body));save(s)
  if path=='/rpc/spaced':return dict(result=rpc.call(body['method'],*body['params']))
  if path=='/registry/sync':
   for oid in x['oids']:
    o=store.order(oid);name=o['name'].split('@')[0]
    s['handles'].setdefault(name,dict(commitment_root=None,script_pubkey=o['recipient_spk'],parked=False,publish_status=None))
   save(s);return {}
  if path.endswith('/commit'):
   s['commits']+=1;newroot=hex(s['commits']+9)[2:]*64
   for v in s['handles'].values():
    if v['commitment_root'] is None and not v['parked']:v['commitment_root']=newroot
   save(s);x['root']=newroot;cfg_file.write_text(json.dumps(x));return dict(root=newroot)
  if path.endswith('/rollback-local'):
   for v in s['handles'].values():v['commitment_root']=None
   s['rollbacks']+=1;save(s);return {}
  if path.endswith('/park'):
   for name in body['handles']:s['handles'][name]['parked']=body['parked']
   save(s);return {}
  if path.endswith('/publish'):
   for name in body['handles']:s['handles'][name]['publish_status']='final'
   s['publishes']+=1;save(s);return dict(handles_published=len(body['handles']),remaining=0)
  if path.endswith('/commit/txid'):return {}
  if path.endswith('/broadcast'):
   s['broadcasts'].append(dict(path=path,body=body,delegate=x['delegate']));save(s)
   x['known']=True;x['mempool']=True;cfg_file.write_text(json.dumps(x))
   if mode=='crash-after-network':os._exit(9)
   if mode=='lost-answer':raise ConnectionError('recording boundary lost reply')
   return json.dumps(dict(txid=x['txid'])).encode()
  raise AssertionError(path)
subs=Subs();verifier=root/'recording-verifier'
verifier.write_text('#!'+sys.executable+'\nimport pathlib,sys\nprint(pathlib.Path(sys.argv[1]).read_text())\n');verifier.chmod(0o700)
c=Controller(root/'controller.db',journal,store,Clients(lambda:subs,lambda:subs,lambda:rpc,lambda:rpc),None,verifier,root/'work','mock-wallet',Capabilities(attach_txid=True))
# The fixture supplies the already-proved/checkpointed precondition. The
# snapshot boundary is recorded; these tests make no OS backup claim.
c.snapshot=lambda label=None: dict(recorded_checkpoint=label)
publisher=Publisher(c,store,journal,root/'publication.db',subs,'http://127.0.0.1:9')
class Relay:
 def get(self,path,raw=False):
  import urllib.parse
  handle=urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)['q'][0].split(',')[-1]
  return subs.get('/certs/'+handle+'/message',raw=True)
publisher.relay=Relay();runner=Runner(store,c,publisher)
result=None;error=None;errors=[]
try:
 if mode=='controller-down-after-entry' or mode=='recover-intent-same-process':
  entry=store.entry_status
  def entry_then_down(batch,create=False):
   answer=entry(batch,create)
   if create:journal.set_down(True)
   return answer
  store.entry_status=entry_then_down
 if mode=='crash-after-rebuild-guard':
  note=c._note_failed_rebuild
  def die_after_guard(batch):
   note(batch);os._exit(9)
  c._note_failed_rebuild=die_after_guard
 if mode=='stop-after-intent':c._send=lambda bid:os._exit(9)
 if mode=='crash-after-arm':
  arm=store.arm_entry
  def crash_arm(batch):
   arm(batch);os._exit(9)
  store.arm_entry=crash_arm
 if mode=='crash-before-network':
  saved=c._save
  def crash_at_attempt(bid,**fields):
   result=saved(bid,**fields)
   if fields.get('attempted')==1:os._exit(9)
   return result
  c._save=crash_at_attempt
 if mode in ('prepare','prepare-wait-prove'):
  result=c.freeze('@space');c.stage(result);c.commit_local(result);c.prove(result,timeout=10 if mode=='prepare-wait-prove' else 1,poll=0.01 if mode=='prepare-wait-prove' else 0);c.checkpoint(result)
 elif mode=='prepare-child':
  c.stage(bid);c.commit_local(bid);c.prove(bid,timeout=1,poll=0);c.checkpoint(bid);result=bid
 elif mode=='freeze':result=c.freeze('@space')
 elif mode in ('issue','lost-answer','crash-after-network','crash-before-network','crash-after-arm','stop-after-intent','controller-down-after-entry','crash-after-rebuild-guard'):result=runner.issue(bid,1,bid)
 elif mode=='resume':result=runner.resume(bid,bid)
 elif mode=='recover-intent-same-process':
  try:runner.issue(bid,1,bid)
  except Exception as e:errors.append(str(e))
  journal.set_down(False);result=runner.resume(bid,bid)
  try:runner.resume(bid,bid)
  except Exception as e:errors.append(str(e))
 elif mode=='watch':result=c.watch(bid)
 elif mode=='certify':result=runner.certify(bid)
 elif mode=='enroll':result=publisher.enroll(bid)
 elif mode=='publish':result=runner.publish(bid)
 elif mode=='publish-only':publisher.enroll(bid);result=publisher.publish_outstanding(bid)
 elif mode=='resolve-incident':
  result=store.op('POST','/operator/incidents/resolve',dict(incident=next(i['id'] for i in store.status()['recovery_incidents'] if i['oid']=='o1' and i['resolution'] is None),resolution='operator reviewed preserved delivery'))
 elif mode=='confirm':result=publisher.confirm_delivery(bid,'o1')
 elif mode=='readback':result=c.readback(bid)
 elif mode=='refund-broadcast':result=runner.broadcast_refund(cfg()['refundGroupId'],cfg()['refundGroupId'],cfg()['refundTxid'])
 elif mode=='rebroadcast':result=runner.rebroadcast(bid,bid)
 elif mode=='retry-release':result=c.resume_release(bid)
 elif mode=='rollback':result=c.rollback_local(bid)
 elif mode=='supersede':result=runner.supersede(bid,cfg()['conflictTxid'],bid)
 elif mode=='offline-proof':
  c.restore_from_journal();statement=c.bound_statement();proof=digest(statement);position=journal.append('store_reconciliation',statement=statement,proofHash=proof);result=dict(statement=statement,position=position,proofHash=proof)
 elif mode=='replay-offline':
  c.registry=RecoveryStore(json.loads((root/'inventory.json').read_text()));result=c.restore_from_journal()
 elif mode=='journal-up':result=True
 elif mode=='status':result=runner.status()
 else:raise AssertionError(mode)
except Exception as exc:error=dict(type=type(exc).__name__,message=str(exc))
finally:
 out=dict(result=result,error=error,errors=errors,batches=c.batches(),alerts=c.alerts(),journal=journal.entries(),subs=state())
 print(json.dumps(out));publisher.db.close();c.close()
