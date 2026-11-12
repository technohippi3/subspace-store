import {test,type TestContext} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,writeFileSync,existsSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {Effect} from "effect";
import {configuration,type RuntimeConfig} from "../../src/runtime/config.ts";
import {startRuntime} from "../../src/runtime/server.ts";
import {recoveryCommand} from "../../src/runtime/recovery.ts";
import {controllerRecovery} from "../../src/runtime/reconciliation.ts";
import {confirmControllerReceipt} from "../../src/runtime/remote-controller-proof.ts";
import {RecoveryCommand,SshJournal,backendReference,sameBackend,JOURNAL_PAGE_ENTRIES,JOURNAL_PAGE_BYTES} from "../../src/storage/ssh-journal.ts";
import {entry,type Entry} from "../../src/storage/codec.ts";
import {FileJournal} from "../../src/storage/journal.ts";
import {GENESIS,descriptorFingerprint} from "../../src/bitcoin/identity.ts";
import {proofHash} from "../../src/application/reconciliation-records.ts";
import {runtimeFixture} from "./runtime-fixture.ts";
import {fixture,use,setup} from "./application-fixture.ts";
const scoped=<A,E>(work:Effect.Effect<A,E,import("effect").Scope.Scope>)=>Effect.runPromise(Effect.scoped(work));
const text=(dir:string)=>readdirSync(dir).sort().map(n=>readFileSync(join(dir,n),"utf8")).join("\n");
function v2(config:RuntimeConfig):RuntimeConfig {
 const maintenanceLock=config.database+".maintenance.lock";writeFileSync(maintenanceLock,"",{mode:0o600});
 return{...config,version:2,maintenanceLock,installation:{genesis:GENESIS.regtest,descriptorHash:descriptorFingerprint({descriptors:[{desc:"tr(mock-public-expression/*)#fixture",active:true,internal:false}]})}};
}
const reference=(root:string)=>({version:1 as const,node:join(root,"missing-node"),client:join(root,"client.mjs"),config:join(root,"recovery.json")});
function python(t:TestContext,method:string){
 const p=spawnSync("python3",["-m","unittest","tests.test_recovery_backend.RecoveryBackendCases."+method],{cwd:fileURLToPath(new URL("../../../",import.meta.url)),encoding:"utf8",timeout:30000});
 t.assert.equal(p.status,0,p.stderr||p.stdout);
}
class ControlledCommand extends RecoveryCommand {
 handler:(request:Record<string,unknown>)=>unknown;
 constructor(handler:(request:Record<string,unknown>)=>unknown){super("/unused-node","/unused-client","/unused-config");this.handler=handler;}
 override request<T>(request:object):T{return this.handler(request as Record<string,unknown>) as T;}
}
function item(raw:Buffer,sequence:number){return{sequence,sha256:createHash("sha256").update(raw).digest("hex"),data:raw.toString("base64")};}

test("O154: explicit remote configuration refuses local journal fallback before listeners or recovery publication",async(t)=>{
 const f=await runtimeFixture(t);await scoped(startRuntime(f.config));const before=text(f.config.journalDirectory);
 const config={...v2(f.config),recoveryBackend:reference(f.root)};assert.deepEqual(configuration(config),config);
 for(const changed of [{...f.config,recoveryBackend:config.recoveryBackend},{...config,recoveryBackend:undefined},{...config,recoveryBackend:{...config.recoveryBackend,key:"forbidden"}},{...config,recoveryBackend:{...config.recoveryBackend,node:"relative"}}])assert.throws(()=>configuration(changed));
 await assert.rejects(scoped(startRuntime(config)),/journal|off-host|unavailable/);
 assert.equal(text(f.config.journalDirectory),before);
 for(const port of Object.values(config.listen))await assert.rejects(fetch(`http://127.0.0.1:${port}/operator/status`));
 const restored={...config,database:join(f.root,"remote-restore.db")};await assert.rejects(scoped(recoveryCommand("restore",restored)),/journal|off-host|unavailable/);assert.equal(existsSync(restored.database),false);
 assert(!f.calls.some(c=>/send|sign|newaddress/.test(c.method)));
 python(t,"test_config_is_explicit_lazy_and_has_no_local_fallback");
});

test("O155: live decrypted full prefixes and reconciliation receipt reject earlier corruption and same-count substitutions",async(t)=>{
 const f=fixture(t);await use(f,store=>setup(store,1));const entries=f.journal.read();assert(entries.length>1);
 let down=false;const command=new ControlledCommand(r=>{if(down)throw Error("offhost unavailable");return{head:entries.length,entries:entries.slice(Number(r.after)).map((e,i)=>item(Buffer.from(JSON.stringify(e)),Number(r.after)+i+1))};});
 const remote=new SshJournal(command);assert.deepEqual(remote.read(),entries);down=true;assert.throws(()=>remote.read(),/unavailable/);down=false;
 const corrupt=new ControlledCommand(()=>({head:entries.length,entries:entries.map((e,i)=>({...item(Buffer.from(JSON.stringify(e)),i+1),...(i===0?{sha256:"0".repeat(64)}:{})}))}));assert.throws(()=>new SshJournal(corrupt).read(),/digest/);
 const statement={fixture:"controller recovery"},hash=proofHash(statement);const rows=[item(Buffer.from(JSON.stringify({seq:1,kind:"batch",batch:{bid:"b1"}})),1),item(Buffer.from(JSON.stringify({seq:2,kind:"store_reconciliation",statement,proofHash:hash})),2)];
 let corruptFirst=false,head=2;const reads:number[]=[];
 const controller=new ControlledCommand(r=>{if(r.op==="journal-head")return{sequence:head,sha256:rows.at(-1)!.sha256};reads.push(Number(r.after));return{head,entries:rows.map((row,i)=>({...row,...(corruptFirst&&i===0?{sha256:"0".repeat(64)}:{})}))};});
 confirmControllerReceipt(controller,{position:2,proofHash:hash},proofHash);assert.deepEqual(reads,[0]);
 corruptFirst=true;assert.throws(()=>confirmControllerReceipt(controller,{position:2,proofHash:hash},proofHash));corruptFirst=false;head=3;assert.throws(()=>confirmControllerReceipt(controller,{position:2,proofHash:hash},proofHash));
 python(t,"test_prefixes_require_actual_remote_bytes_and_complete_batch_projection");
});

test("O156: ordinary controller checkpoint holds stopped subs until exact copied prefixes and remote snapshot acknowledgment",async(t)=>{
 python(t,"test_checkpoint_waits_for_remote_ack_and_never_promotes_failed_upload");
});

test("O157: actual runner host-loss restore requires fresh remote materialization and retains unknown-arm quarantine without sends",async(t)=>{
 python(t,"test_restore_requires_remote_materialization_and_preserves_unknown_quarantine");
});

test("O158: store-owned reconciliation requires identical explicit maintenance backend references on both sides",async(t)=>{
 const f=await runtimeFixture(t),config={...v2(f.config),recoveryBackend:reference(f.root)},file=join(f.root,"runner.json");
 const base={network:"regtest",controller:{journal_dir:f.config.journalDirectory,operator_wallet:"fixture-wallet"},spaced:{url:"http://127.0.0.1:9",cookie_file:join(f.root,"spaced-cookie")},subs:{url:"http://127.0.0.1:9"}};
 assert.deepEqual(backendReference(config.recoveryBackend),config.recoveryBackend);
 writeFileSync(file,JSON.stringify({...base,recovery_backend:config.recoveryBackend}));assert.equal(typeof controllerRecovery(config,file).run,"function");
 for(const backend of [undefined,{...config.recoveryBackend,config:join(f.root,"different-role-config")},{...config.recoveryBackend,version:2}]){
  writeFileSync(file,JSON.stringify({...base,...(backend?{recovery_backend:backend}:{})}));assert.throws(()=>controllerRecovery(config,file));
 }
 writeFileSync(file,JSON.stringify({...base,recovery_backend:config.recoveryBackend}));assert.throws(()=>controllerRecovery(f.config,file));
 assert.equal(sameBackend(config.recoveryBackend,undefined),false);assert(!f.calls.length);
});

test("O159: legacy version 1 keeps its original local journal protocol and cannot silently select a remote backend",async(t)=>{
 const f=await runtimeFixture(t);await scoped(startRuntime(f.config));const history=new FileJournal(f.config.journalDirectory).read();assert(history.length>0);
 await scoped(startRuntime(f.config));assert(new FileJournal(f.config.journalDirectory).read().length>=history.length);
 assert.throws(()=>configuration({...f.config,recoveryBackend:reference(f.root)}));
 assert.deepEqual(new FileJournal(f.config.journalDirectory).read().slice(0,history.length),history);
 assert(!f.calls.some(c=>/send|sign|newaddress/.test(c.method)));
});


test("remote journal larger pages preserve complete lineage and support earlier byte-bounded pagination",(t)=>{
 const rows:Entry[]=[];
 for(let i=0;i<JOURNAL_PAGE_ENTRIES+1;i++)rows.push(entry("00000000-0000-4000-8000-000000000001",i+1,rows.at(-1)?.hash??null,[{kind:"fixture",key:String(i),value:i}]));
 for(const pageSize of [JOURNAL_PAGE_ENTRIES,5000]){
  const positions:number[]=[];
  const command=new ControlledCommand(r=>{t.assert.equal(r.limit,JOURNAL_PAGE_ENTRIES);const after=Number(r.after);positions.push(after);return{head:rows.length,entries:rows.slice(after,after+pageSize).map((e,i)=>item(Buffer.from(JSON.stringify(e)),after+i+1))};});
  t.assert.deepEqual(new SshJournal(command).read(),rows);t.assert.deepEqual(positions,[0,pageSize]);
 }
 const statement={fixture:"final full prefix"},hash=proofHash(statement);
 const controllerRows=rows.map((_,i)=>item(Buffer.from(JSON.stringify(i===rows.length-1?{seq:i+1,kind:"store_reconciliation",statement,proofHash:hash}:{seq:i+1,kind:"fixture"})),i+1));
 const positions:number[]=[];
 const command=new ControlledCommand(r=>{if(r.op==="journal-head")return{sequence:rows.length,sha256:controllerRows.at(-1)!.sha256};t.assert.equal(r.limit,JOURNAL_PAGE_ENTRIES);const after=Number(r.after);positions.push(after);return{head:rows.length,entries:controllerRows.slice(after,after+JOURNAL_PAGE_ENTRIES)};});
 confirmControllerReceipt(command,{position:rows.length,proofHash:hash},proofHash);t.assert.deepEqual(positions,[0,JOURNAL_PAGE_ENTRIES]);
 const tooMany=new ControlledCommand(()=>({head:rows.length,entries:rows.map((e,i)=>item(Buffer.from(JSON.stringify(e)),i+1))}));
 t.assert.throws(()=>new SshJournal(tooMany).read(),/prefix/);
 t.assert.throws(()=>confirmControllerReceipt(tooMany,{position:rows.length,proofHash:hash},proofHash),/proof/);
});

test("remote journal decoded-page bounds reject an oversized valid record before accepting its prefix",(t)=>{
 const value=entry("00000000-0000-4000-8000-000000000001",1,null,[{kind:"fixture",key:"large",value:"x".repeat(JOURNAL_PAGE_BYTES)}]);
 const raw=Buffer.from(JSON.stringify(value)),command=new ControlledCommand(()=>({head:1,entries:[item(raw,1)]}));
 t.assert.throws(()=>new SshJournal(command).read(),/bounds/);
 t.assert.throws(()=>confirmControllerReceipt(command,{position:1,proofHash:"0".repeat(64)},proofHash),/proof/);
});
