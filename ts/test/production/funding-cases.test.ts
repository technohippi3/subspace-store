import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { sendingFixture } from "./refund-sending-fixture.ts";
import { invoice, payment, setup, use } from "./application-fixture.ts";
import { serveOperator } from "../../src/application/operator-http.ts";
import type { SalesStore } from "../../src/application/store.ts";
import type { TestContext } from "node:test";

const rejects=<A,E>(effect:Effect.Effect<A,E>,reason:RegExp)=>Effect.promise(()=>assert.rejects(Effect.runPromise(effect),reason));
function fixture(t:TestContext){
 const original=sendingFixture(t),f={...original,config:{...original.config,refundPolicy:{...original.config.refundPolicy,buyerFeeCeiling:300,fallbackRate:3000}}};
 f.adapters.refunds={...f.adapters.refunds!,estimateRate:()=>Effect.succeed(3000),build:input=>Effect.sync(()=>{
  const coin=input.orderCoins.find(c=>!input.forbiddenInputs.includes(c.outpoint));assert(coin,"a permitted funding coin is required");
  const change=coin.sats-input.group.charged;assert(change>=0);
  return{txid:(++f.senderState.builds).toString(16).padStart(64,"a"),raw:"00",vbytes:100,
   fee:300,buyerFee:300,merchantFee:0,toBuyer:input.group.charged-300,inputs:[{...coin,owner:"order" as const}],
   outputs:[{...input.destination,sats:input.group.charged-300,role:"buyer" as const},
    ...(change?[{address:"mock-order-change",script:"0014"+"e".repeat(40),sats:change,role:"order_change" as const}]:[])]};
 })};return f;
}
function paid(store:SalesStore,f:ReturnType<typeof fixture>,amount=13_000,depth=6){return Effect.gen(function*(){
 yield* setup(store);yield* store.listName("n0@space",10_000);const link=yield* invoice(store);
 f.node.outputs=[{...payment(1,amount,depth),outpoint:"1".repeat(64)+":0"}];
 yield* store.setRefundDestination(link.token,"mock-buyer-refund");return link;
});}
test("F1: the price reserve limits excess to3000 and an oversized amount is not an accepted operator command",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){const link=yield* paid(store,f);const server=yield* serveOperator(store,Effect.succeed("f".repeat(32)));
  yield* Effect.promise(async()=>{const response=await fetch(server.url+"/operator/orders/o1/refunds",{method:"POST",headers:{Authorization:"Bearer "+"f".repeat(32)},body:JSON.stringify({kind:"excess",cause:"buyer",amount_sats:12_700})});assert.equal(response.status,400);await response.arrayBuffer();});
  assert.equal(f.senderState.builds,0);assert.equal((yield* store.order(link.token)).refundable_sats,3000);
  const g=yield* store.prepareRefund("o1","excess","buyer");assert.equal(g.charged_sats,3000);assert.equal(g.to_buyer_sats,2700);assert.equal(g.fee_sats,300);
  assert.equal((yield* store.inspectionOrder("o1")).price_reserve,10_000);
 }));
});
test("F2: an open excess reservation prevents a second allocation while an operator retry reuses its group",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){const link=yield* paid(store,f);const first=yield* store.prepareOperatorRefund("o1","excess","buyer");
  yield* rejects(store.prepareRefund("o1","excess","buyer"),/no refundable credit/);
  const again=yield* store.prepareOperatorRefund("o1","excess","buyer");assert.equal(again.id,first.id);assert.equal(f.senderState.builds,1);
  const view=yield* store.order(link.token);assert.equal(view.refund_groups.length,1);assert.equal(view.reserved_refund_sats,3000);assert.equal(view.refundable_sats,0);
 }));
});
test("F3: a settled cancellation records principal,buyer output and fee separately",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){const link=yield* paid(store,f,10_000);yield* store.cancel(link.token);
  const group=yield* store.prepareRefund("o1","cancellation","buyer");assert.equal(group.charged_sats,10_000);assert.equal(group.to_buyer_sats,9700);assert.equal(group.fee_sats,300);
  assert.equal(group.buyer_fee_sats,300);assert.equal(group.merchant_fee_sats,0);assert.equal((yield* store.order(link.token)).reserved_refund_sats,10_000);
 }));
});
test("F4: cancellation releases only the price reserve and total refund charges cannot exceed the13000 receipt",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){const link=yield* paid(store,f);const excess=yield* store.prepareRefund("o1","excess","buyer");
  assert.equal(excess.charged_sats,3000);yield* store.cancel(link.token);assert.equal((yield* store.order(link.token)).refundable_sats,10_000);
  f.journal.down=true;const pending=yield* store.prepareRefund("o1","cancellation","buyer");assert.equal(pending.phase,"reserved");assert.equal(pending.charged_sats,10_000);
  const view=yield* store.order(link.token);assert.equal(view.reserved_refund_sats,13_000);assert.equal(view.refundable_sats,0);assert.equal(view.refund_groups.length,2);
  f.journal.down=false;
 }));
});
test("F5:400 sats excess below the estimated fee plus546 cannot become a sendable refund and the minimum is disclosed",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){const link=yield* paid(store,f,10_400);
  const view=yield* store.order(link.token);assert.equal(view.refundable_sats,400);assert.match(view.excess_minimum,/546/);
  yield* rejects(store.prepareRefund("o1","excess","buyer"),/application state validation failed/);
  const pending=(yield* store.order(link.token)).refund_groups;assert.equal(pending.length,1);assert.equal(pending[0]!.phase,"reserved");assert.equal(pending[0]!.txid,null);
  yield* rejects(store.broadcastRefund(pending[0]!.id),/built|ready|transaction/i);assert.equal(f.sent.length,0);
 }));
});
test("N1: three-confirmation full payment can enter issuance before refund settlement",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){const link=yield* paid(store,f,10_000,3);
  let view=yield* store.order(link.token);assert.equal(view.status,"converted");assert.equal(view.settled_sats,0);assert.deepEqual(view.reconciling,[]);
  yield* store.beginIssuance("o1");view=yield* store.order(link.token);assert.equal(view.status,"issuing");assert.deepEqual(view.reconciling,[]);
 }));
});
test("N2: a cancelled three-confirmation receipt is not refundable until six confirmations",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){const link=yield* paid(store,f,10_000,3);yield* store.cancel(link.token);
  assert.equal((yield* store.order(link.token)).refundable_sats,0);yield* rejects(store.prepareRefund("o1","cancellation","buyer"),/no refundable credit/);
  f.node.outputs[0]!.confirmations=6;const group=yield* store.prepareRefund("o1","cancellation","buyer");assert.equal(group.to_buyer_sats,9700);assert.equal(group.fee_sats,300);
 }));
});
test("N3: unsettled excess refuses refund authorization without preventing issuance",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){const link=yield* paid(store,f,13_000,3);
  yield* rejects(store.prepareRefund("o1","excess","buyer"),/no refundable credit/);assert.equal(f.senderState.builds,0);
  yield* store.beginIssuance("o1");assert.equal((yield* store.order(link.token)).status,"issuing");
 }));
});
test("N4: loss of batchable depth blocks batch entry while retaining the converted reservation",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){const link=yield* paid(store,f,10_000,3);f.node.outputs[0]!.confirmations=2;
  const view=yield* store.order(link.token);assert.equal(view.status,"converted");assert(view.reconciling.includes("issuance"));
  yield* rejects(store.beginIssuance("o1"),/batch|entry|issu/i);assert.equal((yield* store.inspectionOrder("o1")).price_reserve,10_000);
 }));
});
