import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { fixture, invoice, payment, setup, use } from "./application-fixture.ts";
import type { SalesStore } from "../../src/application/store.ts";
function prices(store:SalesStore){return Effect.gen(function*(){yield* setup(store,3);for(let n=0;n<3;n++)yield* store.listName(`n${n}@space`,10_000);});}
const refuses=<A,E>(work:Effect.Effect<A,E>,reason:RegExp)=>Effect.promise(()=>assert.rejects(Effect.runPromise(work),reason));

test("P1: full batchable payment converts its hold to an exclusive fulfillment reservation",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* prices(store);const first=yield* invoice(store);
  f.node.outputs=[payment(1,10_000,3)];yield* store.observe();
  const v=yield* store.order(first.token);assert.equal(v.status,"converted");assert.equal(v.hold_expires_at,null);
  assert.equal((yield* store.inspectionOrder("o1")).price_reserve,10_000);yield* refuses(invoice(store),/taken for now/);
 }));
});
test("P2: distinct outputs to the invoice sum once when both have three confirmations",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* prices(store);const first=yield* invoice(store);
  f.node.outputs=[{...payment(1,6_000,3),outpoint:"a".repeat(64)+":0"},{...payment(1,4_000,3),outpoint:"a".repeat(64)+":1"}];yield* store.observe();
  const v=yield* store.order(first.token);assert.equal(v.status,"converted");assert.equal(v.batchable_sats,10_000);
  yield* store.observe();assert.equal((yield* store.order(first.token)).confirmed_sats,10_000);
 }));
});
test("P3: one shallow contribution cannot convert until the complete price is batchable",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* prices(store);const first=yield* invoice(store);
  f.node.outputs=[payment(1,5_000,4),{...payment(1,5_000,2),outpoint:"mock-second-transaction"}];yield* store.observe();
  assert.equal((yield* store.order(first.token)).status,"quoted");assert.equal((yield* store.order(first.token)).batchable_sats,5_000);
  f.node.tip++;f.node.outputs[1]!.confirmations=3;yield* store.observe();assert.equal((yield* store.order(first.token)).status,"converted");
 }));
});
test("P4: an unmined returned outpoint is not new money and its reservation survives lost depth",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* prices(store);const first=yield* invoice(store);
  f.node.outputs=[payment(1,10_000,3)];yield* store.observe();f.node.outputs=[payment(1,10_000,0)];yield* store.observe();
  let v=yield* store.order(first.token);assert.equal(v.status,"converted");assert.equal(v.batchable_sats,0);assert.equal(v.refund_exposure_sats,0);
  assert(v.reconciling.includes("issuance"));yield* refuses(store.beginIssuance("o1"),/batch|entry|issu/i);yield* refuses(invoice(store),/taken for now/);
  f.node.tip+=2;f.node.outputs=[payment(1,10_000,1)];yield* store.observe();v=yield* store.order(first.token);assert.equal(v.confirmed_sats,10_000);assert.equal(v.batchable_sats,0);assert(v.reconciling.includes("issuance"));
  f.node.tip+=2;f.node.outputs=[payment(1,10_000,3)];yield* store.observe();v=yield* store.order(first.token);assert.equal(v.batchable_sats,10_000);assert(!v.reconciling.includes("issuance"));
 }));
});
test("P5: a short hold becomes refund due and the partial principal is refundable only at settlement",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* prices(store);const first=yield* invoice(store);
  f.node.outputs=[payment(1,4_000,1)];yield* store.observe();f.node.now=901;f.node.tip=17;yield* store.observe();
  let v=yield* store.order(first.token);assert.equal(v.status,"refund_due");assert.equal(v.refundable_sats,0);
  f.node.outputs=[payment(1,4_000,6)];yield* store.observe();v=yield* store.order(first.token);assert.equal(v.refundable_sats,4_000);assert.equal(v.status,"refund_due");
 }));
});
test("P6: a confirmed top-up completes a partial payment before its protected hold ends",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* prices(store);const first=yield* invoice(store);
  f.node.now=100;f.node.outputs=[payment(1,4_000,1)];yield* store.observe();assert.equal((yield* store.order(first.token)).status,"quoted");
  f.node.now=200;f.node.tip=13;f.node.outputs=[payment(1,4_000,4),{...payment(1,6_000,3),outpoint:"mock-six-thousand-top-up"}];
  yield* store.observe();const v=yield* store.order(first.token);assert.equal(v.status,"converted");assert.equal(v.batchable_sats,10_000);
 }));
});
test("P7: replacement that stops paying the invoice leaves it unpaid with no refund after expiry",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* prices(store);const first=yield* invoice(store);
  f.node.now=100;f.node.outputs=[payment(1,10_000,0)];yield* store.observe();f.node.outputs=[];f.node.now=901;f.node.tip=17;yield* store.observe();
  const v=yield* store.order(first.token);assert.equal(v.status,"unpaid");assert.equal(v.refundable_sats,0);assert.equal(v.refund_groups.length,0);yield* invoice(store);
 }));
});
test("P8: mempool hold extension stops after its sixth block and later confirmation uses late-payment rules",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* prices(store);const first=yield* invoice(store);
  f.node.now=100;f.node.outputs=[payment(1,10_000,0)];yield* store.observe();f.node.now=901;f.node.tip=16;
  yield* refuses(invoice(store),/taken for now/);f.node.tip=17;yield* store.observe();assert.equal((yield* store.order(first.token)).status,"unpaid");
  f.node.outputs=[payment(1,10_000,1)];yield* store.observe();const v=yield* store.order(first.token);assert.equal(v.status,"quoted");assert.notEqual(v.hold_expires_at,null);
 }));
});
test("P9: full late payment reacquires a free name and conversion waits for three confirmations",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* prices(store);const first=yield* invoice(store);f.node.now=901;yield* store.observe();
  f.node.outputs=[payment(1,10_000,1)];yield* store.observe();assert.equal((yield* store.order(first.token)).status,"quoted");yield* refuses(invoice(store),/taken for now/);
  f.node.outputs=[payment(1,10_000,3)];yield* store.observe();assert.equal((yield* store.order(first.token)).status,"converted");
 }));
});
test("P10: full late money cannot displace another buyer's hold and becomes refund due",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* prices(store);const first=yield* invoice(store);f.node.now=901;yield* store.observe();const next=yield* invoice(store);
  f.node.outputs=[payment(1,10_000,3)];yield* store.observe();assert.equal((yield* store.order(first.token)).status,"refund_due");assert.equal((yield* store.order(next.token)).status,"quoted");
  f.node.outputs=[payment(1,10_000,6)];assert.equal((yield* store.order(first.token)).refundable_sats,10_000);
 }));
});
test("P11: a price rise makes late original-price funding refund-only",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* prices(store);const first=yield* invoice(store);yield* store.listName("n0@space",12_000);
  f.node.now=901;f.node.outputs=[payment(1,10_000,6)];yield* store.observe();const v=yield* store.order(first.token);assert.equal(v.status,"refund_due");assert.equal(v.refundable_sats,10_000);
 }));
});
test("P12: a price drop uses the lower price at late acquisition and retains the difference as excess",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* prices(store);const first=yield* invoice(store);yield* store.listName("n0@space",8_000);
  f.node.now=901;f.node.outputs=[payment(1,10_000,6)];yield* store.observe();const v=yield* store.order(first.token);
  assert.equal(v.status,"converted");assert.equal(v.price_sats,8_000);assert.equal(v.quoted_price_sats,10_000);assert.equal(v.refundable_sats,2_000);assert.equal((yield* store.inspectionOrder("o1")).price_reserve,8_000);
 }));
});
test("P13: payment loss after conversion keeps the exclusive fulfillment reservation",async (t)=>{
 const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* prices(store);const first=yield* invoice(store);f.node.outputs=[payment(1,10_000,3)];yield* store.observe();
  f.node.outputs=[];f.node.now=100_000;f.node.tip=100;yield* store.observe();const v=yield* store.order(first.token);assert.equal(v.status,"converted");assert.equal((yield* store.inspectionOrder("o1")).price_reserve,10_000);assert(v.reconciling.includes("issuance"));yield* refuses(invoice(store),/taken for now/);
 }));
});
