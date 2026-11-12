import {test} from "node:test";
import assert from "node:assert/strict";
import {execFile,spawn} from "node:child_process";
import {promisify} from "node:util";
import {once} from "node:events";
import {join} from "node:path";
import {writeFileSync,appendFileSync,unlinkSync} from "node:fs";
import {Effect} from "effect";
import {runtimeFixture,until} from "./runtime-fixture.ts";
import {fixture,setup,invoice,use} from "./application-fixture.ts";
import {recorded} from "./core-fixture.ts";
import {recoveryHost} from "./reconciliation-host-fixture.ts";
import {controllerRecovery} from "../../src/runtime/reconciliation.ts";
import {proofHash,type ControllerReceipt} from "../../src/application/reconciliation-records.ts";

test("O93: shipped offline reconciliation completes one controller proof and starts only a paused normal runtime",async(t)=>{
  const f=fixture(t),core=await runtimeFixture(t);f.adapters.newDestination=Effect.succeed(recorded);
  await use(f,store=>Effect.gen(function*(){yield*setup(store);yield*invoice(store);}));
  const config={...core.config,database:join(f.root,"restored.db"),journalDirectory:f.config.journalDirectory};
  const host=await recoveryHost(t,core,config),file=join(f.root,"runtime.json");writeFileSync(file,JSON.stringify(config));core.state.txids=[];
  const command=async(mode:string)=>JSON.parse((await promisify(execFile)(process.execPath,["src/main.ts",mode,file,...(mode==="reconcile"?[host.file]:[])],{timeout:20000})).stdout) as {ready:boolean;acknowledged:boolean;sales_paused:boolean};
  await command("restore");const result=await command("reconcile");assert.equal(result.ready,true);assert.equal(result.acknowledged,true);assert.equal(result.sales_paused,true);
  let output="";const child=spawn(process.execPath,["src/main.ts",file],{stdio:["ignore","pipe","pipe"]});child.stdout.on("data",data=>{output+=String(data);});
  try{await until(async()=>{assert.match(output,/"event":"ready"/);});
    const response=await core.api(`http://127.0.0.1:${config.listen.operator}`,"/operator/status",core.operator);
    assert.equal(response.value.paused,true);assert.equal((response.value.application_recovery as {required:boolean}).required,false);
    assert.equal(core.calls.some(c=>/send|sign|fund|import|createwallet|getnewaddress/.test(c.method)),false);
  }finally{if(child.exitCode===null){const ended=once(child,"exit");child.kill("SIGTERM");assert.equal((await ended)[0],0);}}
});
test("O95: recovery independently verifies exact Core transactions, operator-wallet history and fresh Spaces/subs roots",async(t)=>{
  const core=await runtimeFixture(t),h=await recoveryHost(t,core,core.config);core.state.conf=11;
  h.state.root=h.state.chainRoot="a".repeat(64);h.state.txid="c".repeat(64);h.state.walletIds=[h.state.txid];
  const statement={version:1 as const,store:"11111111-1111-1111-1111-111111111111",sourceSequence:1,sequence:2,tipHeight:100,tipHash:core.state.hash,
    entries:[{entry:"1".repeat(32),root:"a".repeat(64),space:"@space",oids:["o1"],delegate:"d".repeat(64)+":0",mode:"observed" as const,walletTxid:h.state.txid,
      observation:{txid:h.state.txid,tipHeight:100,tipHash:core.state.hash,minedHeight:90,rootHeight:90,anchorHeight:100}}],
    spaces:[{space:"@space",subsRoot:h.state.root,chainRoot:h.state.chainRoot,subsTxid:h.state.txid,ahead:null}]};
  const receipt:ControllerReceipt={statement,position:1,proofHash:proofHash(statement)},verify=controllerRecovery(core.config,h.file).verify;
  await Effect.runPromise(verify(receipt));
  for(const key of ["input","txRoot","transactionId"] as const){const saved=h.state[key];h.state[key]="9".repeat(64);await assert.rejects(Effect.runPromise(verify(receipt)));h.state[key]=saved;}
  h.state.walletIds=[];await assert.rejects(Effect.runPromise(verify(receipt)));h.state.walletIds=[h.state.txid];
  h.state.walletTip--;await assert.rejects(Effect.runPromise(verify(receipt)));h.state.walletTip++;
  h.state.chainRoot="9".repeat(64);await assert.rejects(Effect.runPromise(verify(receipt)));h.state.chainRoot=h.state.root;
  h.state.root="8".repeat(64);await assert.rejects(Effect.runPromise(verify(receipt)));
  assert.equal(core.calls.some(c=>/send|sign|fund|import|createwallet|getnewaddress/.test(c.method)),false);
});
test("O96: controller completion requires the exact latest live journal record and matching canonical digest",async(t)=>{
  const core=await runtimeFixture(t),h=await recoveryHost(t,core,core.config);
  const statement={version:1 as const,store:"11111111-1111-1111-1111-111111111111",sourceSequence:1,sequence:2,
    tipHeight:100,tipHash:core.state.hash,entries:[],spaces:[]};
  const receipt:ControllerReceipt={statement,position:1,proofHash:proofHash(statement)},file=join(h.journal,"runner.jsonl"),down=join(h.journal,"runner.down");
  const row={seq:1,kind:"store_reconciliation",...receipt};delete (row as {position?:number}).position;
  const reset=()=>writeFileSync(file,JSON.stringify(row)+"\n");
  const confirm=()=>Effect.runPromise(controllerRecovery(core.config,h.file).confirm(receipt));
  reset();await confirm();
  writeFileSync(down,"");await assert.rejects(confirm());unlinkSync(down);
  appendFileSync(file,JSON.stringify({seq:2,kind:"another-controller-write"})+"\n");await assert.rejects(confirm());
  reset();writeFileSync(file,JSON.stringify({...row,statement:{...statement,store:"foreign-store"}})+"\n");await assert.rejects(confirm());
  writeFileSync(file,"");await assert.rejects(confirm());
  reset();await confirm();
});
