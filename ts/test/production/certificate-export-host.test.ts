import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Effect} from 'effect';
import {CoreAdapter} from '../../src/bitcoin/core.ts';
import {GENESIS} from '../../src/bitcoin/identity.ts';
import {trustedRootAnchors} from '../../src/runtime/export-anchors.ts';
import {configuration} from '../../src/runtime/config.ts';
import {refundPolicy} from './application-fixture.ts';
const hash='a'.repeat(64),block='b'.repeat(64);
const context={oid:'o1',entry:'1'.repeat(32),revision:1,hash:'c'.repeat(64),root:'d'.repeat(64),height:100,recipient:'5120'+'0'.repeat(63)+'1',handle:'one@space',message:Buffer.alloc(1)};
function config(){return {version:2,network:'regtest',installation:{genesis:GENESIS.regtest,descriptorHash:'1'.repeat(64)},maintenanceLock:'/state/installation.lock',database:'/state/store.db',journalDirectory:'/offhost/store',listen:{buyer:8000,operator:8001,subs:8002},core:{url:'http://127.0.0.1:18443',cookiePath:'/keys/core.cookie',wallet:'sales'},credentials:{operator:'/keys/operator',subs:'/keys/subs'},riskBudgetSats:1000000,refundPolicy,merchantDestinations:[],pollMilliseconds:1000,certificateExport:{trustedOrigin:'https://certificates.example.test',binary:'/opt/store/bin/subspace-export',artifactManifest:'/opt/store/native-artifact.json',directory:'/state/exports',ttlSeconds:60,spaced:{url:'http://127.0.0.1:7225',cookiePath:'/keys/spaced.cookie'}}};}
async function boundary(t:TestContext){
 const root=mkdtempSync(join(tmpdir(),'export-anchors-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const cookiePath=join(root,'cookie');writeFileSync(cookiePath,'fixture:recording',{mode:0o600});
 const state={network:'regtest',tip:hash,reads:0,moving:false,anchorBlock:block,anchors:[{spaces_root:'1'.repeat(64),nums_root:'2'.repeat(64),block:{height:244,hash:block}}],calls:[] as string[]};
 const server=createServer(async(request,response)=>{const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString()) as {id:string;method:string;params:unknown[]};state.calls.push(body.method);let result:unknown;
 switch(body.method){case 'getnetworkinfo':result={version:310200};break;case 'getblockchaininfo':state.reads++;result={chain:state.network,initialblockdownload:false,headers:300,blocks:300,bestblockhash:state.moving&&state.reads>1?'f'.repeat(64):state.tip};break;case 'getmempoolinfo':result={loaded:true};break;case 'getwalletinfo':result={walletname:'sales',descriptors:true,scanning:false,lastprocessedblock:{hash:state.tip,height:300}};break;case 'getblockhash':result=state.anchorBlock;break;case 'getrootanchors':result=state.anchors;break;default:response.writeHead(500);response.end();return;}
 response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result,error:null}));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();}));const address=server.address();if(!address||typeof address==='string')throw Error('no listener');const url='http://127.0.0.1:'+address.port;
 const core=await Effect.runPromise(CoreAdapter.make({url,cookiePath,wallet:'sales',network:'regtest'}));return {state,observe:trustedRootAnchors({url,cookiePath},core),core,url,cookiePath};
}
test('O175: export configuration preserves legacy defaults and refuses untrusted origins, endpoints and overlapping paths',()=>{
 const valid=config();assert.equal(configuration(valid).certificateExport?.trustedOrigin,valid.certificateExport.trustedOrigin);
 const disabled={...valid};delete (disabled as {certificateExport?:unknown}).certificateExport;assert.equal(configuration(disabled).certificateExport,undefined);
 const legacy={...disabled,version:1};delete (legacy as {installation?:unknown}).installation;delete (legacy as {maintenanceLock?:unknown}).maintenanceLock;assert.equal(configuration(legacy).version,1);assert.throws(()=>configuration({...legacy,certificateExport:valid.certificateExport}));
 for(const patch of [{trustedOrigin:'https://attacker.example/path'},{trustedOrigin:'http://public.example'},{binary:'relative/tool'},{binary:valid.database},{directory:valid.journalDirectory},{ttlSeconds:0},{ttlSeconds:86401},{extra:true}])assert.throws(()=>configuration({...valid,certificateExport:{...valid.certificateExport,...patch}}));
 for(const url of ['https://127.0.0.1:7225','http://remote.example:7225','http://user:pass@127.0.0.1:7225','http://127.0.0.1:7225/path'])assert.throws(()=>configuration({...valid,certificateExport:{...valid.certificateExport,spaced:{...valid.certificateExport.spaced,url}}}));
 assert.throws(()=>configuration({...valid,network:'main',installation:{...valid.installation,genesis:GENESIS.main},certificateExport:{...valid.certificateExport,trustedOrigin:'http://127.0.0.1:8000'}}));
});
test('O176: independently observed anchors must remain on configured Core chain at a coherent tip',async (t)=>{
 const w=await boundary(t);assert.deepEqual(await w.observe(context),w.state.anchors);assert(w.state.calls.includes('getrootanchors'));assert(w.state.calls.includes('getblockhash'));assert(!w.state.calls.some(c=>/send|sign|create|import/.test(c)));
 w.state.anchorBlock='e'.repeat(64);await assert.rejects(w.observe(context));w.state.anchorBlock=block;w.state.moving=true;w.state.reads=0;await assert.rejects(w.observe(context));w.state.moving=false;w.state.reads=0;w.state.network='main';await assert.rejects(w.observe(context));
});
test('O177: anchor substitution, malformed sets, missing coverage and message-provided anchors fail closed',async (t)=>{
 const w=await boundary(t);const valid=structuredClone(w.state.anchors);w.state.anchors=[{...valid[0]!,block:{height:244,hash:'f'.repeat(64)}}];await assert.rejects(w.observe(context));
 w.state.anchors=[];await assert.rejects(w.observe(context));w.state.anchors=[...valid,...valid];await assert.rejects(w.observe(context));w.state.anchors=valid;await assert.rejects(w.observe({...context,height:157}));
 w.state.anchors=[{...valid[0]!,spaces_root:'not-a-root'}];await assert.rejects(w.observe({...context,anchors:valid} as typeof context));
});
