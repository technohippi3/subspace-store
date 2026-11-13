import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { fixture, invoice, setup, use } from "./application-fixture.ts";
import { recovered } from "./recovery-fixture.ts";
import { runtimeFixture } from "./runtime-fixture.ts";
import { recorded } from "./core-fixture.ts";
import { SalesStore } from "../../src/application/store.ts";
import { restoreApplication } from "../../src/application/recovery.ts";
import { DatabaseSync } from "node:sqlite";

test("O83: process death before or after normalization journal publication resumes in quarantine without duplicate history", async(t)=>{
  for(const fault of ["before","after"]){
    const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);yield* invoice(store);}));
    const config={...f.config,database:join(f.root,"restored.db")};
    const script=`
      import {Effect} from "effect";
      import {restoreApplication} from ${JSON.stringify(new URL("../../src/application/recovery.ts",import.meta.url).href)};
      import {FileJournal} from ${JSON.stringify(new URL("../../src/storage/journal.ts",import.meta.url).href)};
      const append=FileJournal.prototype.append;
      FileJournal.prototype.append=function(value){
        if(value.changes.some(c=>c.kind==="sales_settings"&&c.value.paused===true)){
          if(process.argv[2]==="after")append.call(this,value);
          process.kill(process.pid,"SIGKILL");
        }
        return append.call(this,value);
      };
      await Effect.runPromise(Effect.scoped(restoreApplication(JSON.parse(process.argv[1]))));
    `;
    const child=spawnSync(process.execPath,["--input-type=module","-e",script,JSON.stringify(config),fault],{encoding:"utf8",timeout:10000});
    assert.equal(child.signal,"SIGKILL",child.stderr);assert.equal(existsSync(config.database),true);
    await assert.rejects(Effect.runPromise(Effect.scoped(SalesStore.open(config,f.adapters))),/requires controller/);
    f.adapters.snapshot=()=>Effect.succeed({tip:f.node.tip,tipHash:"a".repeat(64),outputs:[]});
    const first=await Effect.runPromise(Effect.scoped(SalesStore.inspectRecovery(config,f.adapters)));
    const second=await Effect.runPromise(Effect.scoped(SalesStore.inspectRecovery(config,f.adapters)));
    assert.equal(first.ready,false);assert.equal(first.acknowledged,true);assert.equal(first.orders.unknown_payment_history,1);
    assert.equal(second.sequence,first.sequence);assert.equal((await recovered(config)).state.orders[0]!.status,"quoted");
  }
});
test("O84: shipped restore and recover commands exit without listeners or wallet mutation and never release controller quarantine",async(t)=>{
  const f=fixture(t), core=await runtimeFixture(t);
  f.adapters.newDestination=Effect.succeed(recorded);
  await use(f,store=>Effect.gen(function*(){yield* setup(store);yield* invoice(store);}));
  const config={...core.config,database:join(f.root,"restored.db"),journalDirectory:f.config.journalDirectory};
  const file=join(f.root,"runtime.json");writeFileSync(file,JSON.stringify(config));
  const command=async(mode?:string)=>JSON.parse((await promisify(execFile)(process.execPath,
    ["src/main.ts",...(mode?[mode]:[]),file],{timeout:10000})).stdout) as {ready:boolean;phase:string;acknowledged:boolean;chain:{hash:string}|null};
  const restore=await command("restore");assert.equal(restore.phase,"restored");assert.equal(restore.ready,false);assert.equal(core.calls.length,0);
  core.state.txids=[];
  const inspect=await command("recover");assert.equal(inspect.phase,"observed");assert.equal(inspect.ready,false);
  assert.equal(inspect.acknowledged,true);assert.equal(inspect.chain!.hash,core.state.hash);
  await assert.rejects(command());await assert.rejects(command("restore"));
  assert.equal(core.calls.some(c=>/send|sign|fund|import|createwallet|getnewaddress/.test(c.method)),false);
  for(const port of Object.values(config.listen))await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  const state=await recovered(config);assert.equal(state.status.restoreRequired,true);assert.equal(state.state.settings.paused,true);
});
test("O86: a restore with unavailable normalization journal acknowledgment exits pending and inspection resumes it once",async(t)=>{
  const f=fixture(t), core=await runtimeFixture(t);f.adapters.newDestination=Effect.succeed(recorded);
  await use(f,store=>Effect.gen(function*(){yield* setup(store);yield* invoice(store);}));
  const config={...core.config,database:join(f.root,"restored.db"),journalDirectory:f.config.journalDirectory};
  const file=join(f.root,"runtime.json");writeFileSync(file,JSON.stringify(config));
  const script=`
    import {FileJournal} from ${JSON.stringify(new URL("../../src/storage/journal.ts",import.meta.url).href)};
    FileJournal.prototype.append=function(){throw Error("simulated journal outage");};
    process.argv=[process.execPath,"main","restore",process.argv[1]];
    await import(${JSON.stringify(new URL("../../src/main.ts",import.meta.url).href)});
  `;
  const child=spawnSync(process.execPath,["--input-type=module","-e",script,file],{encoding:"utf8",timeout:10000});
  assert.equal(child.status,2,child.stderr);
  const pending=JSON.parse(child.stdout) as {acknowledged:boolean;waiting:string[]};
  assert.equal(pending.acknowledged,false);assert(pending.waiting.includes("journal_acknowledgment"));assert.equal(core.calls.length,0);
  core.state.txids=[];
  const result=await promisify(execFile)(process.execPath,["src/main.ts","recover",file],{timeout:10000});
  const resumed=JSON.parse(result.stdout) as {acknowledged:boolean;ready:boolean};assert.equal(resumed.acknowledged,true);assert.equal(resumed.ready,false);
  const state=await recovered(config);assert.equal(state.state.recovery!.required,true);assert.equal(state.status.restoreRequired,true);
});
test("O87: recovery quarantine follows the journal into an older database and live stale writers lose permissions",async(t)=>{
  const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);yield* invoice(store);}));
  const config={...f.config,database:join(f.root,"restored.db")};
  await Effect.runPromise(Effect.scoped(restoreApplication(config)));
  // Clearing only the local bit cannot remove the journaled requirement.
  const db=new DatabaseSync(config.database);try{db.exec("update store_meta set restored=0 where id=1");}finally{db.close();}
  await assert.rejects(use({...f,config},()=>Effect.void),/controller and chain reconciliation/);
  await assert.rejects(use(f,()=>Effect.void),/controller and chain reconciliation/);
  const active=fixture(t);
  await use(active,store=>Effect.gen(function*(){
    yield* setup(store);yield* invoice(store);
    yield* Effect.promise(()=>Effect.runPromise(Effect.scoped(restoreApplication({...active.config,database:join(active.root,"restored.db")}))));
    assert.equal((yield* store.registry.journal("o1")).acknowledged,false);
    const late=yield* store.request({handle:"n1@space",script_pubkey:"5120"+"2".padStart(64,"0")});
    assert.equal((yield* store.registry.journal("o1")).acknowledged,false);
    const draws=active.node.draws;assert.equal((yield* Effect.result(store.quote(late.token)))._tag,"Failure");assert.equal(active.node.draws,draws);
  }));
});
