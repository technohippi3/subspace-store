import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { DurableStore } from "../../src/storage/store.ts";
import { SalesStore } from "../../src/application/store.ts";
import { restoreApplication } from "../../src/application/recovery.ts";
import { ApplicationError } from "../../src/application/records.ts";
import { fixture, invoice, payment, setup, use } from "./application-fixture.ts";
import { certificateFixture } from "./certificate-fixture.ts";
import { armed } from "./commitment-fixture.ts";
import { sendingFixture, settledRefund } from "./refund-sending-fixture.ts";
import { changeOrder, recovered } from "./recovery-fixture.ts";

const run = <A,E>(value: Effect.Effect<A,E,import("effect").Scope.Scope>) => Effect.runPromise(Effect.scoped(value));
test("O78: restore retains only acknowledged invoices and cancellations, preserves identity/history and pauses admission", async(t)=>{
  const f=fixture(t); let token="";
  await use(f,store=>Effect.gen(function*(){
    yield* setup(store); token=(yield* invoice(store)).token;
    const unknown=yield* store.request({handle:"n1@space",script_pubkey:"5120"+"2".padStart(64,"0")});
    f.node.beforeDestination=async()=>{f.journal.down=true;};
    assert.equal((yield* store.quote(unknown.token)).address,null);
    yield* store.cancel(token);
  }));
  f.journal.down=false;
  const config={...f.config,database:join(f.root,"restored.db")};
  const report=await run(restoreApplication(config)); assert.equal(report.acknowledged,true); assert.equal(report.ready,false);
  assert.equal(report.sales_paused,true); assert.equal(report.chain,null);
  const {state}=await recovered(config);
  assert.equal(state.orders[0]!.status,"quoted"); assert.equal(state.orders[0]!.paymentHistory,"unknown");
  assert.equal(state.orders[1]!.status,"requested"); assert.equal(state.orders[1]!.destination,null); assert.equal(state.orders[1]!.paymentHistory,"none");
  assert.equal(state.settings.nextOrder,3); assert.equal(state.settings.paused,true);
  await assert.rejects(run(SalesStore.open(config,f.adapters)),/controller and chain reconciliation/);
  assert.equal(existsSync(config.database+".certificates"),false);
  await assert.rejects(run(restoreApplication(config)),/never overwrites/);
});
test("O79: semantic corruption, changed financial configuration and orphan sidecars refuse before publication", async(t)=>{
  for(const bad of ["unknown-record","wrong-fields","configuration","sidecar","marker"]){
    const f=fixture(t); await use(f,store=>setup(store));
    if(bad==="unknown-record"||bad==="wrong-fields") await run(Effect.gen(function*(){
      const storage=yield* DurableStore.open(f.config);
      yield* storage.commit([bad==="unknown-record"?{kind:"alien",key:"one",value:{}}:{kind:"listing",key:"n0@space",value:{handle:"n0@space",space:"space",price:1000,extra:true}}]);
    }));
    if(bad==="marker") await run(Effect.gen(function*(){
      const storage=yield* DurableStore.open(f.config);
      yield* storage.commit([{kind:"application_recovery",key:"global",value:{version:1,required:true,sourceSequence:1000000}}]);
    }));
    const config={...f.config,database:join(f.root,"restored.db"),...(bad==="configuration"?{riskBudgetSats:100}: {})};
    if(bad==="sidecar") writeFileSync(config.database+"-wal","retained evidence");
    const position=f.journal.read().length;
    await assert.rejects(run(restoreApplication(config))); assert.equal(existsSync(config.database),false);
    assert.equal(f.journal.read().length,position);
    if(bad==="sidecar") assert.equal(readFileSync(config.database+"-wal","utf8"),"retained evidence");
  }
});
test("O80: unknown invoices never expose a new payment request and fresh detection is sticky", async(t)=>{
  const f=fixture(t); let token="";
  await use(f,store=>Effect.gen(function*(){yield* setup(store);token=(yield* invoice(store)).token;}));
  await changeOrder(f.config,"o1",{paymentHistory:"unknown"});
  await use(f,store=>Effect.gen(function*(){
    const view=yield* store.quote(token); assert.equal(view.payment_history,"unknown"); assert.equal(view.address,null); assert.equal(view.address_pending,false);
    assert.equal(f.node.draws,1); f.node.outputs=[payment(1,100,0)];
    assert.equal((yield* store.order(token)).payment_history,"detected");
    f.node.outputs=[]; assert.equal((yield* store.order(token)).payment_history,"detected");
  }));
});
test("O81: recovery rereads refund members without signing or sending and retains reservations on unknown outcomes", async(t)=>{
  const f=sendingFixture(t); let gid="",txid="";
  await use(f,store=>Effect.gen(function*(){
    const prepared=yield* Effect.promise(()=>settledRefund(store,f));gid=prepared.group.id;txid=prepared.group.txid!;
    f.senderState.failure=true; yield* store.broadcastRefund(gid);
  }));
  const sends=f.sent.length,builds=f.senderState.builds,draws=f.node.draws;
  const config={...f.config,database:join(f.root,"restored.db")};await run(restoreApplication(config));
  const first=await run(SalesStore.inspectRecovery(config,f.adapters)); assert.equal(first.phase,"observed"); assert.equal(first.ready,false);
  assert.equal(first.refunds.attempted,1);assert.equal(first.refunds.settled,0);
  const {state}=await recovered(config);assert.equal(state.groups[0]!.id,gid);assert.equal(state.groups[0]!.transaction!.txid,txid);
  assert.equal(state.refundSends[0]!.calls,1);assert.equal(state.groups[0]!.charged,10000);
  const second=await run(SalesStore.inspectRecovery(config,f.adapters));assert.equal(second.sequence,first.sequence);
  assert.equal(f.sent.length,sends);assert.equal(f.senderState.builds,builds);assert.equal(f.node.draws,draws);
  f.senderState.failRead=true;await assert.rejects(run(SalesStore.inspectRecovery(config,f.adapters)),/refund lookup failed/);
  assert.equal((await recovered(config)).status.restoreRequired,true);
  const noSender={...f.adapters};delete noSender.refunds;
  await assert.rejects(run(SalesStore.inspectRecovery(config,noSender)),/refund observation adapter/);
});
test("O82: restore invalidates lost certificate cache while retaining arms, delivery, reserves and cancellation history",async(t)=>{
  const f=certificateFixture(t);
  await use(f,store=>Effect.gen(function*(){
    yield* f.prepare(store);for(const oid of ["o1","o2"])yield* store.registry.certificates.accept(f.packet(oid));
    const cert=yield* store.registry.deliveries.status({...armed,oid:"o1"});
    yield* store.registry.deliveries.fulfill({...armed,oid:"o1",revision:cert.revision,certificateHash:cert.certificateHash!,relayRoot:armed.root,relayHeight:50,proofHash:"e".repeat(64)});
  }));
  const config={...f.config,database:join(f.root,"restored.db")};
  const report=await run(restoreApplication(config));assert.equal(report.issuance.armed,1);assert.equal(report.issuance.usable_certificates,0);
  const before=await recovered(config);assert.equal(before.state.orders[0]!.status,"fulfilled");assert.equal(before.state.orders[0]!.price,1000);
  assert.equal(before.state.orders[1]!.status,"issuing");assert.equal(before.state.incidents[0]!.reasons[0],"application_restored");
  const inspected=await run(SalesStore.inspectRecovery(config,f.adapters));assert.equal(inspected.ready,false);assert.equal(inspected.issuance.usable_certificates,0);
  const after=await recovered(config);assert.deepEqual(after.state.fulfillments,before.state.fulfillments);assert.equal(after.state.arms.length,1);
  assert.equal(after.state.certificates.every(c=>!c.valid),true);assert.equal(after.state.incidents.length,1);
});
test("O85: inspection refuses ordinary or missing databases, journal outages and incoherent chain tips without clearing quarantine",async(t)=>{
  const f=fixture(t);await use(f,store=>setup(store));
  await assert.rejects(run(SalesStore.inspectRecovery(f.config,f.adapters)),/not awaiting restore/);
  const config={...f.config,database:join(f.root,"restored.db")};
  await assert.rejects(run(SalesStore.inspectRecovery(config,f.adapters)),/requires an existing restored/);assert.equal(existsSync(config.database),false);
  await run(restoreApplication(config));
  const bad={...f.adapters,snapshot:()=>Effect.fail(new ApplicationError({code:"unavailable",message:"Core unavailable"}))};
  await assert.rejects(run(SalesStore.inspectRecovery(config,bad)),/Core unavailable/);
  await assert.rejects(run(SalesStore.inspectRecovery(config,f.adapters)),/coherent recovery tip/);
  f.journal.down=true;await assert.rejects(run(SalesStore.inspectRecovery(config,f.adapters)));f.journal.down=false;
  assert.equal((await recovered(config)).status.restoreRequired,true);
});
