import { test } from "node:test";
import assert from "node:assert/strict";
import { FulfillmentModel } from "../../model/fulfillment.ts";

test("O46: fulfillment requires published verified delivery and retains its first receipt", () => {
  const m = new FulfillmentModel(); assert.throws(() => m.deliver("proof", true), /not delivered/);
  m.published = true; assert.throws(() => m.deliver("proof", false), /not delivered/);
  m.deliver("first", true); m.deliver("later", true); assert.equal(m.history, "first");
});
test("O48: fulfilled ownership and incidents survive reorgs and restart", () => {
  const m = new FulfillmentModel(); m.published = true; m.deliver("proof", true); m.loseCertificate(); m.loseCertificate();
  const r = FulfillmentModel.restore(m.snapshot()); assert.equal(r.state, "fulfilled"); assert.equal(r.priceReserve, 1000);
  assert.equal(r.incidents.length, 1); r.verifyAgain(); assert.equal(r.incidents[0]!.resolved, false);
});
test("O49: incident resolution never restores a certificate or changes fulfillment and reserve", () => {
  const m = new FulfillmentModel(); m.published = true; m.deliver("proof", true); m.loseCertificate(); m.resolve();
  assert.equal(m.certificate, false); assert.equal(m.state, "fulfilled"); assert.equal(m.priceReserve, 1000);
  m.verifyAgain(); m.loseCertificate(); assert.equal(m.incidents.length, 2);
});
