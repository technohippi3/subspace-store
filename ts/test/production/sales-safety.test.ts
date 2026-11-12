import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Effect } from 'effect';
import { SalesStore } from '../../src/application/store.ts';
import { restoreApplication } from '../../src/application/recovery.ts';
import { fixture, invoice, payment, script, setup, use, type Fixture } from './application-fixture.ts';
import { sendingFixture, settledRefund } from './refund-sending-fixture.ts';
import { familyFixture, mine } from './refund-families-fixture.ts';
import { certificateFixture } from './certificate-fixture.ts';
import { armed } from './commitment-fixture.ts';
import { changeOrder } from './recovery-fixture.ts';
import { controllerFixture } from './reconciliation-fixture.ts';
const run = <A,E>(value:Effect.Effect<A,E,import('effect').Scope.Scope>) => Effect.runPromise(Effect.scoped(value));
const rejects=<A,E>(op:Effect.Effect<A,E>,reason:RegExp)=>Effect.promise(()=>assert.rejects(Effect.runPromise(op),reason));
async function restore(f:Fixture){
 const config={...f.config,database:join(f.root,'new-host.db')};await run(restoreApplication(config));
 const c=controllerFixture();assert.equal((await run(SalesStore.reconcileRecovery(config,f.adapters,c.controller))).ready,true);
 return {...f,config};
}
test('K9: converted grants are exempt while two later unpaid grants exhaust the ration after journal-only restore',async (t)=>{
 const f=sendingFixture(t);await use(f,store=>Effect.gen(function*(){
  yield* setup(store);const first=yield* invoice(store);f.node.now=1;f.node.outputs=[payment(1)];yield* store.observe();yield* store.cancel(first.token);
  assert.equal((yield* invoice(store)).quote.pay_first,false);f.node.now=901;f.node.outputs=[];
  assert.equal((yield* invoice(store)).quote.pay_first,false);f.node.now=1801;yield* store.observe();
 }));
 const restored=await restore(f);await use(restored,store=>Effect.gen(function*(){yield* store.pause(false);assert.equal((yield* invoice(store)).quote.pay_first,true);}));
});
test('K20: late conversion exempts only its second grant and both unpaid grants remain counted across restore',async (t)=>{
 const f=sendingFixture(t);await use(f,store=>Effect.gen(function*(){
  yield* setup(store);const first=yield* invoice(store);f.node.now=901;f.node.outputs=[payment(1)];yield* store.observe();
  assert.equal((yield* store.order(first.token)).status,'converted');yield* store.cancel(first.token);
  const second=yield* invoice(store);assert.equal(second.quote.pay_first,false);yield* store.cancel(second.token);
  assert.equal((yield* invoice(store)).quote.pay_first,true);
 }));
 const restored=await restore(f);await use(restored,store=>Effect.gen(function*(){yield* store.pause(false);assert.equal((yield* invoice(store)).quote.pay_first,true);}));
});
test('K11: no clock before cancellation, settlement and destination; disappearing settlement never moves its start',async (t)=>{
 const f=sendingFixture(t);let token='';await use(f,store=>Effect.gen(function*(){
  yield* setup(store);const one=yield* invoice(store);token=one.token;f.node.outputs=[payment(1,10_000,5)];
  assert.deepEqual((yield* store.order(token)).refund_deadlines,[]);
  f.node.now=10;f.node.outputs[0]!.confirmations=6;assert.deepEqual((yield* store.order(token)).refund_deadlines,[]);
  f.node.now=20;yield* store.setRefundDestination(token,'buyer');assert.deepEqual((yield* store.order(token)).refund_deadlines,[]);
  f.node.now=30;const due=yield* store.cancel(token);assert.equal(due.refund_deadlines[0]!.started_at,30);
  f.node.now=40;f.node.outputs[0]!.confirmations=5;assert.equal((yield* store.order(token)).refund_deadlines[0]!.started_at,30);
  yield* rejects(store.prepareRefund('o1','cancellation','buyer'),/no refundable credit/);
  f.node.now=50;f.node.outputs[0]!.confirmations=6;assert.equal((yield* store.order(token)).refund_deadlines[0]!.started_at,30);
 }));
 await use(f,store=>Effect.gen(function*(){assert.equal((yield* store.order(token)).refund_deadlines[0]!.started_at,30);}));
});
test('K12: a broadcast at the 24-hour boundary meets the target and one second later is a permanent incident',async (t)=>{
 for(const lag of [86400,86401]){
 const f=sendingFixture(t);let token='';await use(f,store=>Effect.gen(function*(){
  f.node.now=20;const one=yield* Effect.promise(()=>settledRefund(store,f));token=one.token;
  f.senderState.failure=true;yield* store.broadcastRefund(one.group.id);assert.equal((yield* store.order(token)).refund_deadlines[0]!.remaining_sats,10_000);
  f.node.now=20+lag;f.senderState.failure=false;yield* store.reconcileRefunds();
  const d=(yield* store.order(token)).refund_deadlines[0]!;assert.equal(d.broadcast_at,20+lag);assert.equal(d.incident,lag>86400);
 }));
 f.node.now=100000;await use(f,store=>Effect.gen(function*(){const d=(yield* store.order(token)).refund_deadlines[0]!;assert.equal(d.incident,lag>86400);assert.equal((yield* store.operatorStatus()).alerts.filter(a=>a.kind==='refund_deadline').length,lag>86400?1:0);}));
 }
});
test('Q1: two actual concurrent quotes for one free name grant exactly one address and one hold',async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);const a=yield* store.request({handle:'n0@space',script_pubkey:script}),b=yield* store.request({handle:'n0@space',script_pubkey:script});
 const outcomes=yield* Effect.promise(()=>Promise.allSettled([a,b].map(o=>Effect.runPromise(store.quote(o.token)))));
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected').length,1);
 assert.match(String(outcomes.find(r=>r.status==='rejected')!.reason),/taken for now/);assert.equal(f.node.draws,1);
 const views=yield* Effect.forEach([a,b],o=>store.order(o.token));assert.equal(views.filter(v=>v.hold_expires_at!==null).length,1);assert.equal(views.filter(v=>v.address!==null).length,1);
 }));
});
function overpaid(store:SalesStore,f:Fixture){return Effect.gen(function*(){yield* setup(store);yield* store.listName('n0@space',10_000);const one=yield* invoice(store);f.node.outputs=[{...payment(1,13_000,6),outpoint:'1'.repeat(64)+':0'}];yield* store.setRefundDestination(one.token,'buyer');return one;});}
test('R10: prepared signed bytes have no export/release capability and their reservation survives an unsettled conflict',async (t)=>{
 const f=sendingFixture(t);await use(f,store=>Effect.gen(function*(){const one=yield* overpaid(store,f),g=yield* store.prepareRefund('o1','excess','buyer');
 assert.equal(JSON.stringify(g).includes('"raw"'),false);yield* rejects(store.discardUnbuiltRefund(g.id),/only an unbuilt/);
 f.observations.set(g.txid!,{txid:g.txid!,seen:'absent',confirmations:0,blockHash:null,inputsAvailable:false,conflicts:[{txid:'c'.repeat(64),confirmations:5,mempool:false}]});
 assert.equal((yield* store.order(one.token)).reserved_refund_sats,3000);assert.notEqual((yield* store.order(one.token)).refund_groups[0]!.status,'needs_rebuild');
 f.observations.get(g.txid!)!.conflicts[0]!.confirmations=6;
 assert.equal((yield* store.order(one.token)).refund_groups[0]!.status,'needs_rebuild');assert.equal((yield* store.order(one.token)).reserved_refund_sats,3000);assert.equal(f.sent.length,0);
 }));
});
test('R11: settlement-depth loss retains an excess group, blocks further refunds and permits three-confirmation issuance',async (t)=>{
 const f=sendingFixture(t);await use(f,store=>Effect.gen(function*(){const one=yield* overpaid(store,f),g=yield* store.prepareRefund('o1','excess','buyer');f.node.outputs[0]!.confirmations=5;
 const view=yield* store.order(one.token);assert.equal(view.reserved_refund_sats,3000);assert.deepEqual(view.reconciling,['refunds']);
 yield* rejects(store.prepareRefund('o1','excess','buyer'),/no refundable credit/);assert.equal(f.senderState.builds,1);yield* store.beginIssuance('o1');assert.equal((yield* store.order(one.token)).status,'issuing');assert.equal((yield* store.order(one.token)).refund_groups[0]!.id,g.id);
 }));
});
test('R15: regained settlement clears refund reconciliation without reallocating the existing reservation or available balance',async (t)=>{
 const f=sendingFixture(t);await use(f,store=>Effect.gen(function*(){const one=yield* overpaid(store,f),g=yield* store.prepareRefund('o1','excess','buyer');
 f.node.outputs.push({...payment(1,1000,6),outpoint:'2'.repeat(64)+':0'});const before=yield* store.order(one.token);assert.equal(before.refundable_sats,1000);
 f.node.outputs[0]!.confirmations=5;assert((yield* store.order(one.token)).reconciling.includes('refunds'));yield* rejects(store.prepareRefund('o1','excess','buyer'),/no refundable credit/);
 f.node.outputs[0]!.confirmations=6;const after=yield* store.order(one.token);assert.deepEqual(after.reconciling,[]);assert.equal(after.refundable_sats,before.refundable_sats);assert.equal(after.reserved_refund_sats,3000);assert.equal(after.refund_groups[0]!.id,g.id);
 const next=yield* store.prepareRefund('o1','excess','buyer');assert.equal(next.charged_sats,1000);
 }));
});
test('V9: earlier unpaid quote and unsigned nomination claim no recipient against a newly paid order',async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);const two=yield* invoice(store,1);yield* store.request({handle:'n2@space',script_pubkey:script});const one=yield* invoice(store,0);f.node.outputs=[payment(2)];yield* store.observe();
 assert.equal((yield* store.order(one.token)).status,'converted');assert.equal((yield* store.registry.entry('o3')).batch_entry,true);yield* store.beginIssuance('o3');assert.equal((yield* store.order(two.token)).status,'quoted');
 }));
});
test('V14: cancellation releases a recipient claim while fulfilled ownership still refuses reuse after restart',async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);const one=yield* invoice(store);f.node.outputs=[payment(1)];yield* store.observe();yield* rejects(store.request({handle:'n1@space',script_pubkey:script}),/script already used/);yield* store.cancel(one.token);yield* store.request({handle:'n1@space',script_pubkey:script});}));
 const c=certificateFixture(t);await use(c,store=>Effect.gen(function*(){yield* c.prepare(store);yield* store.registry.certificates.accept(c.packet());const cert=yield* store.registry.deliveries.status({...armed,oid:'o1'});yield* store.registry.deliveries.fulfill({...armed,oid:'o1',revision:cert.revision,certificateHash:cert.certificateHash,relayRoot:armed.root,relayHeight:50,proofHash:'e'.repeat(64)});}));
 await use(c,store=>Effect.gen(function*(){yield* rejects(store.request({handle:'n2@space',script_pubkey:script}),/script already used/);}));
});
async function invalidHistory(f:Fixture,update:Partial<import('../../src/application/records.ts').Order>){await changeOrder(f.config,'o1',update);const journal=JSON.stringify(f.journal.read());for(let pass=0;pass<2;pass++){await assert.rejects(use(f,()=>Effect.void));assert.equal(JSON.stringify(f.journal.read()),journal);}
 const config={...f.config,database:join(f.root,'refused-restore.db')};await assert.rejects(run(restoreApplication(config)));assert.equal(existsSync(config.database),false);assert.equal(JSON.stringify(f.journal.read()),journal);
}
test('V15: invalid legacy recipients fail closed at repeated strict startup and journal restore without publishing a serving database',async (t)=>{
 for(const status of ['requested','converted','issuing']){
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);yield* invoice(store);if(status!=='requested'){f.node.outputs=[payment(1)];yield* store.observe();if(status==='issuing')yield* store.beginIssuance('o1');}}));
 await invalidHistory(f,{recipient:'6a01ff'});
 }
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);yield* invoice(store);f.node.outputs=[payment(1)];yield* store.observe();}));
 await invalidHistory(f,{recipient:payment(1).script});
});
test('V16: two acknowledged converted recipient conflicts alert once each on restart and neither becomes batchable',async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);yield* invoice(store);yield* invoice(store,1);f.node.outputs=[payment(1),payment(2)];yield* store.observe();}));
 for(let restart=0;restart<2;restart++)await use(f,store=>Effect.gen(function*(){for(const oid of ['o1','o2']){assert.equal((yield* store.registry.entry(oid)).batch_entry,false);yield* rejects(store.beginIssuance(oid),/not batchable/);}assert.equal((yield* store.operatorStatus()).alerts.filter(a=>a.kind==='recipient_conflict').length,2);}));
});
test('V17: retry of an active quote refuses a newly claimed recipient; invalid legacy quote cannot expose its address',async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);const one=yield* invoice(store);yield* invoice(store,1);f.node.outputs=[payment(2)];yield* store.observe();yield* rejects(store.quote(one.token),/script already used/);const v=yield* store.order(one.token);assert.equal(v.address,null);assert.equal(v.status,'quoted');assert.equal(v.hold_expires_at,900);}));
 const bad=fixture(t);await use(bad,store=>Effect.gen(function*(){yield* setup(store);yield* invoice(store);}));await invalidHistory(bad,{recipient:'6a01ff'});
});
test('N5: issuing, ready and fulfilled names retain the full price reserve and can owe only their excess',async (t)=>{
 const f=certificateFixture(t),single={...armed,oids:['o1']};await use(f,store=>Effect.gen(function*(){
  yield* setup(store);yield* store.listName('n0@space',10_000);const one=yield* invoice(store);f.node.outputs=[payment(1,13_000,6)];yield* store.observe();
  yield* store.registry.entries.enter({entry:single.entry,root:single.root,oids:single.oids});yield* store.registry.entries.arm(single);
  const check=()=>Effect.gen(function*(){assert.equal((yield* store.inspectionOrder('o1')).price_reserve,10_000);assert.equal((yield* store.order(one.token)).refundable_sats,3000);yield* rejects(store.cancel(one.token),/once issuing/);});
  assert.equal((yield* store.order(one.token)).status,'issuing');yield* check();
  yield* store.registry.commitments.observe({...single,expectedRevision:0,observation:f.facts(50,50,210)});
  yield* store.registry.certificates.accept({...f.packet(),oids:['o1']});assert.equal((yield* store.order(one.token)).status,'ready');yield* check();
  const cert=yield* store.registry.deliveries.status({...single,oid:'o1'});yield* store.registry.deliveries.fulfill({...single,oid:'o1',revision:cert.revision,certificateHash:cert.certificateHash,relayRoot:single.root,relayHeight:50,proofHash:'e'.repeat(64)});
  assert.equal((yield* store.order(one.token)).status,'fulfilled');yield* check();
 }));
});
test('K17: a later refund uses its own available change, excluding spent originals and every other order reservation',async (t)=>{
 const f=familyFixture(t);await use(f,store=>Effect.gen(function*(){
  const one=yield* overpaid(store,f),first=yield* store.prepareRefund('o1','excess','buyer');yield* store.broadcastRefund(first.id);mine(f,first.txid!);yield* store.order(one.token);
  const other=yield* store.request({handle:'n1@space',script_pubkey:'5120'+'2'.padStart(64,'0')});yield* store.quote(other.token);f.node.outputs.push({...payment(2,10_000,6),outpoint:'2'.repeat(64)+':0'});yield* store.setRefundDestination(other.token,'other-buyer');yield* store.cancel(other.token);
  f.journal.down=true;const reserved=yield* store.prepareRefund('o2','cancellation','buyer');f.journal.down=false;assert.equal(reserved.phase,'reserved');
  yield* store.cancel(one.token);const later=yield* store.prepareRefund('o1','cancellation','buyer');
  const request=f.control.requests.at(-1)!;assert.equal(request.group.order,'o1');assert(request.forbiddenInputs.includes('1'.repeat(64)+':0'));
  assert(request.orderCoins.every(c=>c.outpoint!=='2'.repeat(64)+':0'));assert.equal(later.charged_sats,10_000);
  assert.equal(later.attempts[0]!.txid,later.txid);assert(f.sent[0]!.outputs.some(o=>o.role==='order_change'&&o.sats===10_000));
  const change=f.sent[0]!.outputs.findIndex(o=>o.role==='order_change');assert.equal(request.orderCoins.some(c=>c.outpoint===first.txid+':'+change),true);
  assert.equal((yield* store.order(other.token)).reserved_refund_sats,10_000);
  yield* rejects(store.prepareRefund('o1','cancellation','buyer'),/no refundable credit/);
 }));
 const absent=familyFixture(t);await use(absent,store=>Effect.gen(function*(){const one=yield* overpaid(store,absent);const build=absent.adapters.refunds!.build;
  absent.adapters.refunds={...absent.adapters.refunds!,build:r=>build({...r,orderCoins:[]})};
  yield* rejects(store.prepareRefund('o1','excess','buyer'),/unavailable|validation|assert/i);assert.equal((yield* store.order(one.token)).refund_groups[0]!.phase,'reserved');assert.equal(absent.sent.length,0);
 }));
});
test('T3: every quote durably reports its skipped refund destination once and never allocates it',async (t)=>{
 const f=sendingFixture(t);f.adapters.refunds={...f.adapters.refunds!,resolveAddress:address=>Effect.succeed({address,script:payment(1).script})};
 await use(f,store=>Effect.gen(function*(){yield* setup(store);const one=yield* store.request({handle:'n0@space',script_pubkey:script});yield* store.setRefundDestination(one.token,'refund-before-quote');assert.equal((yield* store.quote(one.token)).address,'mock-address-2');
  let draws=0;f.adapters.newDestination=Effect.sync(()=>++draws===1?{address:'refund-alias',script:payment(1).script}:{address:'mock-address-3',script:payment(3).script});const next=yield* invoice(store,1);assert.equal(next.quote.address,'mock-address-3');
  const alerts=(yield* store.operatorStatus()).alerts.filter(a=>a.kind==='destination_held');assert.equal(alerts.length,2);assert.deepEqual(alerts.map(a=>a.amount),[1,1]);
  yield* store.quote(one.token);assert.equal((yield* store.operatorStatus()).alerts.filter(a=>a.kind==='destination_held').length,2);
 }));
 await use(f,store=>Effect.gen(function*(){assert.equal((yield* store.operatorStatus()).alerts.filter(a=>a.kind==='destination_held').length,2);}));
});
