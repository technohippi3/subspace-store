import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { serveOperator } from "../../src/application/operator-http.ts";
import { DurableStore } from "../../src/storage/store.ts";
import { use } from "./application-fixture.ts";
import { certificateFixture } from "./certificate-fixture.ts";
import { armed } from "./commitment-fixture.ts";
import { credential } from "./entry-http-fixture.ts";

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);
function delivery(certificateHash: string, revision = 1) {
  return { ...armed, oid: "o1", revision, certificateHash, relayRoot: armed.root, relayHeight: 50, proofHash: "e".repeat(64) };
}
test("O46: verified delivery is bound, durable and idempotent with immutable first-delivery evidence", async (t) => {
  const f = certificateFixture(t); let token = "";
  await use(f, store => Effect.gen(function* () {
    token = (yield* f.prepare(store))[0]!; const cert = yield* store.registry.certificates.accept(f.packet());
    const receipt = yield* store.registry.deliveries.fulfill(delivery(cert.hash)); assert.equal(receipt.acknowledged, true);
    assert.deepEqual(yield* store.registry.deliveries.fulfill({ ...delivery(cert.hash), proofHash: "f".repeat(64) }), receipt);
    const order = yield* store.inspectionOrder("o1"); assert.equal(order.status, "fulfilled"); assert.equal(order.price_reserve, 1000);
    assert.equal(order.fulfillment!.proofHash, "e".repeat(64));
    yield* Effect.promise(() => assert.rejects(run(store.cancel(token)), /once issuing/));
    assert.deepEqual(yield* store.certificate(token), f.message);
  }));
  await use(f, store => Effect.gen(function* () { assert.equal((yield* store.order(token)).status, "fulfilled"); }));
});
test("O47: missing readiness, changed certificate, stale revision and immature relay roots cannot fulfill", async (t) => {
  const f = certificateFixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* f.prepare(store);
    assert.equal((yield* store.registry.deliveries.status({ ...armed, oid: "o1" })).acknowledged, false);
    yield* Effect.promise(() => assert.rejects(run(store.registry.deliveries.fulfill(delivery("a".repeat(64)))), /certificate/));
    const cert = yield* store.registry.certificates.accept(f.packet());
    for (const bad of [{ certificateHash: "f".repeat(64) }, { revision: 2 }, { oid: "o3" },
      { relayRoot: "c".repeat(64) }, { relayHeight: 100 }, { proofHash: "invalid" }, { delegate: "f".repeat(64) + ":0" }])
      yield* Effect.promise(() => assert.rejects(run(store.registry.deliveries.fulfill({ ...delivery(cert.hash), ...bad }))));
    assert.equal((yield* store.inspectionOrder("o1")).status, "ready");
  }));
});
test("O48: fulfilled reorg recovery is sticky, alerts once, and re-verification does not close its incident", async (t) => {
  const f = certificateFixture(t); let token = "";
  await use(f, store => Effect.gen(function* () {
    token = (yield* f.prepare(store))[0]!; const cert = yield* store.registry.certificates.accept(f.packet());
    yield* store.registry.deliveries.fulfill(delivery(cert.hash)); f.chain.hash = "c".repeat(64); f.node.outputs = [];
    for (let i = 0; i < 2; i++) {
      const view = yield* store.order(token); assert.equal(view.status, "fulfilled"); assert.equal(view.certificate_available, false);
      assert.equal(view.recovery_incident!.open, true); assert.deepEqual(view.reconciling, ["post_issuance_deficit"]);
    }
    assert.equal((yield* store.operatorStatus()).alerts.filter(a => a.kind === "recovery_incident").length, 1);
    assert.equal((yield* store.inspectionOrder("o1")).price_reserve, 1000);
  }));
  f.chain.hash = "b".repeat(64);
  await use(f, store => Effect.gen(function* () {
    yield* store.registry.commitments.observe({ ...armed, expectedRevision: 1, observation: f.facts(50, 50, 210) });
    yield* store.registry.certificates.accept(f.packet("o1", 2));
    const view = yield* store.order(token); assert.equal(view.status, "fulfilled"); assert.equal(view.certificate_available, true);
    assert.equal(view.recovery_incident!.open, true);
  }));
});
test("O49: incident resolution is journaled and idempotent and never restores certificates or changes accounting", async (t) => {
  const f = certificateFixture(t);
  await use(f, store => Effect.gen(function* () {
    const token = (yield* f.prepare(store))[0]!, cert = yield* store.registry.certificates.accept(f.packet());
    yield* store.registry.deliveries.fulfill(delivery(cert.hash)); f.chain.hash = "c".repeat(64); yield* store.order(token);
    const before = yield* store.inspectionOrder("o1"); f.journal.down = true;
    assert.equal((yield* store.registry.deliveries.resolve({ incident: 1, resolution: "operator reviewed recovery" })).acknowledged, false);
    assert.equal((yield* store.order(token)).recovery_incident!.open, true); f.journal.down = false;
    assert.equal((yield* store.registry.deliveries.resolve({ incident: 1, resolution: "operator reviewed recovery" })).acknowledged, true);
    const view = yield* store.order(token), after = yield* store.inspectionOrder("o1");
    assert.equal(view.recovery_incident!.open, false); assert.equal(view.certificate_available, false);
    assert.equal(after.status, before.status); assert.equal(after.price_reserve, before.price_reserve);
    assert.equal(after.refunded_total, before.refunded_total); assert.equal(after.reserved, before.reserved);
    yield* Effect.promise(() => assert.rejects(run(store.registry.deliveries.resolve({ incident: 1, resolution: "different" })), /another resolution/));
  }));
});
test("O50: unacknowledged fulfillment never reports a final sale and recovers without another fulfillment record", async (t) => {
  const f = certificateFixture(t); let token = "";
  await use(f, store => Effect.gen(function* () {
    token = (yield* f.prepare(store))[0]!; const cert = yield* store.registry.certificates.accept(f.packet());
    const append = f.journal.append.bind(f.journal);
    f.journal.append = value => { if (value.changes.some(c => c.kind === "fulfillment")) f.journal.down = true; return append(value); };
    assert.equal((yield* store.registry.deliveries.fulfill(delivery(cert.hash))).acknowledged, false);
    assert.notEqual((yield* store.order(token)).status, "fulfilled"); f.journal.append = append;
  }));
  f.journal.down = false;
  await use(f, store => Effect.gen(function* () {
    const status = yield* store.registry.deliveries.status({ ...armed, oid: "o1" });
    assert.equal(status.fulfilled, true); assert.equal(status.acknowledged, true);
    yield* store.registry.deliveries.fulfill(delivery(status.certificateHash!));
    assert.equal((yield* store.order(token)).status, "fulfilled");
  }));
});
test("O51: fulfillment and incident HTTP enforce authenticated exact fields and sanitized buyer incident views", async (t) => {
  const f = certificateFixture(t);
  await use(f, store => Effect.gen(function* () {
    const token = (yield* f.prepare(store))[0]!, cert = yield* store.registry.certificates.accept(f.packet());
    const listener = yield* serveOperator(store, Effect.succeed(credential));
    yield* Effect.promise(async () => {
      const raw = JSON.stringify(delivery(cert.hash));
      const post = (path: string, body: string, auth = credential) => fetch(listener.url + path, { method: "POST", headers: { Authorization: `Bearer ${auth}` }, body });
      assert.equal((await post("/operator/fulfillments", raw, "wrong")).status, 401);
      for (const body of [raw.replace('"revision":1', '"revision":1,"revision":1'), raw.replace('"proofHash":', '"unknown":'),
        raw.replace('"oid":', '"o\\u0069d":')]) assert.equal((await post("/operator/fulfillments", body)).status, 400);
      assert.equal((await post("/operator/fulfillments", raw)).status, 200);
      assert.equal((await post("/operator/incidents/resolve", '{"incident":1,"incident":1}')).status, 400);
    });
    f.chain.hash = "c".repeat(64); const incident = (yield* store.order(token)).recovery_incident!;
    assert.deepEqual(Object.keys(incident).sort(), ["open", "reasons", "resolution"]);
  }));
});
test("O52: corrupt fulfillment or recovery incident records refuse startup and retain evidence", async (t) => {
  for (const fault of ["version", "depth", "entry", "incident", "missing-incident"]) {
    const f = certificateFixture(t);
    await use(f, store => Effect.gen(function* () {
      const token = (yield* f.prepare(store))[0]!, cert = yield* store.registry.certificates.accept(f.packet());
      yield* store.registry.deliveries.fulfill(delivery(cert.hash));
      if (fault !== "missing-incident") { f.chain.hash = "c".repeat(64); yield* store.order(token); }
    }));
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const raw = yield* DurableStore.open(f.config), kind = fault === "incident" ? "recovery_incident" : fault === "missing-incident" ? "certificate" : "fulfillment", key = fault === "incident" ? "1" : "o1";
      const value = (yield* raw.get(kind, key))!.value as { [k: string]: import("../../src/storage/codec.ts").Json };
      if (fault === "version") value.version = 2; if (fault === "depth") value.relayHeight = 209;
      if (fault === "entry") value.entry = "9".repeat(32); if (fault === "incident") value.oid = "o2";
      if (fault === "missing-incident") { value.valid = false; value.blockedThrough = 1; }
      yield* raw.commit([{ kind, key, value }]);
    })));
    await assert.rejects(use(f, () => Effect.void), /fulfillment|incident/);
    await Effect.runPromise(Effect.scoped(DurableStore.open(f.config)));
  }
});
