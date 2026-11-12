import {test} from "node:test";
import assert from "node:assert/strict";
import {copyFileSync,existsSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {Effect} from "effect";
import {SalesStore,type Config} from "../../src/application/store.ts";
import {DurableStore} from "../../src/storage/store.ts";
import {decode,type State} from "../../src/application/records.ts";
import {configuration} from "../../src/refunds/book.ts";
import {restoreApplication} from "../../src/application/recovery.ts";
import {serve} from "../../src/application/http.ts";
import {fixture,invoice,payment,script,setup,use,type Fixture} from "./application-fixture.ts";
import {sendingFixture} from "./refund-sending-fixture.ts";
import {controllerFixture} from "./reconciliation-fixture.ts";
const run=<A,E>(work:Effect.Effect<A,E,import("effect").Scope.Scope>)=>Effect.runPromise(Effect.scoped(work));
function coherent(f:Fixture){f.adapters.snapshot=()=>Effect.succeed({tip:f.node.tip,tipHash:"d".repeat(64),outputs:structuredClone(f.node.outputs)});return f;}
async function projection(config:Config){return run(Effect.gen(function*(){const storage=yield*DurableStore.open({...config,restore:false});const status=yield*storage.status();const state=decode(yield*storage.records(),config.riskBudgetSats,configuration({version:1,policy:config.refundPolicy,merchantDestinations:[...(config.merchantDestinations??[])]}));return{state,status};}));}
async function restore(f:Fixture,name="restored.db"){
 f.journal.down=false;const config={...f.config,database:join(f.root,name)};
 const receipt=await run(restoreApplication(config));assert.equal(receipt.acknowledged,true);assert.equal(receipt.sales_paused,true);
 await assert.rejects(run(SalesStore.open(config,f.adapters)),/requires controller/);
 const controller=controllerFixture();const result=await run(SalesStore.reconcileRecovery(config,f.adapters,controller.controller));assert.equal(result.ready,true);assert.equal(result.sales_paused,true);
 return{...f,config};
}
const key2="5120"+"2".padStart(64,"0");
function request(store:SalesStore,index:number,key=script){return store.request({handle:`n${index}@space`,script_pubkey:key});}
function stable(state:State){return{listings:state.listings,orders:state.orders,groups:state.groups,attempts:state.refundAttempts,sends:state.refundSends,accounts:state.accounts,alerts:state.alerts,authorizations:state.ownerAuthorizations};}

test("H1: acknowledged orders refunds attempts alerts and owner authorization survive journal-only restore and fresh balance observation",async(t)=>{
 const f=sendingFixture(t);let ownerToken="",otherToken="",group="";
 await use(f,store=>Effect.gen(function*(){yield*setup(store,3);
  const p=yield*store.seller.ownerPreview({handle:"n0@space",script_pubkey:script});const owner=yield*store.seller.ownerInvoice({operation:"a".repeat(32),handle:"n0@space",script_pubkey:script,confirm:"n0@space",review:p.review});ownerToken=owner.order_link!.split("/").at(-1)!;
  const other=yield*store.request({handle:"n1@space",script_pubkey:key2});otherToken=other.token;yield*store.quote(otherToken);
  f.node.outputs=[payment(1,1000,3),{...payment(2,10000,6),outpoint:"2".repeat(64)+":0"}];yield*store.observe();
  yield*store.setRefundDestination(ownerToken,"refund-owner");yield*store.setRefundDestination(otherToken,"refund-other");yield*store.cancel(otherToken);
  group=(yield*store.prepareRefund("o2","cancellation","buyer")).id;f.senderState.failure=true;yield*store.broadcastRefund(group);
  f.node.outputs[0]={...payment(1,500,3),outpoint:"replacement-short-payment"};yield*store.observe();
 }));
 const before=(await projection(f.config)).state;assert.equal(before.ownerAuthorizations.length,1);assert.equal(before.refundSends.length,1);assert(before.alerts.length>0);assert(before.groups[0]!.transaction);
 const sends=f.sent.length,builds=f.senderState.builds;const restored=await restore(f);
 const after=(await projection(restored.config)).state;assert.deepEqual(stable(after),stable(before));
 await use(restored,store=>Effect.gen(function*(){const a=yield*store.order(ownerToken),b=yield*store.order(otherToken);assert.equal(a.status,"converted");assert.equal(a.batchable_sats,500);assert.equal(a.refund_address,"refund-owner");assert.equal(b.status,"cancelled");assert.equal(b.settled_sats,10000);assert.equal(b.reserved_refund_sats,10000);assert.equal(b.refund_groups[0]!.id,group);}));
 assert.equal(f.sent.length,sends);assert.equal(f.senderState.builds,builds);
});

test("H2: host loss discards unacknowledged cancellation and refund reservation but rereads a conversion from the unchanged chain",async(t)=>{
 const f=sendingFixture(t);let a="",b="",c="";
 await use(f,store=>Effect.gen(function*(){yield*setup(store,3);a=(yield*invoice(store,0)).token;
  b=(yield*store.request({handle:"n1@space",script_pubkey:key2})).token;yield*store.quote(b);
  c=(yield*store.request({handle:"n2@space",script_pubkey:"5120"+"3".padStart(64,"0")})).token;yield*store.quote(c);
  f.node.outputs=[payment(2,1000,3),payment(3,10000,6)];yield*store.observe();yield*store.setRefundDestination(c,"refund-c");yield*store.cancel(c);
  f.journal.down=true;f.node.outputs.push(payment(1,1000,3));yield*store.observe();assert.equal((yield*store.order(a)).status,"converted");
  assert.equal((yield*store.cancel(b)).cancellation,"unconfirmed");const g=yield*store.prepareRefund("o3","cancellation","buyer");assert.equal(g.phase,"reserved");assert.equal(g.acknowledged,false);assert.equal(f.senderState.builds,0);
 }));
 const restored=await restore(f);await use(restored,store=>Effect.gen(function*(){assert.equal((yield*store.order(a)).status,"converted");const unconfirmed=yield*store.order(b);assert.equal(unconfirmed.status,"converted");assert.equal(unconfirmed.cancellation,null);assert.equal((yield*store.order(c)).status,"cancelled");}));
 assert.deepEqual((await projection(restored.config)).state.groups,[]);assert.deepEqual(f.sent,[]);assert.equal(f.senderState.builds,0);
});

test("H3: existing journal refuses missing and uninitialized databases before serving or creating a replacement ledger",async(t)=>{
 const f=coherent(fixture(t));await use(f,store=>setup(store,2));
 const missing={...f.config,database:join(f.root,"missing.db")};const observations=f.node.observations;
 await assert.rejects(run(SalesStore.open(missing,f.adapters)),/restore required/);assert.equal(existsSync(missing.database),false);assert.equal(f.node.observations,observations);
 const empty={...f.config,database:join(f.root,"empty.db")};const db=new DatabaseSync(empty.database);db.close();const before=readFileSync(empty.database);
 await assert.rejects(run(SalesStore.open(empty,f.adapters)),/restore required/);assert.deepEqual(readFileSync(empty.database),before);assert.equal(f.node.observations,observations);
});

test("H4: restore refuses an existing target database and preserves its exact bytes and journal",async(t)=>{
 const f=coherent(fixture(t));await use(f,store=>setup(store,1));const before=readFileSync(f.config.database),history=f.journal.read();
 await assert.rejects(run(restoreApplication(f.config)),/never overwrites/);assert.deepEqual(readFileSync(f.config.database),before);assert.deepEqual(f.journal.read(),history);
});

test("H8: journal outage refuses a quote before destination allocation and a restored requested order can quote after explicit resume",async(t)=>{
 const f=coherent(fixture(t));let token="";
 await use(f,store=>Effect.gen(function*(){yield*setup(store,1);token=(yield*request(store,0)).token;f.journal.down=true;const server=yield*serve(store);
  yield*Effect.promise(async()=>{const response=await fetch(server.url+`/orders/${token}/quote`,{method:"POST"});assert.equal(response.status,503);assert.match(JSON.stringify(await response.json()),/journal/);});assert.equal(f.node.draws,0);
 }));
 const restored=await restore(f);await use(restored,store=>Effect.gen(function*(){const view=yield*store.order(token);assert.equal(view.status,"requested");assert.equal(view.address,null);assert.equal(view.hold_expires_at,null);assert.equal((yield*store.catalog()).listings[0]!.available,true);yield*store.pause(false);const quote=yield*store.quote(token);assert.equal(quote.address,"mock-address-1");assert.equal(quote.acknowledged,true);}));
});

test("H9: unacknowledged invoices hide destinations and replay adopts only acknowledged history into a restored or older database",async(t)=>{
 const f=coherent(fixture(t));let a="",b="";const old=join(f.root,"older.db");
 await use(f,store=>Effect.gen(function*(){yield*setup(store,2);a=(yield*request(store,0)).token;b=(yield*request(store,1,key2)).token;}));copyFileSync(f.config.database,old);
 await use(f,store=>Effect.gen(function*(){f.node.beforeDestination=async()=>{f.journal.down=true;};const pending=yield*store.quote(a);assert.equal(pending.address,null);assert.equal(pending.address_pending,true);assert.equal((yield*store.order(a)).address,null);
  f.journal.down=false;f.node.beforeDestination=null;assert.equal((yield*store.quote(a)).address,"mock-address-1");
  f.node.beforeDestination=async()=>{f.journal.down=true;};const second=yield*store.quote(b);assert.equal(second.address,null);assert.equal(second.address_pending,true);assert.equal((yield*store.order(b)).address,null);
 }));f.node.beforeDestination=null;
 const restored=await restore(f);const state=(await projection(restored.config)).state;assert.equal(state.orders[0]!.destination!.address,"mock-address-1");assert.equal(state.orders[1]!.destination,null);assert.equal(state.orders[1]!.status,"requested");
 await use(restored,store=>Effect.gen(function*(){assert.equal((yield*store.order(a)).address,null);assert.equal((yield*store.order(a)).payment_history,"unknown");assert.equal((yield*store.catalog()).listings[1]!.available,true);}));
 const older={...f,config:{...f.config,database:old}};await use(older,store=>Effect.gen(function*(){assert.equal((yield*store.order(a)).payment_history,"unknown");assert.equal((yield*store.order(b)).status,"requested");}));assert.equal((await projection(older.config)).state.orders[0]!.destination!.address,"mock-address-1");
});

test("H10: cancellation stays unconfirmed while journal acknowledgment is missing and restore retains only final cancellation",async(t)=>{
 const f=coherent(fixture(t));let a="",b="";
 await use(f,store=>Effect.gen(function*(){yield*setup(store,2);a=(yield*invoice(store,0)).token;b=(yield*request(store,1,key2)).token;yield*store.quote(b);f.node.outputs=[payment(1),payment(2)];yield*store.observe();
  f.journal.down=true;let view=yield*store.cancel(a);assert.equal(view.status,"converted");assert.equal(view.cancellation,"unconfirmed");f.journal.down=false;view=yield*store.order(a);assert.equal(view.status,"cancelled");assert.equal(view.cancellation,"final");
  f.journal.down=true;for(let i=0;i<2;i++){view=yield*store.cancel(b);assert.equal(view.status,"converted");assert.equal(view.cancellation,"unconfirmed");}
 }));const restored=await restore(f);
 await use(restored,store=>Effect.gen(function*(){assert.equal((yield*store.order(a)).cancellation,"final");const undone=yield*store.order(b);assert.equal(undone.status,"converted");assert.equal(undone.cancellation,null);assert.equal((yield*store.catalog()).listings[1]!.available,false);assert.equal((yield*store.cancel(b)).cancellation,"final");assert.equal((yield*store.order(b)).status,"cancelled");}));
});

test("H11: wallet replay after journal restore skips both old destinations and retains one bounded destination-held alert",async(t)=>{
 const f=coherent(fixture(t));let first="",unpaid="";
 await use(f,store=>Effect.gen(function*(){yield*setup(store,4);first=(yield*invoice(store,0)).token;unpaid=(yield*request(store,1,key2)).token;yield*store.quote(unpaid);f.node.outputs=[payment(1)];yield*store.observe();}));
 const held=(await projection(f.config)).state.orders.map(o=>o.destination!);const restored=await restore(f);let draws=0;
 f.adapters.newDestination=Effect.sync(()=>{const candidate=[held[1],held[0],{address:"fresh-after-recovery",script:"0014"+"f".repeat(40)}][draws++]!;return structuredClone(candidate);});
 await use(restored,store=>Effect.gen(function*(){yield*store.pause(false);const third=yield*request(store,2,"5120"+"3".padStart(64,"0"));const quote=yield*store.quote(third.token);assert.equal(quote.address,"fresh-after-recovery");assert.equal(draws,3);assert.equal((yield*store.order(first)).status,"converted");assert.equal((yield*store.order(unpaid)).address,null);
  const alerts=(yield*store.operatorStatus()).alerts.filter(a=>a.kind==="destination_held");assert.equal(alerts.length,1);assert.equal(alerts[0]!.order,"o3");assert.equal(alerts[0]!.amount,2);assert.equal(alerts[0]!.deadline,null);assert(!JSON.stringify(alerts).includes(held[0]!.address));
  f.adapters.newDestination=Effect.succeed(held[0]!);const fourth=yield*request(store,3,"5120"+"4".padStart(64,"0"));const before=draws;yield*Effect.promise(()=>assert.rejects(Effect.runPromise(store.quote(fourth.token)),/only addresses/));assert.equal((yield*store.order(fourth.token)).status,"requested");assert.equal((yield*store.order(fourth.token)).hold_expires_at,null);assert.equal((yield*store.catalog()).listings[3]!.available,true);assert.equal(draws,before);
 }));
 const state=(await projection(restored.config)).state;assert.deepEqual(state.orders.slice(0,2).map(o=>o.destination),held);assert.equal(new Set(state.orders.flatMap(o=>o.destination?[o.destination.script]:[])).size,3);
});

test("S1: a pause stops new quotes while existing invoices convert and journal restore requires an explicit resume",async(t)=>{
 const f=coherent(fixture(t));let a="",b="";
 await use(f,store=>Effect.gen(function*(){yield*setup(store,2);a=(yield*invoice(store,0)).token;yield*store.pause(true);b=(yield*request(store,1,key2)).token;yield*Effect.promise(()=>assert.rejects(Effect.runPromise(store.quote(b)),/sales are paused/));assert.equal((yield*store.order(b)).address,null);assert.equal((yield*store.order(b)).hold_expires_at,null);const server=yield*serve(store);yield*Effect.promise(async()=>{const html=await(await fetch(server.url+"/")).text();assert.match(html,/new invoices are paused/i);});f.node.outputs=[payment(1)];yield*store.observe();assert.equal((yield*store.order(a)).status,"converted");
  yield*Effect.promise(()=>assert.rejects(Effect.runPromise(store.pause("false" as unknown as boolean))));
 }));const restored=await restore(f);await use(restored,store=>Effect.gen(function*(){yield*Effect.promise(()=>assert.rejects(Effect.runPromise(store.quote(b)),/sales are paused/));yield*store.pause(false);assert.equal((yield*store.quote(b)).acknowledged,true);}));
});

test("S5: unacknowledged pause and acknowledged resume never turn a journal-only restore into automatic admission",async(t)=>{
 const f=coherent(fixture(t));let token="";await use(f,store=>Effect.gen(function*(){yield*setup(store,1);token=(yield*request(store,0)).token;f.journal.down=true;const pause=yield*store.pause(true);assert.equal(pause.paused,true);assert.equal(pause.acknowledged,false);}));
 const first=await restore(f,"first.db");await use(first,store=>Effect.gen(function*(){yield*Effect.promise(()=>assert.rejects(Effect.runPromise(store.quote(token)),/sales are paused/));assert.equal((yield*store.pause(false)).acknowledged,true);assert.equal((yield*store.quote(token)).acknowledged,true);}));
 const second=await restore(first,"second.db");await use(second,store=>Effect.gen(function*(){assert.equal((yield*store.catalog()).paused,true);const pending=yield*request(store,0);yield*Effect.promise(()=>assert.rejects(Effect.runPromise(store.quote(pending.token)),/sales are paused/));}));
});

test("S6: a fresh paused store with no listings restarts but a missing ledger still requires explicit journal restore",async(t)=>{
 const f=coherent(fixture(t));await use(f,store=>Effect.gen(function*(){assert.equal((yield*store.pause(true)).acknowledged,true);}));await use(f,store=>Effect.gen(function*(){assert.equal((yield*store.catalog()).paused,true);assert.deepEqual((yield*store.catalog()).listings,[]);}));
 const missing={...f.config,database:join(f.root,"missing-fresh.db")};await assert.rejects(run(SalesStore.open(missing,f.adapters)),/restore required/);assert.equal(existsSync(missing.database),false);
 const restored=await restore(f);await use(restored,store=>Effect.gen(function*(){assert.equal((yield*store.catalog()).paused,true);yield*store.listName("n0@space",1000);yield*store.pause(false);assert.equal((yield*invoice(store,0)).quote.acknowledged,true);}));
});

test("J11: host loss drops unacknowledged payment instructions and retains acknowledged destination history without repeating payment prompts",async(t)=>{
 const f=coherent(fixture(t));let lost="",pending="",good="";
 await use(f,store=>Effect.gen(function*(){yield*setup(store,3);good=(yield*invoice(store,0)).token;pending=(yield*request(store,1,key2)).token;
  f.journal.down=true;lost=(yield*request(store,2,"5120"+"3".padStart(64,"0"))).token;yield*Effect.promise(()=>assert.rejects(Effect.runPromise(store.quote(lost)),/journal/));assert.equal((yield*store.order(lost)).address,null);
 }));
 // The first host loss removes the request that never reached the journal.
 const first=await restore(f,"first-j11.db");await use(first,store=>Effect.gen(function*(){yield*Effect.promise(()=>assert.rejects(Effect.runPromise(store.order(lost)),/no such order/));yield*store.pause(false);f.node.beforeDestination=async()=>{f.journal.down=true;};const view=yield*store.quote(pending);assert.equal(view.address,null);assert.equal(view.address_pending,true);}));f.node.beforeDestination=null;
 const second=await restore(first,"second-j11.db");await use(second,store=>Effect.gen(function*(){const a=yield*store.order(good),b=yield*store.order(pending);assert.equal(a.payment_history,"unknown");assert.equal(a.payment_request_open,false);assert.equal(a.address,null);assert.equal(b.status,"requested");assert.equal(b.address,null);assert.equal(b.hold_expires_at,null);}));
 const state=(await projection(second.config)).state;assert.equal(state.orders[0]!.destination!.address,"mock-address-1");assert.equal(state.orders[1]!.destination,null);
});

test("J12: HTTP final cancellation survives host loss while repeated unconfirmed cancellation loses its local effect",async(t)=>{
 const f=coherent(fixture(t));let a="",b="";
 await use(f,store=>Effect.gen(function*(){yield*setup(store,2);a=(yield*invoice(store,0)).token;b=(yield*request(store,1,key2)).token;yield*store.quote(b);f.node.outputs=[payment(1),payment(2)];yield*store.observe();const server=yield*serve(store);
  yield*Effect.promise(async()=>{const first=await fetch(server.url+`/orders/${a}/cancel`,{method:"POST"});assert.equal(first.status,200);assert.equal(((await first.json()) as {cancellation:string}).cancellation,"final");f.journal.down=true;for(let i=0;i<2;i++){const response=await fetch(server.url+`/orders/${b}/cancel`,{method:"POST"});assert.equal(response.status,202);const view=await response.json() as {status:string;cancellation:string};assert.equal(view.status,"converted");assert.equal(view.cancellation,"unconfirmed");}});
 }));const restored=await restore(f);await use(restored,store=>Effect.gen(function*(){assert.equal((yield*store.order(a)).cancellation,"final");assert.equal((yield*store.order(b)).status,"converted");assert.equal((yield*store.order(b)).cancellation,null);assert.equal((yield*store.cancel(b)).cancellation,"final");}));
});
