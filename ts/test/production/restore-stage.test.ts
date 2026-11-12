import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {chmodSync,copyFileSync,existsSync,linkSync,lstatSync,mkdirSync,readFileSync,readdirSync,symlinkSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {Effect} from "effect";
import {DurableStore} from "../../src/storage/store.ts";
import {FileJournal} from "../../src/storage/journal.ts";
import {entry,type Change} from "../../src/storage/codec.ts";
import {SalesStore} from "../../src/application/store.ts";
import {restoreApplication} from "../../src/application/recovery.ts";
import {fixture,invoice,setup,use} from "./application-fixture.ts";
import {sendingFixture,settledRefund} from "./refund-sending-fixture.ts";
const run=<A,E>(work:Effect.Effect<A,E,import("effect").Scope.Scope>)=>Effect.runPromise(Effect.scoped(work));
function journalBytes(directory:string){return readdirSync(directory).sort().map(name=>[name,readFileSync(join(directory,name)).toString("hex")]);}

test("H5: malformed journal restores clean up only newly owned stages while ambiguous stages remain unchanged and killed valid replay resumes",async(t)=>{
 const f=sendingFixture(t);await use(f,store=>Effect.promise(()=>settledRefund(store,f)));
 const records=await run(Effect.gen(function*(){return yield*(yield*DurableStore.open(f.config)).records();}));
 for(const bad of ["empty","unknown-kind","unknown-field","no-link","orphan-order","orphan-refund"]){
  const directory=join(f.root,"bad-"+bad);mkdirSync(directory);const journal=new FileJournal(directory);const changes=structuredClone(records) as {-readonly [K in keyof Change]:Change[K]}[];
  if(bad==="unknown-kind")changes.push({kind:"alien",key:"one",value:{}});
  if(bad==="unknown-field"){const row=changes.find(r=>r.kind==="listing")!;row.value={...(row.value as object),extra:true};}
  if(bad==="no-link"){const row=changes.find(r=>r.kind==="sales_order")!;delete(row.value as {[key:string]:unknown}).tokenHash;}
  if(bad==="orphan-order")changes.splice(changes.findIndex(r=>r.kind==="listing"&&r.key==="n0@space"),1);
  if(bad==="orphan-refund"){const row=changes.find(r=>r.kind==="refund_group")!;row.value={...(row.value as object),order:"o999"};}
  if(bad!=="empty")journal.append(entry(f.journal.read()[0]!.store,1,null,changes));
  const config={...f.config,database:join(f.root,"bad-target-"+bad+".db"),journalDirectory:directory,makeJournal:()=>journal};const before=journalBytes(directory);
  await assert.rejects(run(restoreApplication(config)),error=>{assert.match(String(error),/journal|application record|stored fields|order relationship|refund|account/);return true;},bad);
  assert.equal(existsSync(config.database),false,bad);assert.equal(existsSync(config.database+".restoring"),false,bad);
  for(const suffix of ["-wal","-shm","-journal"]){assert.equal(existsSync(config.database+suffix),false,bad);assert.equal(existsSync(config.database+".restoring"+suffix),false,bad);}
  assert.deepEqual(journalBytes(directory),before,bad);
 }
 for(const suffix of ["", "-wal", "-shm", "-journal"]){
  const target={...f.config,database:join(f.root,"dangling-target-"+(suffix||"base")+".db")};
  symlinkSync(join(f.root,"missing-target"),target.database+suffix);const history=journalBytes(f.config.journalDirectory);
  await assert.rejects(run(restoreApplication(target)),/never overwrites/);assert.equal(lstatSync(target.database+suffix).isSymbolicLink(),true);assert.equal(existsSync(target.database+".restoring"),false);assert.deepEqual(journalBytes(f.config.journalDirectory),history);
 }
 // Even foreign WAL/SHM bytes are inspected only through a private copy.
 {
  const target={...f.config,database:join(f.root,"foreign-wal-target.db")},foreign=join(f.root,"foreign-wal.db"),stage=target.database+".restoring";
  const db=new DatabaseSync(foreign);db.exec("pragma journal_mode=wal;create table preserve_wal(value text);insert into preserve_wal values('foreign')");
  try{for(const suffix of ["","-wal","-shm"])copyFileSync(foreign+suffix,stage+suffix);}finally{db.close();}
  const before=["","-wal","-shm"].map(suffix=>({suffix,bytes:readFileSync(stage+suffix),stat:lstatSync(stage+suffix)}));
  await assert.rejects(run(restoreApplication(target)),/unrecognized restore working schema/);assert.equal(existsSync(target.database),false);
  for(const row of before){assert.deepEqual(readFileSync(stage+row.suffix),row.bytes);const stat=lstatSync(stage+row.suffix);assert.equal(stat.ino,row.stat.ino);assert.equal(stat.mode,row.stat.mode);assert.equal(stat.mtimeMs,row.stat.mtimeMs);}
 }
 for(const bad of ["symlink","hardlink","foreign-sqlite","writable","corrupt"]){
  const target={...f.config,database:join(f.root,"stage-"+bad+".db")},stage=target.database+".restoring",foreign=join(f.root,"foreign-"+bad+".db");
  if(bad==="corrupt")writeFileSync(foreign,"ambiguous recovery evidence",{mode:0o640});
  else {const db=new DatabaseSync(foreign);db.exec("create table owner_evidence(value text);insert into owner_evidence values('preserve')");db.close();chmodSync(foreign,0o640);}
  if(bad==="symlink")symlinkSync(foreign,stage);else if(bad==="hardlink")linkSync(foreign,stage);else copyFileSync(foreign,stage);
  if(bad==="writable")chmodSync(stage,0o666);
  const before=readFileSync(foreign),mode=lstatSync(foreign).mode,stageBytes=bad==="symlink"?null:readFileSync(stage),history=journalBytes(f.config.journalDirectory);
  await assert.rejects(run(restoreApplication(target)));assert.equal(existsSync(target.database),false);assert.deepEqual(readFileSync(foreign),before);assert.equal(lstatSync(foreign).mode,mode);
  if(stageBytes)assert.deepEqual(readFileSync(stage),stageBytes);assert.deepEqual(journalBytes(f.config.journalDirectory),history);
 }
 for(const fault of ["during-replay","before-publication"]){
  const source=fixture(t);await use(source,store=>Effect.gen(function*(){yield*setup(store,2);yield*invoice(store);}));
  const config={...source.config,database:join(source.root,"interrupted.db")};const history=journalBytes(config.journalDirectory);
  const script=`import {Effect} from "effect";
import {DurableStore} from ${JSON.stringify(new URL("../../src/storage/store.ts",import.meta.url).href)};
import {restoreApplication} from ${JSON.stringify(new URL("../../src/application/recovery.ts",import.meta.url).href)};
const fault=process.argv[2];
if(fault==="during-replay"){const put=DurableStore.prototype.put;DurableStore.prototype.put=function(value){put.call(this,value);if(value.seq===2)process.kill(process.pid,"SIGKILL");};}
else {const flush=DurableStore.prototype.flushSync;let calls=0;DurableStore.prototype.flushSync=function(){const value=flush.call(this);if(++calls===1)process.kill(process.pid,"SIGKILL");return value;};}
await Effect.runPromise(Effect.scoped(restoreApplication(JSON.parse(process.argv[1]))));`;
  const child=spawnSync(process.execPath,["--input-type=module","-e",script,JSON.stringify(config),fault],{encoding:"utf8",timeout:10000});
  assert.equal(child.signal,"SIGKILL",child.stderr);assert.equal(existsSync(config.database),false);assert.equal(existsSync(config.database+".restoring"),true);assert.deepEqual(journalBytes(config.journalDirectory),history);
  await assert.rejects(run(SalesStore.open(config,source.adapters)),/restore required/);assert.equal(existsSync(config.database),false);
  const receipt=await run(restoreApplication(config));assert.equal(receipt.acknowledged,true);assert.equal(receipt.orders.total,1);assert.equal(receipt.sales_paused,true);assert.equal(existsSync(config.database+".restoring"),false);
  await assert.rejects(run(SalesStore.open(config,source.adapters)),/requires controller/);
 }
});
