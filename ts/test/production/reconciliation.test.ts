import {test} from "node:test";
import assert from "node:assert/strict";
import {join} from "node:path";
import {Effect} from "effect";
import {SalesStore} from "../../src/application/store.ts";
import {restoreApplication} from "../../src/application/recovery.ts";
import {fixture,setup,invoice,use} from "./application-fixture.ts";
import {certificateFixture} from "./certificate-fixture.ts";
import {recovered} from "./recovery-fixture.ts";
import {controllerFixture} from "./reconciliation-fixture.ts";

const run=<A,E>(value:Effect.Effect<A,E,import("effect").Scope.Scope>)=>Effect.runPromise(Effect.scoped(value));
test("O88: complete known recovery histories permit paused startup without another arm, certificate or financial effect",async(t)=>{
  const f=certificateFixture(t);await use(f,store=>f.prepare(store));
  const config={...f.config,database:join(f.root,"restored.db")};await run(restoreApplication(config));
  const c=controllerFixture(),before=await recovered(config),draws=f.node.draws;
  const result=await run(SalesStore.reconcileRecovery(config,f.adapters,c.controller));assert.equal(result.ready,true);assert.equal(result.sales_paused,true);
  await use({...f,config},store=>Effect.gen(function*(){
    const status=yield* store.operatorStatus();assert.equal(status.paused,true);assert.equal(status.application_recovery!.required,false);
    assert.equal((yield* store.inspectionOrder("o1")).status,"issuing");assert.equal((yield* store.inspectionOrder("o1")).price_reserve,1000);
  }));
  assert.equal(f.node.draws,draws);assert.equal(before.state.arms.length,1);
});
test("O89: omitted, changed, duplicate and foreign entry/space statements refuse with all locks retained",async(t)=>{
  for(const alter of [(s:import("../../src/application/reconciliation-records.ts").RecoveryStatement)=>{s.entries=[];},
    (s:import("../../src/application/reconciliation-records.ts").RecoveryStatement)=>{s.entries[0]!.root="9".repeat(64);},
    (s:import("../../src/application/reconciliation-records.ts").RecoveryStatement)=>{s.entries.push(s.entries[0]!);},
    (s:import("../../src/application/reconciliation-records.ts").RecoveryStatement)=>{s.spaces=[];},
    (s:import("../../src/application/reconciliation-records.ts").RecoveryStatement)=>{s.sourceSequence++;}]){
    const f=certificateFixture(t);await use(f,store=>f.prepare(store));const config={...f.config,database:join(f.root,"restored.db")};await run(restoreApplication(config));
    const c=controllerFixture();c.control.alter=alter;await assert.rejects(run(SalesStore.reconcileRecovery(config,f.adapters,c.controller)));
    const state=await recovered(config);assert.equal(state.status.restoreRequired,true);assert.equal(state.state.recovery!.required,true);assert.equal(state.state.orders[0]!.status,"issuing");
  }
});
test("O90: unknown proofs, controller journal loss and store acknowledgment loss never release the local startup latch",async(t)=>{
  for(const fault of ["verify","controller","store"]){
    const f=fixture(t);f.adapters.snapshot=()=>Effect.succeed({tip:10,tipHash:"a".repeat(64),outputs:[]});await use(f,store=>Effect.gen(function*(){yield*setup(store);yield*invoice(store);}));
    const config={...f.config,database:join(f.root,"restored.db")};await run(restoreApplication(config));const c=controllerFixture();
    if(fault==="verify")c.control.valid=false;if(fault==="controller")c.control.down=true;
    if(fault==="store")c.control.after=()=>{f.journal.down=true;};
    if(fault==="store")assert.equal((await run(SalesStore.reconcileRecovery(config,f.adapters,c.controller))).acknowledged,false);
    else await assert.rejects(run(SalesStore.reconcileRecovery(config,f.adapters,c.controller)));
    f.journal.down=false;assert.equal((await recovered(config)).status.restoreRequired,true);
    await assert.rejects(run(SalesStore.open(config,f.adapters)),/controller and chain reconciliation/);
    c.control.valid=true;c.control.down=false;c.control.after=null;
    assert.equal((await run(SalesStore.reconcileRecovery(config,f.adapters,c.controller))).ready,true);
  }
});
test("O91: a new journal restore re-quarantines a previously completed installation",async(t)=>{
  const f=fixture(t);f.adapters.snapshot=()=>Effect.succeed({tip:10,tipHash:"a".repeat(64),outputs:[]});await use(f,store=>setup(store));
  const config={...f.config,database:join(f.root,"restored.db")};await run(restoreApplication(config));const c=controllerFixture();await run(SalesStore.reconcileRecovery(config,f.adapters,c.controller));
  const next={...config,database:join(f.root,"again.db")};await run(restoreApplication(next));
  const result=await recovered(next);assert.equal(result.status.restoreRequired,true);assert.equal(result.state.recovery!.required,true);
  await assert.rejects(run(SalesStore.open(next,f.adapters)),/controller and chain reconciliation/);
});
test("O92: payment/entry inventory or chain movement during controller inspection requires a fresh proof",async(t)=>{
  const f=certificateFixture(t);await use(f,store=>f.prepare(store));const config={...f.config,database:join(f.root,"restored.db")};await run(restoreApplication(config));
  const c=controllerFixture();c.control.after=()=>{f.node.tip++;f.chain.hash="c".repeat(64);};
  await assert.rejects(run(SalesStore.reconcileRecovery(config,f.adapters,c.controller)),/inventory or tip changed/);
  assert.equal((await recovered(config)).status.restoreRequired,true);
});
