import {createServer} from 'node:http';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {Effect} from 'effect';
import {controllerRecovery} from '../../src/runtime/reconciliation.ts';
import {SalesStore} from '../../src/application/store.ts';
import {restoreApplication} from '../../src/application/recovery.ts';
import {serveOperator} from '../../src/application/operator-http.ts';
import {use} from './application-fixture.ts';
import {credential} from './entry-http-fixture.ts';
import {assert,run,scoped} from './controller-case-fixture.mjs';

// Real application replay, real Python controller replay/reconciliation,
// production independent statement verification and live journal confirmation.
// Core/spaced/subs are recording RPC boundaries; upstream disk restore is not
// simulated as controller logic and is not claimed as real host qualification.
export async function restoreBoundary(t,w,callback){
 const calls=[];
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const part of req)chunks.push(Buffer.from(part));
  const x=w.chain;let value;
  if(req.method==='GET'){value={root:x.root,txid:x.known?x.txid:null};res.end(JSON.stringify(value));return;}
  const q=JSON.parse(Buffer.concat(chunks).toString());calls.push(q.method);
  const tx={txid:x.txid,vin:[{txid:x.delegate.split(':')[0],vout:Number(x.delegate.split(':')[1])}],vout:[{scriptPubKey:{hex:'6a20'+x.root}}],...(x.minedHeight===null?{}:{blockhash:'b'.repeat(64)})};
  switch(q.method){
   case 'getblockchaininfo':value={blocks:w.f.node.tip,bestblockhash:x.tipHash,chain:'regtest'};break;
   case 'getserverinfo':value={network:'regtest',tip:{hash:x.tipHash},ready:true};break;
   case 'walletgetinfo':value={tip:w.f.node.tip};break;
   case 'walletlisttransactions':value=[...(x.known?[{txid:x.txid}]:[]),...(x.conflictActive?[{txid:x.conflictTxid}]:[])];break;
   case 'getrawtransaction':value=tx;break;
   case 'getblockhash':value='b'.repeat(64);break;
   case 'getblockheader':value={hash:'b'.repeat(64),height:x.minedHeight,confirmations:w.f.node.tip-x.minedHeight+1};break;
   case 'getmempoolentry':value={};break;
   case 'getcommitment':{const root=q.params[1]??x.latestRoot??x.root;const height=x.roots[root];value=height===null||height===undefined?null:{state_root:root,block_height:height};break;}
   default:res.end(JSON.stringify({id:q.id,result:null,error:{code:-1,message:'unrecorded '+q.method}}));return;
  }
  res.end(JSON.stringify({jsonrpc:'2.0',id:q.id,result:value,error:null}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const config={...w.f.config,network:'regtest',database:join(w.f.root,'restored.db'),core:{url,cookiePath:join(w.f.root,'rpc-cookie'),wallet:'mock-wallet'}};
 writeFileSync(config.core.cookiePath,'recording:recording',{mode:0o600});
 const host={network:'regtest',controller:{journal_dir:join(w.f.root,'controller-journal'),operator_wallet:'mock-wallet'},spaced:{url,cookie_file:config.core.cookiePath},subs:{url}};
 const hostFile=join(w.f.root,'recovery-host.json');writeFileSync(hostFile,JSON.stringify(host));
 const native=controllerRecovery(config,hostFile);
 await scoped(restoreApplication(config));
 if(await import('node:fs').then(fs=>fs.existsSync(join(w.f.root,'controller.db'))))renameSync(join(w.f.root,'controller.db'),join(w.f.root,'controller-before-loss.db'));
 const controller={...native,run:input=>Effect.tryPromise({try:async()=>{
  writeFileSync(join(w.f.root,'inventory.json'),JSON.stringify(input));
  const result=await w.command('offline-proof','b1',url,config.database);assert.equal(result.error,null,JSON.stringify(result.error));return result.result;
 },catch:error=>error})};
 const reconciled=await scoped(SalesStore.reconcileRecovery(config,w.f.adapters,controller));assert.equal(reconciled.ready,true);assert.equal(reconciled.sales_paused,true);
 return use({...w.f,config},store=>Effect.gen(function*(){const listener=yield*serveOperator(store,Effect.succeed(credential));return yield*Effect.promise(()=>callback({store,config,calls,command:(mode,bid='b1')=>w.command(mode,bid,listener.url,config.database)}));}));
}
