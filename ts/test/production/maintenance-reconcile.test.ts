import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { join } from 'node:path';
import { SalesStore } from '../../src/application/store.ts';
import { restoreApplication } from '../../src/application/recovery.ts';
import { fixture, setup, invoice, use } from './application-fixture.ts';
import { controllerFixture } from './reconciliation-fixture.ts';
import { recovered } from './recovery-fixture.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import { recoveryHost } from './reconciliation-host-fixture.ts';
import { recorded } from './core-fixture.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, existsSync } from 'node:fs';
import { DurableStore } from '../../src/storage/store.ts';
const run = <A,E>(value:Effect.Effect<A,E,import('effect').Scope.Scope>) => Effect.runPromise(Effect.scoped(value));
function coherent(f:ReturnType<typeof fixture>) { f.adapters.snapshot = () => Effect.succeed({tip:f.node.tip,tipHash:'a'.repeat(64),outputs:structuredClone(f.node.outputs)}); }

test('O153: normal maintenance durably closes the prior prompt and proves both components without host-loss recovery', async (t) => {
  const f=fixture(t); coherent(f); let token='';
  await use(f,store=>Effect.gen(function*(){yield* setup(store);token=(yield* invoice(store)).token;}));
  const c=controllerFixture();
  const result=await run(SalesStore.reconcileMaintenance(f.config,f.adapters,c.controller));
  assert.equal(result.ready,true);assert.equal(result.acknowledged,true);assert.equal(result.sales_paused,true);
  assert(c.control.confirms>=2);
  assert.equal(f.journal.read().some(e=>e.changes.some(r=>r.kind==='application_recovery')),false);
  await use(f,store=>Effect.gen(function*(){
    const status=yield* store.operatorStatus();assert.equal(status.paused,true);
    const view=yield* store.order(token);assert.equal(view.payment_history,'unknown');assert.equal(view.payment_request_open,false);
    assert.equal(view.hold_expires_at,900);yield* store.pause(false);assert.equal((yield* store.order(token)).payment_request_open,false);
  }));
  assert.equal(f.node.draws,1);
});
test('O153: normal maintenance refuses real restore quarantine without clearing it or publishing a controller proof', async (t) => {
  const f=fixture(t);coherent(f);await use(f,store=>setup(store));
  const config={...f.config,database:join(f.root,'restored.db')};await run(restoreApplication(config));
  const before=JSON.stringify(f.journal.read()),c=controllerFixture();
  await assert.rejects(run(SalesStore.reconcileMaintenance(config,f.adapters,c.controller)),/actual restore/);
  assert.equal(c.control.run,0);assert.equal(JSON.stringify(f.journal.read()),before);
  assert.equal((await recovered(config)).status.restoreRequired,true);
});
test('O153: normal maintenance never creates a missing database or journal identity',async (t)=>{
  const f=fixture(t),c=controllerFixture(),before=JSON.stringify(f.journal.read());
  await assert.rejects(run(SalesStore.reconcileMaintenance(f.config,f.adapters,c.controller)),/existing initialized store/);
  assert.equal(existsSync(f.config.database),false);assert.equal(JSON.stringify(f.journal.read()),before);assert.equal(c.control.run,0);
});
test('O153: empty records cannot acquire an unbound application identity during maintenance',async (t)=>{
  const f=fixture(t),c=controllerFixture();await run(DurableStore.open(f.config));
  await assert.rejects(run(SalesStore.reconcileMaintenance(f.config,f.adapters,c.controller)),/initialized application records/);
  assert.equal(f.journal.read().length,0);assert.equal(c.control.run,0);
  await use(f,store=>setup(store));assert(f.journal.read().length>0);
});
test('O153: changed tip, invalid independent proof or lost controller acknowledgment never reports ready', async (t) => {
  for(const failure of ['tip','proof','journal']){
    const f=fixture(t);coherent(f);await use(f,store=>setup(store));const c=controllerFixture();
    if(failure==='tip')c.control.after=()=>f.node.tip++;
    if(failure==='proof')c.control.valid=false;
    if(failure==='journal')c.control.down=true;
    await assert.rejects(run(SalesStore.reconcileMaintenance(f.config,f.adapters,c.controller)));
    await use(f,store=>Effect.gen(function*(){assert.equal((yield* store.operatorStatus()).paused,true);}));
    assert.equal(f.node.draws,0);
  }
});
test('O153: shipped maintain CLI proves a normal same-database host with read-only native RPCs',async (t)=>{
  const f=fixture(t),core=await runtimeFixture(t);f.adapters.newDestination=Effect.succeed(recorded);
  await use(f,store=>Effect.gen(function*(){yield* setup(store);yield* invoice(store);}));
  const config={...core.config,database:f.config.database,journalDirectory:f.config.journalDirectory};
  const host=await recoveryHost(t,core,config),file=join(f.root,'runtime.json');writeFileSync(file,JSON.stringify(config));core.state.txids=[];
  const result=JSON.parse((await promisify(execFile)(process.execPath,['src/main.ts','maintain',file,host.file],{timeout:20000})).stdout);
  assert.equal(result.ready,true);assert.equal(result.acknowledged,true);assert.equal(result.sales_paused,true);
  assert.equal(core.calls.some(c=>/send|sign|fund|import|createwallet|getnewaddress/.test(c.method)),false);
  assert.equal(f.journal.read().some(e=>e.changes.some(r=>r.kind==='application_recovery')),false);
});
