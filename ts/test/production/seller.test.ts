import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Effect } from "effect";
import { SalesStore } from "../../src/application/store.ts";
import { restoreApplication } from "../../src/application/recovery.ts";
import { command, type SellerCommand } from "../../src/application/seller-service.ts";
import { decode, encode } from "../../src/application/records.ts";
import { configuration } from "../../src/refunds/book.ts";
import { fixture, invoice, payment, script, setup, use } from "./application-fixture.ts";
import { sendingFixture, settledRefund, tipHash } from "./refund-sending-fixture.ts";
import { recovered } from "./recovery-fixture.ts";

const change=(store:SalesStore,value:SellerCommand)=>Effect.gen(function*(){
  const preview=yield* store.seller.preview(value);const result=yield* store.seller.apply(value,preview.review);assert.equal(result.acknowledged,true);return result;
});
const run=<A,E>(e:Effect.Effect<A,E>)=>Effect.runPromise(e);
const rejection=(work:()=>Promise<unknown>,message?:RegExp)=>Effect.promise(()=>message?assert.rejects(work,message):assert.rejects(work));

test("K22: first and later seller setup uses durable operations without replacing invoices or initializing wallets",async(t)=>{
  const f=fixture(t);let token="";
  await use(f,store=>Effect.gen(function*(){
    yield* change(store,{action:"space",space:"space"});yield* change(store,{action:"listing",handle:"n0@space",price_sats:1000});yield* store.pause(false);
    const one=yield* invoice(store);token=one.token;
    yield* change(store,{action:"space",space:"later"});yield* change(store,{action:"listing",handle:"n0@later",price_sats:2000});
    yield* change(store,{action:"space",space:"space"});assert.equal(f.node.draws,1);
    assert.equal((yield* store.order(token)).address,one.quote.address);
  }));
  await use(f,store=>Effect.gen(function*(){assert.equal((yield* store.order(token)).price_sats,1000);
    assert.deepEqual((yield* store.operatorStatus()).seller.spaces.map(s=>s.space).sort(),["later","space"]);assert.equal(f.node.draws,1);}));
});
test("K23: price commands retain fixed invoices and P12 late-price behavior and the original exposure formula",async(t)=>{
  for(const price of [700,2000]){
    const f=fixture(t);
    await use(f,store=>Effect.gen(function*(){yield* setup(store);const one=yield* invoice(store);
      f.node.now=900;yield* store.observe();yield* change(store,{action:"listing",handle:"n0@space",price_sats:price});
      f.node.outputs=[payment(1)];const view=yield* store.order(one.token);
      assert.equal(view.status,price===700?"converted":"refund_due");assert.equal(view.price_sats,price===700?700:1000);
      assert.equal(view.quoted_price_sats,1000);assert.equal(view.address,one.quote.address);
      assert.equal((yield* store.operatorStatus()).seller.exposure_limit_sats,price===700?10000:20000);
    }));
  }
});
test("K24: reservation refuses new invoices and unheld acquisition while preserving an active buyer and fulfillment",async(t)=>{
  const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);const one=yield* invoice(store);
    yield* change(store,{action:"reservation",handle:"n0@space",reserved:true});
    const next=yield* store.request({handle:"n0@space",script_pubkey:script});
    yield* rejection(()=>run(store.quote(next.token)),/unavailable/);assert.equal(f.node.draws,1);
    f.node.outputs=[payment(1)];assert.equal((yield* store.order(one.token)).status,"converted");
    yield* store.beginIssuance("o1");yield* change(store,{action:"reservation",handle:"n0@space",reserved:false});
    yield* rejection(()=>run(store.quote(next.token)),/taken/);assert.equal((yield* store.order(one.token)).status,"issuing");
  }));
  const g=fixture(t);await use(g,store=>Effect.gen(function*(){yield* setup(store);
    for(let i=0;i<2;i++){const old=yield* invoice(store);yield* store.cancel(old.token);}
    const unheld=yield* invoice(store);assert.equal(unheld.quote.pay_first,true);
    yield* change(store,{action:"reservation",handle:"n0@space",reserved:true});
    const view=yield* store.order(unheld.token);assert.equal(view.payment_request_open,false);assert.equal(view.address,unheld.quote.address);
  }));
});
test("K25: withdrawal preserves the six-block hold extension and permanently restricts expired invoice acquisition",async(t)=>{
  const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);const old=yield* invoice(store);
    f.node.now=100;f.node.outputs=[payment(1,100,0)];yield* store.observe();
    yield* change(store,{action:"withdrawal",handle:"n0@space",withdrawn:true});
    f.node.now=900;f.node.tip=16;assert.notEqual((yield* store.order(old.token)).hold_expires_at,null);
    f.node.now=901;f.node.tip=17;f.node.outputs=[];assert.equal((yield* store.order(old.token)).hold_expires_at,null);
    yield* change(store,{action:"withdrawal",handle:"n0@space",withdrawn:false});
    f.node.outputs=[{...payment(1),outpoint:"later-payment"}];assert.equal((yield* store.order(old.token)).status,"refund_due");
    const fresh=yield* invoice(store);assert.notEqual(fresh.quote.address,old.quote.address);
  }));
});
test("K26: a withdraw-reopen cycle before expiry never revives the old invoice even when the name is free",async(t)=>{
  const f=fixture(t);let token="";
  await use(f,store=>Effect.gen(function*(){yield* setup(store);token=(yield* invoice(store)).token;
    yield* change(store,{action:"withdrawal",handle:"n0@space",withdrawn:true});
    yield* change(store,{action:"withdrawal",handle:"n0@space",withdrawn:false});f.node.now=900;yield* store.observe();
  }));
  await use(f,store=>Effect.gen(function*(){f.node.outputs=[payment(1)];assert.equal((yield* store.order(token)).status,"refund_due");
    assert.equal((yield* invoice(store)).quote.acknowledged,true);
  }));
});
test("K27: existing pay-first invoices retain the initial window but withdrawal blocks acquisition at exact expiry",async(t)=>{
  for(const at of [899,900]){const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);
    for(let i=0;i<2;i++){const old=yield* invoice(store);yield* store.cancel(old.token);}
    const one=yield* invoice(store);assert.equal(one.quote.pay_first,true);
    yield* change(store,{action:"withdrawal",handle:"n0@space",withdrawn:true});
    yield* change(store,{action:"withdrawal",handle:"n0@space",withdrawn:false});
    f.node.now=at;f.node.outputs=[payment(3)];assert.equal((yield* store.order(one.token)).status,at===899?"converted":"refund_due");
  }));}
});
test("K28: per-space pauses isolate admission and preserve existing invoices while global admission and review limits remain shared",async(t)=>{
  const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);const old=yield* invoice(store);
    yield* change(store,{action:"space",space:"other"});yield* change(store,{action:"listing",handle:"n0@other",price_sats:1000});
    yield* change(store,{action:"pause",space:"space",paused:true});
    yield* rejection(()=>run(invoice(store,1)),/paused/);
    const other=yield* store.request({handle:"n0@other",script_pubkey:script});assert.equal((yield* store.quote(other.token)).acknowledged,true);
    f.node.outputs=[payment(1)];assert.equal((yield* store.order(old.token)).status,"converted");
    const catalog=yield* store.catalog();assert.equal(catalog.listings.find(n=>n.handle==="n1@space")!.available,false);
    yield* store.pause(true);assert.equal((yield* store.operatorStatus()).paused,true);
  }));
});
test("K29: journal-only restore forces global pause and preserves per-space policy, admission counters and invoice restrictions",async(t)=>{
  const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);yield* invoice(store);
    yield* change(store,{action:"pause",space:"space",paused:true});yield* change(store,{action:"reservation",handle:"n1@space",reserved:true});
    yield* change(store,{action:"withdrawal",handle:"n0@space",withdrawn:true});
    yield* change(store,{action:"admission",window_seconds:600,maximum_requests:20,maximum_orders:100});
  }));
  const target={...f.config,database:join(f.root,"restored.db")};
  await run(Effect.scoped(restoreApplication(target)));const restored=await recovered(target);
  assert.equal(restored.state.settings.paused,true);assert.equal(restored.state.spaces[0]!.paused,true);
  assert.equal(restored.state.namePolicies.find(n=>n.handle==="n1@space")!.reserved,true);
  assert.equal(restored.state.withdrawals[0]!.order,"o1");assert.equal(restored.state.seller.requestWindow.created,1);
  assert.equal(restored.state.seller.configured,true);
});
test("K30: anonymous creation is aggregate and admitted repeated nominations receive fresh links without script claims",async(t)=>{
  const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);
    yield* change(store,{action:"admission",window_seconds:600,maximum_requests:2,maximum_orders:10});
    const a=yield* store.request({handle:"n0@space",script_pubkey:script});const b=yield* store.request({handle:"n1@space",script_pubkey:script});
    assert.notEqual(a.token,b.token);yield* rejection(()=>run(store.request({handle:"n2@space",script_pubkey:script})),/request rate/);
    assert.equal((yield* store.order(a.token)).address,null);assert.equal((yield* store.order(b.token)).address,null);
    f.node.now=600;const c=yield* store.request({handle:"n0@space",script_pubkey:script});assert.notEqual(c.token,a.token);assert.equal(f.node.draws,0);
  }));
});
test("K31: request quota and retained-order capacity survive restart and refusals consume no sequence or wallet destination",async(t)=>{
  const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);
    yield* change(store,{action:"admission",window_seconds:600,maximum_requests:2,maximum_orders:2});yield* store.request({handle:"n0@space",script_pubkey:script});
    yield* store.request({handle:"n1@space",script_pubkey:script});
  }));
  await use(f,store=>Effect.gen(function*(){f.node.now=1200;yield* rejection(()=>run(store.request({handle:"n2@space",script_pubkey:script})),/capacity/);
    assert.equal((yield* store.operatorStatus()).seller.retained_orders,2);assert.deepEqual((yield* store.inspectionOrders()).orders.map(o=>o.oid),["o1","o2"]);assert.equal(f.node.draws,0);
  }));
});
test("K32: startup and journal-only recovery reconcile two signed refund groups without sending and retain exact attended retries",async(t)=>{
  const f=sendingFixture(t);let firstToken="",secondToken="",secondGroup="",txid="";
  await use(f,store=>Effect.gen(function*(){
    const first=yield* Effect.promise(()=>settledRefund(store,f));firstToken=first.token;f.senderState.loseReply=true;
    yield* store.broadcastOperatorRefund(first.group.id,first.group.txid!);
    f.observations.set(first.group.txid!,{txid:first.group.txid!,seen:"mined",confirmations:6,blockHash:tipHash,inputsAvailable:false,conflicts:[]});
    yield* store.observe();const second=yield* invoice(store,1);secondToken=second.token;
    f.node.outputs.push({...payment(2,1000,6),outpoint:"2".repeat(64)+":0"});yield* store.setRefundDestination(second.token,"buyer-refund");yield* store.cancel(second.token);
    const group=yield* store.prepareOperatorRefund("o2","cancellation","buyer");secondGroup=group.id;txid=group.txid!;
    f.senderState.failure=true;yield* store.broadcastOperatorRefund(group.id,txid);assert.equal(f.sent.length,2);
  }));
  await use(f,store=>Effect.gen(function*(){
    assert.equal(f.sent.length,2);assert.equal(f.senderState.builds,2);
    assert.equal((yield* store.order(firstToken)).refunded_sats,10000);assert.equal((yield* store.order(secondToken)).reserved_refund_sats,1000);
    const report=yield* store.operatorStatus();assert.deepEqual(report.pending_refund_rebroadcast,[{group:secondGroup,txid}]);assert.equal(f.sent.length,2);
    yield* rejection(()=>run(store.broadcastOperatorRefund(secondGroup,"f".repeat(64))),/changed/);assert.equal(f.sent.length,2);
    f.senderState.failure=false;yield* store.broadcastOperatorRefund(secondGroup,txid);assert.equal(f.sent.length,3);assert.deepEqual(f.sent[1],f.sent[2]);
  }));
  const target={...f.config,database:join(f.root,"restored.db")};
  await run(Effect.scoped(restoreApplication(target)));
  const report=await run(Effect.scoped(SalesStore.inspectRecovery(target,f.adapters)));
  assert.equal(report.refunds.groups,2);assert.equal(report.refunds.attempted,2);assert.equal(f.sent.length,3);assert.equal(f.senderState.builds,2);
});
test("K33: seller edits preserve issuing ownership, addresses and immutable bindings and malformed duplicate metadata refuses",async(t)=>{
  const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);const one=yield* invoice(store);f.node.outputs=[payment(1)];yield* store.beginIssuance("o1");
    yield* change(store,{action:"reservation",handle:"n0@space",reserved:true});yield* change(store,{action:"withdrawal",handle:"n0@space",withdrawn:true});
    yield* change(store,{action:"withdrawal",handle:"n0@space",withdrawn:false});yield* change(store,{action:"listing",handle:"n0@space",price_sats:3000});
    const view=yield* store.order(one.token);assert.equal(view.status,"issuing");assert.equal(view.price_sats,1000);assert.equal(view.address,one.quote.address);assert.equal(f.node.draws,1);
  }));
  const target={...f.config,database:join(f.root,"restored.db")};
  await run(Effect.scoped(restoreApplication(target)));const saved=await recovered(target);
  const records=encode(saved.state),refunds=configuration({version:1,policy:f.config.refundPolicy,merchantDestinations:[]});
  const duplicate=records.find(r=>r.kind==="name_policy")!;assert.throws(()=>decode([...records,duplicate],f.config.riskBudgetSats,refunds),/duplicate/);
  const broken=structuredClone(records);broken.find(r=>r.kind==="space_policy")!.key="foreign";assert.throws(()=>decode(broken,f.config.riskBudgetSats,refunds),/identity/);
  assert.throws(()=>decode(records.filter(r=>r.kind!=="seller_settings"),f.config.riskBudgetSats,refunds),/missing seller settings/);
});
test("K34: exact funded owner authorization bypasses only reservation and retries never redisclose bearer links or allocate twice",async(t)=>{
  const f=fixture(t);let original:ReturnType<typeof ownerBody>|undefined;let ownerId="",link="";
  function ownerBody(review:string){return{operation:"a".repeat(32),handle:"n0@space",script_pubkey:script,confirm:"n0@space",review};}
  await use(f,store=>Effect.gen(function*(){yield* setup(store);yield* change(store,{action:"reservation",handle:"n0@space",reserved:true});
    const preview=yield* store.seller.ownerPreview({handle:"n0@space",script_pubkey:script});original=ownerBody(preview.review);
    const result=yield* store.seller.ownerInvoice(original);assert.equal(result.created,true);assert.equal(result.invoice!.price_sats,1000);ownerId=result.order;link=result.order_link!;
    assert.match(link,/^\/o\/[A-Za-z0-9_-]{32}$/);assert.equal(f.node.draws,1);
    yield* rejection(()=>run(store.beginIssuance(ownerId)),/not batchable/);
    assert.deepEqual(yield* store.seller.ownerInvoice(original),{created:false,order:ownerId,status:"quoted"});assert.equal(f.node.draws,1);
    yield* rejection(()=>run(store.seller.ownerInvoice({...original!,script_pubkey:"5120"+"2".padStart(64,"0")})),/binding differs/);
    f.node.outputs=[payment(1,1000,2)];yield* rejection(()=>run(store.beginIssuance(ownerId)),/not batchable/);
    f.node.outputs=[payment(1)];yield* store.beginIssuance(ownerId);
  }));
  await use(f,store=>Effect.gen(function*(){const result=yield* store.seller.ownerInvoice(original!);
    assert.deepEqual(result,{created:false,order:ownerId,status:"issuing"});assert.equal(JSON.stringify(result).includes(link),false);assert.equal(f.node.draws,1);
    assert.equal((yield* store.operatorStatus()).seller.names.find(n=>n.handle==="n0@space")!.reserved,true);
  }));
  for(const block of ["pause","space","withdrawal","ownership","exposure"]){const g=fixture(t);
    await use(g,store=>Effect.gen(function*(){yield* setup(store);
      if(block==="ownership")yield* invoice(store);
      if(block==="exposure"){yield* invoice(store,1);g.node.outputs=[payment(1,10000,1)];yield* store.observe();}
      yield* change(store,{action:"reservation",handle:"n0@space",reserved:true});
      if(block==="pause")yield* store.pause(true);if(block==="space")yield* change(store,{action:"pause",space:"space",paused:true});
      if(block==="withdrawal")yield* change(store,{action:"withdrawal",handle:"n0@space",withdrawn:true});
      const preview=yield* store.seller.ownerPreview({handle:"n0@space",script_pubkey:script});const draws=g.node.draws;
      yield* rejection(()=>run(store.seller.ownerInvoice(ownerBody(preview.review))));assert.equal(g.node.draws,draws);
      assert.equal((yield* store.inspectionOrders()).orders.length,block==="ownership"||block==="exposure"?1:0);
    }));
  }
  assert.throws(()=>command({action:"admission",window_seconds:1,maximum_requests:0,maximum_orders:1}));
});
