import { test } from "node:test";
import assert from "node:assert/strict";
import { CertificateModel } from "../../model/certificate.ts";

test("O37: a verified certificate remains usable on descendant tips and through restart", () => {
  const m = new CertificateModel(); m.observe(true); m.verify(1, "verified-tip");
  assert.equal(CertificateModel.restore(m.snapshot()).read(new Set(["verified-tip", "new-tip"])), true);
});
test("O39: losing a verification checkpoint blocks delayed callbacks even if that checkpoint returns", () => {
  const m = new CertificateModel(); m.observe(true); m.verify(1, "tip"); assert.equal(m.read(new Set(["fork"])), false);
  const r = CertificateModel.restore(m.snapshot()); assert.throws(() => r.verify(1, "tip"), /reverify/);
  r.observe(true); assert.equal(r.read(new Set(["tip"])), false); r.verify(2, "tip"); assert.equal(r.read(new Set(["tip"])), true);
});
test("O40: losing coverage withdraws readiness while preserving the price reservation", () => {
  const m = new CertificateModel(); m.observe(true); m.verify(1, "tip"); m.observe(false);
  assert.equal(m.ready, false); assert.equal(m.priceReserve, 1000);
});
