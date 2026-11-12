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
