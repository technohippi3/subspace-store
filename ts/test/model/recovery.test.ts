import { test } from "node:test";
import assert from "node:assert/strict";
import { RecoveryModel } from "../../model/recovery.ts";

test("O78: journal-only recovery pauses admission and treats an invoice without durable detection as unknown", () => {
  const model = new RecoveryModel([
    { state: "requested", invoice: false, detection: "none", certificate: false, receipt: null, reserve: 0, incident: false },
    { state: "quoted", invoice: true, detection: "none", certificate: false, receipt: null, reserve: 0, incident: false },
    { state: "quoted", invoice: true, detection: "detected", certificate: false, receipt: null, reserve: 0, incident: false } ]);
  model.prepare(); assert.equal(model.paused,true); assert.deepEqual(model.orders.map(o => o.detection),["none","unknown","detected"]);
  const before = model.snapshot(); model.observe(1,false); model.prepare(); assert.equal(model.snapshot(),before);
  model.observe(1,true); assert.equal(model.orders[1]!.detection,"detected"); assert.equal(model.controllerRequired,true);
});
test("O88: complete matching recovery evidence permits startup while sales and original delivery stay unchanged",()=>{
  const model=new RecoveryModel([{state:"fulfilled",invoice:true,detection:"detected",certificate:false,receipt:"first",reserve:1000,incident:true}]);
  model.prepare();model.complete(true,true,true,true);assert.equal(model.canStart,false);model.finalize(true);
  assert.equal(model.canStart,true);assert.equal(model.paused,true);assert.equal(model.orders[0]!.receipt,"first");assert.equal(model.orders[0]!.reserve,1000);
});
test("O90: partial completion or a missing journal never clears the startup latch",()=>{
  const model=new RecoveryModel([]);model.prepare();assert.throws(()=>model.complete(false,true,true,true));
  model.complete(true,true,true,false);assert.throws(()=>model.finalize(true));assert.equal(model.canStart,false);
  model.complete(true,true,true,true);assert.throws(()=>model.finalize(false));assert.equal(model.canStart,false);
  model.finalize(true);assert.equal(model.canStart,true);
});
test("O82: restore withholds certificates without undoing fulfillment, cancellation, receipt or price reserve", () => {
  const model = new RecoveryModel([
    { state: "ready", invoice: true, detection: "detected", certificate: true, receipt: null, reserve: 1000, incident: false },
    { state: "fulfilled", invoice: true, detection: "detected", certificate: true, receipt: "first", reserve: 1000, incident: false },
    { state: "cancelled", invoice: true, detection: "detected", certificate: false, receipt: null, reserve: 0, incident: false } ]);
  model.prepare(); const before=model.snapshot(); model.prepare(); assert.equal(model.snapshot(),before);
  assert.deepEqual(model.orders.map(o=>o.state),["issuing","fulfilled","cancelled"]);
  assert.deepEqual(model.orders.map(o=>o.reserve),[1000,1000,0]); assert.equal(model.orders[1]!.receipt,"first");
  assert.equal(model.orders[1]!.incident,true); assert(model.orders.every(o=>!o.certificate));
});
