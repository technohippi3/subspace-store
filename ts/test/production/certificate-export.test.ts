import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,readdirSync} from 'node:fs';
import {decode,type RefundSettings,type Record as AppRecord} from '../../src/application/records.ts';
import {Effect} from 'effect';
import {DurableStore} from '../../src/storage/store.ts';
import {FileJournal} from '../../src/storage/journal.ts';
import {SalesStore} from '../../src/application/store.ts';
import {serve} from '../../src/application/http.ts';
import {fixture,payment,type Fixture} from './application-fixture.ts';
import {NativeArtifacts,CertificateExports,ExportError,externalOrigin,digest} from '../../src/application/certificate-export.ts';
import {exportBrowserRoute} from '../../src/application/certificate-export-http.ts';
const run=<A,E>(e:Effect.Effect<A,E>)=>Effect.runPromise(e);
const base=new URL('../../../',import.meta.url).pathname;
const evidence=join(base,'regtest/evidence/combined-20261107T113909Z-345992/017-b7');
const message=readFileSync(join(evidence,'five@test10000.message.bin')),anchors=JSON.parse(readFileSync(join(evidence,'anchors.json'),'utf8')),proof=JSON.parse(readFileSync(join(evidence,'five@test10000.libveritas.json'),'utf8')) as {zones:{handle:string;script_pubkey:string;commitment_root:string;commitment_height:number}[]};
const rootZone=proof.zones.find(z=>z.handle==='@test10000')!,zone=proof.zones.find(z=>z.handle==='five@test10000')!;
const entry={entry:'1'.repeat(32),root:rootZone.commitment_root,oids:['o1']},arm={...entry,delegate:'d'.repeat(64)+':0'};
function expectedError(code:number){return (error:unknown)=>error instanceof ExportError&&error.code===code;}
interface World {f:Fixture;store:SalesStore;token:string;clock:{now:number};artifacts:NativeArtifacts;service:CertificateExports;options:ConstructorParameters<typeof CertificateExports>[0];url:string;packet:(revision?:number)=>unknown;facts:(height?:number,rootHeight?:number|null)=>{txid:string;tipHeight:number;tipHash:string;minedHeight:number;rootHeight:number|null;anchorHeight:number};reopen:()=>CertificateExports}
async function world<A>(t:TestContext,callback:(w:World)=>Promise<A>){
 const f=fixture(t);f.node.tip=4680;const tipHash=anchors[0].block.hash;
 f.adapters.snapshot=()=>Effect.succeed({tip:f.node.tip,tipHash,outputs:structuredClone(f.node.outputs)});f.adapters.certificateChain=()=>Effect.succeed(true);
 return Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const store=yield*SalesStore.open(f.config,f.adapters);yield*store.listName(zone.handle,10000);yield*store.pause(false);const link=yield*store.request({handle:zone.handle,script_pubkey:zone.script_pubkey});yield*store.quote(link.token);f.node.outputs=[payment(1,10000,3)];yield*store.observe();yield*store.registry.entries.enter(entry);yield*store.registry.entries.arm(arm);
  const facts=(height=4504,rootHeight:number|null=height)=>({txid:'a'.repeat(64),tipHeight:f.node.tip,tipHash,minedHeight:height,rootHeight,anchorHeight:4680});
  yield*store.registry.commitments.observe({...arm,expectedRevision:0,observation:facts()});
  const packet=(revision=1)=>({...arm,oid:'o1',revision,certificateRoot:rootZone.commitment_root,certificateHeight:rootZone.commitment_height,message_b64:message.toString('base64')});
  yield*store.registry.certificates.accept(packet());
  const clock={now:1000};const artifacts=new NativeArtifacts({binary:join(base,'native/export/target/release/subspace-certificate-tools'),artifactManifest:join(base,'native/export/target/native-artifact.json'),directory:join(f.root,'exports'),anchorsFor:async()=>anchors});
  const options={store,artifacts,origin:'https://certificates.example.test',clock:()=>clock.now,ttlSeconds:60};let service=new CertificateExports(options);
  const buyer=yield*serve(store,0,service);
  const server=createServer(async(req,res)=>{if(await exportBrowserRoute(service,req,res))return;const upstream=await fetch(buyer.url+req.url,{...(req.method?{method:req.method}:{}),redirect:'manual'});res.writeHead(upstream.status,Object.fromEntries(upstream.headers));res.end(Buffer.from(await upstream.arrayBuffer()));});
  yield*Effect.promise(()=>new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve)));t.after(()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();}));const address=server.address();if(!address||typeof address==='string')throw Error('no listener');const url='http://127.0.0.1:'+address.port;
  return yield*Effect.promise(()=>callback({f,store,token:link.token,clock,artifacts,get service(){return service;},options,url,packet,facts,reopen(){service=new CertificateExports(options);return service;}}));
 })));
}
function privateHeaders(response:Response){assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.match(response.headers.get('content-security-policy')!,/script-src 'none'/);assert.match(response.headers.get('content-security-policy')!,/frame-ancestors 'none'/);}

test('O160: owned native profiles preserve real initial and later certificates and expose no legacy Nacho wrapper',async (t)=>world(t,async w=>{
 const initial=join(evidence,'../001-b1'),saved=JSON.parse(readFileSync(join(initial,'one@test10000.libveritas.json'),'utf8')) as typeof proof,leaf=saved.zones.find(z=>z.handle==='one@test10000')!,root=saved.zones.find(z=>z.handle==='@test10000')!,output=join(w.f.root,'initial-native');
 const report=JSON.parse(execFileSync(w.artifacts.binary,['native',join(initial,'one@test10000.message.bin'),join(initial,'anchors.json'),leaf.handle,leaf.script_pubkey,root.commitment_root,String(root.commitment_height),output],{encoding:'utf8',timeout:10000,maxBuffer:1048576}));assert.equal(report.verified,true);assert.deepEqual(readFileSync(join(output,'roundtrip.spacemsg')),readFileSync(join(initial,'one@test10000.message.bin')));assert.equal(readFileSync(join(output,'certificate.spacecert')).subarray(0,4).toString(),'SCRT');

 const old=await fetch(w.url+'/orders/'+w.token+'/certificate');assert.deepEqual(Buffer.from(await old.arrayBuffer()),message);
 for(const profile of ['spacecert-v1','spacemsg-0.4.4']){
  const cap=await w.service.issue(w.token,profile),artifact=await w.service.download(cap.token,profile);assert.equal(artifact.mediaType,'application/octet-stream');
  if(profile==='spacecert-v1')assert.equal(artifact.bytes.subarray(0,4).toString(),'SCRT');else assert.deepEqual(artifact.bytes,message);
  const manifest=await w.service.manifest(cap.token);assert.equal(manifest.profile,profile);assert.equal(manifest.sha256,digest(artifact.bytes));assert.equal('anchor' in manifest,false);assert.equal('witness' in manifest,false);
  const response=await fetch(w.url+'/c/'+cap.token+'/'+artifact.file);privateHeaders(response);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition')!,new RegExp(artifact.file.replace('.','\\.')));assert.deepEqual(Buffer.from(await response.arrayBuffer()),artifact.bytes);
  assert.equal((await fetch(w.url+'/c/'+cap.token+'/nacho.json')).status,404);
 }
 for(const unsupported of ['legacy-nacho-32a1d','nacho','constructor','__proto__'])await assert.rejects(w.service.issue(w.token,unsupported),expectedError(404));
}));
test('O161: certificate-only capabilities cannot inspect or mutate orders and do not persist raw tokens',async (t)=>world(t,async w=>{
 const cap=await w.service.issue(w.token,'spacecert-v1');assert.notEqual(cap.token,w.token);assert.match(cap.token,/^[A-Za-z0-9_-]{43}$/);
 await assert.rejects(run(w.store.order(cap.token)));await assert.rejects(run(w.store.cancel(cap.token)));await assert.rejects(w.service.download(w.token,'spacecert-v1'),expectedError(404));
 const bytes=readFileSync(w.f.config.database);assert(!bytes.includes(Buffer.from(cap.token)));assert(!bytes.includes(Buffer.from(w.token)));
 const response=await fetch(w.url+'/c/'+cap.token+'/view');privateHeaders(response);const html=await response.text();assert.equal(response.status,200);assert(!html.includes(w.token));assert(!html.includes('Cancel order'));assert.match(html,/<svg/);assert.doesNotMatch(html,/<script|https?:\/\/[^\s"<]*\/o\//);
}));
test('O162: capability expiry, revocation, rotation and restart preserve read-only scope',async (t)=>world(t,async w=>{
 const first=await w.service.issue(w.token,'spacecert-v1');w.reopen();assert((await w.service.download(first.token,'spacecert-v1')).bytes.length>0);
 const second=await w.service.issue(w.token,'spacecert-v1');await assert.rejects(w.service.download(first.token,'spacecert-v1'),expectedError(404));assert.equal((await run(w.store.readCertificateCapabilities())).grants.length,1);
 await w.service.revoke(w.token,second.token);await assert.rejects(w.service.download(second.token,'spacecert-v1'),expectedError(404));
 const third=await w.service.issue(w.token,'spacemsg-0.4.4');w.clock.now=1055;await w.service.download(third.token,'spacemsg-0.4.4');w.clock.now=1054;await assert.rejects(w.service.manifest(third.token),expectedError(503));w.clock.now=1060;await assert.rejects(w.service.download(third.token,'spacemsg-0.4.4'),expectedError(404));w.reopen();await assert.rejects(w.service.download(third.token,'spacemsg-0.4.4'),expectedError(404));w.clock.now=1054;await assert.rejects(w.service.manifest(third.token),expectedError(404));
}));
test('O163: finality loss withdraws current exports and a new verification revision never revives an old URL',async (t)=>world(t,async w=>{
 const cap=await w.service.issue(w.token,'spacecert-v1');await run(w.store.registry.commitments.observe({...arm,expectedRevision:1,observation:w.facts(4504,null)}));
 await assert.rejects(w.service.download(cap.token,'spacecert-v1'),expectedError(404));assert.equal((await fetch(w.url+'/c/'+cap.token+'/manifest.json')).status,404);assert.equal((await fetch(w.url+'/c/'+cap.token+'/qr.svg')).status,404);
 await run(w.store.registry.commitments.observe({...arm,expectedRevision:2,observation:w.facts()}));await run(w.store.registry.certificates.accept(w.packet(3)));await assert.rejects(w.service.download(cap.token,'spacecert-v1'),expectedError(404));
 const fresh=await w.service.issue(w.token,'spacecert-v1');assert((await w.service.download(fresh.token,'spacecert-v1')).bytes.length>0);
}));
test('O164: configured trusted origin controls QR URLs despite malicious Host and forwarding headers',async (t)=>world(t,async w=>{
 const cap=await w.service.issue(w.token,'spacemsg-0.4.4');const response=await fetch(w.url+'/c/'+cap.token+'/manifest.json',{headers:{Host:'attacker.example','X-Forwarded-Host':'attacker.example','X-Forwarded-Proto':'http',Forwarded:'host=attacker.example;proto=http'}});privateHeaders(response);const manifest=await response.json() as {url:string};assert.equal(manifest.url,'https://certificates.example.test/c/'+cap.token+'/certificate.spacemsg');assert(!JSON.stringify(manifest).includes(w.token));
 const qr=await w.service.qr(cap.token);assert.match(qr,/<svg/);assert.doesNotMatch(qr,/<script|<image|href=|attacker.example/);
 for(const origin of ['', 'http://public.example','https://user:pass@example.test','https://example.test/path','https://example.test/?x=1','https://example.test/#fragment','javascript:alert(1)'])assert.throws(()=>externalOrigin(origin),expectedError(503));
 assert.equal(externalOrigin('http://127.0.0.1:1234',{allowLoopbackHttp:true}),'http://127.0.0.1:1234');
}));
test('O165: browser form creates a bounded certificate-only QR view while preserving the binary order route',async (t)=>world(t,async w=>{
 const order=await fetch(w.url+'/o/'+w.token);assert.match(await order.text(),/id="native-exports"/);
 const choose=await fetch(w.url+'/o/'+w.token+'/exports');assert.equal(choose.status,200);privateHeaders(choose);
 const created=await fetch(w.url+'/o/'+w.token+'/exports',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'profile=spacecert-v1'});assert.equal(created.status,303);privateHeaders(created);assert.match(created.headers.get('location')!,/^\/c\/[A-Za-z0-9_-]{43}\/view$/);
 const view=await fetch(w.url+created.headers.get('location')!);assert.equal(view.status,200);assert(!((await view.text()).includes(w.token)));
 const oversized=await fetch(w.url+'/o/'+w.token+'/exports',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'x'.repeat(65537)});assert.equal(oversized.status,400);privateHeaders(oversized);
 const old=await fetch(w.url+'/orders/'+w.token+'/certificate');assert.deepEqual(Buffer.from(await old.arrayBuffer()),message);
}));

test('O166: native proof, recipient, root and anchor mismatches cannot mint a capability',async (t)=>world(t,async w=>{
 const context=await run(w.store.certificateExportContext(w.token));
 for(const changes of [{recipient:'5120'+'00'.repeat(32)},{root:'00'.repeat(32)},{height:context.height+1},{handle:'absent@test10000'}])await assert.rejects(w.artifacts.artifact({...context,...changes},'spacecert-v1'),expectedError(503));
 const wrong=structuredClone(anchors);for(const a of wrong){a.spaces_root='00'.repeat(32);a.nums_root='00'.repeat(32);}w.artifacts.anchorsFor=async()=>wrong;
 await assert.rejects(w.service.issue(w.token,'spacecert-v1'),expectedError(503));assert.equal((await run(w.store.readCertificateCapabilities())).grants.length,0);
}));
test('O167: corrupted cache bytes and forged matching metadata are never served and can be reconstructed',async (t)=>world(t,async w=>{
 const cap=await w.service.issue(w.token,'spacecert-v1'),original=(await w.service.download(cap.token,'spacecert-v1')).bytes,context=await run(w.store.certificateExportContext(w.token));
 const key=digest(Buffer.from(JSON.stringify([context.oid,context.entry,context.revision,context.hash,context.root,context.height,context.recipient,context.handle]))),dir=join(w.artifacts.directory,key);
 const forge=()=>{const path=join(dir,'certificate.spacecert'),stamp=join(dir,'export.json'),record=JSON.parse(readFileSync(stamp,'utf8')),bytes=Buffer.from('SCRT forged bytes');writeFileSync(path,bytes);record.profiles['spacecert-v1']={hash:digest(bytes),length:bytes.length};writeFileSync(stamp,JSON.stringify(record));};forge();
 const wrong=structuredClone(anchors);for(const a of wrong){a.spaces_root='00'.repeat(32);a.nums_root='00'.repeat(32);}w.artifacts.anchorsFor=async()=>wrong;
 await assert.rejects(w.service.download(cap.token,'spacecert-v1'),expectedError(503));w.artifacts.anchorsFor=async()=>anchors;assert.deepEqual((await w.service.download(cap.token,'spacecert-v1')).bytes,original);
 forge();const restarted=new NativeArtifacts({binary:w.artifacts.binary,artifactManifest:w.artifacts.artifactManifest,directory:w.artifacts.directory,anchorsFor:async()=>anchors});w.service.artifacts=restarted;
 assert.deepEqual((await w.service.download(cap.token,'spacecert-v1')).bytes,original);assert.equal((await w.service.manifest(cap.token)).sha256,digest(original));
}));
test('O168: pinned executable manifest rejects missing or substituted native binaries',async (t)=>world(t,async w=>{
 const copied=join(w.f.root,'tool');copyFileSync(w.artifacts.binary,copied);writeFileSync(copied,Buffer.from('untrusted executable'));
 const opts={binary:copied,artifactManifest:w.artifacts.artifactManifest,directory:join(w.f.root,'bad-export'),anchorsFor:async()=>anchors};assert.throws(()=>new NativeArtifacts(opts),expectedError(503));
 assert.throws(()=>new NativeArtifacts({...opts,binary:join(w.f.root,'missing')}),expectedError(503));
 const bad=join(w.f.root,'manifest.json');writeFileSync(bad,JSON.stringify({...JSON.parse(readFileSync(w.artifacts.artifactManifest,'utf8')),library:'libveritas-0.4.5'}));assert.throws(()=>new NativeArtifacts({...opts,binary:w.artifacts.binary,artifactManifest:bad}),expectedError(503));
}));
test('O169: lost journal acknowledgement hides original and scoped certificate endpoints',async (t)=>world(t,async w=>{
 const cap=await w.service.issue(w.token,'spacecert-v1');w.f.journal.down=true;
 for(const path of ['/orders/'+w.token+'/certificate','/c/'+cap.token+'/certificate.spacecert','/c/'+cap.token+'/manifest.json','/c/'+cap.token+'/qr.svg','/c/'+cap.token+'/view']){const response=await fetch(w.url+path);assert.notEqual(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');if(path.startsWith('/c/'))privateHeaders(response);assert(!Buffer.from(await response.arrayBuffer()).includes(message));}
 await assert.rejects(w.service.issue(w.token,'spacecert-v1'),expectedError(404));
}));
test('O170: malformed capability records fail the real strict application decoder without a SQL migration',async (t)=>world(t,async w=>{
 const cap=await w.service.issue(w.token,'spacecert-v1'),db=new DatabaseSync(w.f.config.database,{readOnly:true});let rows:AppRecord[];try{rows=db.prepare('SELECT kind,key,value FROM records').all().map(r=>({kind:String(r.kind),key:String(r.key),value:JSON.parse(String(r.value))}));}finally{db.close();}
 for(const change of [{version:2},{last:-1},{extra:true},{grants:[{hash:digest(cap.token),oid:'o999',binding:'x',profile:'nacho',artifactHash:'0'.repeat(64),expires:1060,revoked:false}]}]){const bad=structuredClone(rows),record=bad.find(r=>r.kind==='certificate_capabilities')!;Object.assign(record.value as object,change);assert.throws(()=>decode(bad,w.f.config.riskBudgetSats,{version:1,policy:w.f.config.refundPolicy,merchantDestinations:[]}));}
 assert((await w.service.download(cap.token,'spacecert-v1')).bytes.length>0);
}));
test('O171: strict forms and scoped routes reject malformed bodies, profile confusion and order mutation',async (t)=>world(t,async w=>{
 const cap=await w.service.issue(w.token,'spacecert-v1');assert.equal((await fetch(w.url+'/c/'+cap.token+'/certificate.spacemsg')).status,404);
 for(const value of ['profile=nacho','profile=spacecert-v1&profile=spacemsg-0.4.4','profile=spacecert-v1&extra=1',Buffer.from([0xff])]){const response=await fetch(w.url+'/o/'+w.token+'/exports',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:value});assert.equal(response.status,400);privateHeaders(response);}
 for(const action of ['/o/'+cap.token+'/exports','/o/'+cap.token+'/cancel','/o/'+cap.token+'/refund-address','/c/'+cap.token+'/cancel']){const response=await fetch(w.url+action,{method:'POST'});assert.notEqual(response.status,200);assert.notEqual(response.status,303);}
 assert.equal((await run(w.store.order(w.token))).status,'ready');
}));
test('O172: readiness loss or revocation during native export is rechecked before publication',async (t)=>world(t,async w=>{
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),blocked=new Promise<void>(resolve=>release=resolve);
 w.artifacts.anchorsFor=async()=>{entered();await blocked;return anchors;};
 const pending=w.service.issue(w.token,'spacecert-v1');await started;await run(w.store.registry.commitments.observe({...arm,expectedRevision:1,observation:w.facts(4504,null)}));release();await assert.rejects(pending,expectedError(404));assert.equal((await run(w.store.readCertificateCapabilities())).grants.length,0);
 await run(w.store.registry.commitments.observe({...arm,expectedRevision:2,observation:w.facts()}));await run(w.store.registry.certificates.accept(w.packet(3)));w.artifacts.anchorsFor=async()=>anchors;
 const cap=await w.service.issue(w.token,'spacecert-v1');let enteredAgain!:()=>void,releaseAgain!:()=>void;const startedAgain=new Promise<void>(resolve=>enteredAgain=resolve),blockedAgain=new Promise<void>(resolve=>releaseAgain=resolve);
 w.service.artifacts=new NativeArtifacts({binary:w.artifacts.binary,artifactManifest:w.artifacts.artifactManifest,directory:join(w.f.root,'new-cache'),anchorsFor:async()=>{enteredAgain();await blockedAgain;return anchors;}});
 const download=w.service.download(cap.token,'spacecert-v1');await startedAgain;await w.service.revoke(w.token,cap.token);releaseAgain();await assert.rejects(download,expectedError(404));
}));

test('O173: primary-journal outage never acknowledges creation, rotation or revocation',async (t)=>world(t,async w=>{
 const first=await w.service.issue(w.token,'spacecert-v1');w.f.journal.down=true;
 await assert.rejects(w.service.issue(w.token,'spacecert-v1'));await assert.rejects(w.service.revoke(w.token,first.token));await assert.rejects(w.service.download(first.token,'spacecert-v1'));
 w.f.journal.down=false;assert((await w.service.download(first.token,'spacecert-v1')).bytes.length>0);
 const append=w.f.journal.append.bind(w.f.journal);let fail=true;w.f.journal.append=value=>{if(fail)throw Error('append unavailable');return append(value);};
 await assert.rejects(w.service.issue(w.token,'spacecert-v1'),expectedError(503));await assert.rejects(w.service.download(first.token,'spacecert-v1'),expectedError(503));fail=false;w.f.node.now++;await run(w.store.observe());await assert.rejects(w.service.download(first.token,'spacecert-v1'),expectedError(404));
 const cap=await w.service.issue(w.token,'spacecert-v1');fail=true;await assert.rejects(w.service.issue(w.token,'spacemsg-0.4.4'),expectedError(503));await assert.rejects(w.service.download(cap.token,'spacecert-v1'),expectedError(503));fail=false;w.f.node.now++;await run(w.store.observe());assert((await w.service.download(cap.token,'spacecert-v1')).bytes.length>0);
 fail=true;await assert.rejects(w.service.revoke(w.token,cap.token),expectedError(503));await assert.rejects(w.service.download(cap.token,'spacecert-v1'),expectedError(503));fail=false;w.f.node.now++;await run(w.store.observe());await assert.rejects(w.service.download(cap.token,'spacecert-v1'),expectedError(404));assert.equal((await run(w.store.readCertificateCapabilities())).grants.find(g=>g.hash===digest(cap.token))!.revoked,true);
}));
test('O174: acknowledged revocation survives journal-only host-loss replay and remains quarantined until application recovery',async (t)=>{
 const saved=await world(t,async w=>{const cap=await w.service.issue(w.token,'spacecert-v1');assert.deepEqual(await w.service.revoke(w.token,cap.token),{revoked:true});await assert.rejects(w.service.download(cap.token,'spacecert-v1'),expectedError(404));return {f:w.f,cap};});
 const recovery=join(saved.f.root,'new-host');mkdirSync(recovery);const journalDirectory=join(recovery,'journal');mkdirSync(journalDirectory);for(const name of readdirSync(saved.f.config.journalDirectory))copyFileSync(join(saved.f.config.journalDirectory,name),join(journalDirectory,name));
 const config={...saved.f.config,database:join(recovery,'store.db'),journalDirectory,makeJournal:()=>new FileJournal(journalDirectory)};
 await run(Effect.scoped(Effect.gen(function*(){const restored=yield*DurableStore.open({...config,restore:true,validateRestore:records=>{decode(records,config.riskBudgetSats,records.find(r=>r.kind==="refund_settings")!.value as unknown as RefundSettings);}});const records=yield*restored.records();const ledger=records.find(r=>r.kind==='certificate_capabilities')!.value as unknown as import('../../src/application/export-records.ts').CapabilityLedger;assert.equal(ledger.grants.length,1);assert.equal(ledger.grants[0]!.hash,digest(saved.cap.token));assert.equal(ledger.grants[0]!.revoked,true);assert.equal((yield*restored.status()).restoreRequired,true);})));await assert.rejects(run(Effect.scoped(SalesStore.open(config,saved.f.adapters))));
});

test('O178: the private-order browser can durably revoke every certificate-only URL',async (t)=>world(t,async w=>{
 const first=await w.service.issue(w.token,'spacecert-v1'),second=await w.service.issue(w.token,'spacemsg-0.4.4');
 const response=await fetch(w.url+'/o/'+w.token+'/exports',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'action=revoke'});assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/o/'+w.token+'/exports');privateHeaders(response);
 for(const cap of [first,second])await assert.rejects(w.service.download(cap.token,cap.profile),expectedError(404));w.reopen();await assert.rejects(w.service.manifest(first.token),expectedError(404));
 const current=await w.service.issue(w.token,'spacecert-v1');const append=w.f.journal.append.bind(w.f.journal);let fail=true;w.f.journal.append=e=>{if(fail)throw Error('append unavailable');return append(e);};
 const pending=await fetch(w.url+'/o/'+w.token+'/exports',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'action=revoke'});assert.equal(pending.status,503);assert.equal(pending.headers.get('location'),null);fail=false;w.f.node.now++;await run(w.store.observe());await assert.rejects(w.service.download(current.token,'spacecert-v1'),expectedError(404));
}));

test("O179: unknown and retired capability reads never advance the primary journal",async (t)=>world(t,async w=>{
 const sequence=()=>{const db=new DatabaseSync(w.f.config.database,{readOnly:true});try{return db.prepare('SELECT max(seq) AS seq FROM outbox').get()!.seq;}finally{db.close();}};
 const unchanged=async(token:string)=>{const before=sequence(),history=JSON.stringify(w.f.journal.read());for(const path of ['manifest.json','certificate.spacecert','qr.svg','view'])assert.equal((await fetch(w.url+'/c/'+token+'/'+path)).status,404);assert.equal(sequence(),before);assert.equal(JSON.stringify(w.f.journal.read()),history);};
 w.clock.now=1100;await unchanged('x'.repeat(43));const revoked=await w.service.issue(w.token,'spacecert-v1');await w.service.revoke(w.token,revoked.token);w.clock.now=1101;await unchanged(revoked.token);
 const expired=await w.service.issue(w.token,'spacecert-v1');w.clock.now=1161;const firstExpiry=sequence();await assert.rejects(w.service.download(expired.token,'spacecert-v1'),expectedError(404));assert.equal(sequence(),Number(firstExpiry)+1);await unchanged(expired.token);const before=sequence();await unchanged('y'.repeat(43));assert.equal(sequence(),before);
}));
test("O162: observed expiry never revives after a smaller backward clock step or service restart", async (t) => world(t, async w => {
  const cap = await w.service.issue(w.token, "spacecert-v1");
  w.clock.now = 1055; await w.service.download(cap.token, "spacecert-v1");
  w.clock.now = 1060; await assert.rejects(w.service.download(cap.token, "spacecert-v1"), expectedError(404));
  w.clock.now = 1059; await assert.rejects(w.service.download(cap.token, "spacecert-v1"), expectedError(404));
  w.reopen(); await assert.rejects(w.service.manifest(cap.token), expectedError(404));
}));

test("O173: expiry requires acknowledgment and journal-only replay retains its retirement", async (t) => {
 const saved = await world(t, async w => {
  const cap = await w.service.issue(w.token, "spacecert-v1");
  const append = w.f.journal.append.bind(w.f.journal); let down = true;
  w.f.journal.append = value => { if (down) throw Error("append unavailable"); return append(value); };
  w.clock.now = cap.expires; await assert.rejects(w.service.download(cap.token, cap.profile), expectedError(503));
  w.clock.now--; await assert.rejects(w.service.download(cap.token, cap.profile), expectedError(503));
  down = false; w.f.node.now++; await run(w.store.observe());
  await assert.rejects(w.service.download(cap.token, cap.profile), expectedError(404));
  return { f: w.f, cap };
 });
 const config = { ...saved.f.config, database: join(saved.f.root, "expired-restored.db") };
 await run(Effect.scoped(Effect.gen(function* () {
  const restored = yield* DurableStore.open({ ...config, restore: true });
  const rows = yield* restored.records();
  const ledger = rows.find(row => row.kind === "certificate_capabilities")!.value as unknown as import('../../src/application/export-records.ts').CapabilityLedger;
  assert.equal(ledger.last, saved.cap.expires); assert.equal(ledger.grants[0]!.revoked, true);
 })));
});
