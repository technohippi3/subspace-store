import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { fixture, invoice, payment, setup, use } from "./application-fixture.ts";
import type { SalesStore } from "../../src/application/store.ts";

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);
function second(store: SalesStore) {
  return Effect.gen(function* () {
    const link = yield* store.request({ handle: "n1@space", script_pubkey: "5120" + "2".padStart(64, "0") });
    yield* store.quote(link.token); return link;
  });
}
test("O5: every member passes before any issuing mark, with strict distinct single-space membership", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store); const two = yield* second(store);
    f.node.outputs = [payment(1), payment(2)]; yield* store.observe();
    assert.equal((yield* store.registry.entry("o1")).batch_entry, true);
    for (const bad of [[], ["o1", "o1"], ["bad"], ["o1", "o999"]])
      yield* Effect.promise(() => assert.rejects(run(store.registry.markIssuing(bad))));
    f.node.outputs[1]!.confirmations = 2;
    yield* Effect.promise(() => assert.rejects(run(store.registry.markIssuing(["o1", "o2"])), /not batchable/));
    assert.equal((yield* store.order(one.token)).status, "converted"); assert.equal((yield* store.order(two.token)).status, "converted");
    f.node.outputs[1]!.confirmations = 3;
    yield* store.listName("remote@other", 1000);
    const remote = yield* store.request({ handle: "remote@other", script_pubkey: "5120" + "4".padStart(64, "0") });
    yield* store.quote(remote.token); f.node.outputs.push(payment(3));
    yield* Effect.promise(() => assert.rejects(run(store.registry.markIssuing(["o1", "o3"])), /one space/));
    const marked = yield* store.registry.markIssuing(["o1", "o2"]); assert.deepEqual(marked.acknowledged, ["o1", "o2"]);
    assert.equal((yield* store.order(one.token)).status, "issuing"); assert.equal((yield* store.order(two.token)).status, "issuing");
    assert.deepEqual(yield* store.registry.entry("o1"), { batch_entry: false, issuing_recheck: true });
    f.node.outputs[0]!.confirmations = 2;
    assert.equal((yield* store.registry.entry("o1")).issuing_recheck, false);
    assert.equal((yield* store.order(one.token)).status, "issuing");
  }));
});
test("O6: unacknowledged issuing marks remain locked through restart and require a live current journal receipt", async (t) => {
  const f = fixture(t); let token = "";
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); token = (yield* invoice(store)).token; yield* second(store);
    f.node.outputs = [payment(1), payment(2)]; yield* store.observe(); f.journal.down = true;
    assert.deepEqual((yield* store.registry.markIssuing(["o1", "o2"])).acknowledged, []);
    assert.equal((yield* store.inspectionOrder("o1")).status, "issuing");
    assert.equal((yield* store.inspectionOrder("o1")).journaled_status, "converted");
    assert.equal((yield* store.registry.journal("o1")).acknowledged, false);
    yield* Effect.promise(() => assert.rejects(run(store.cancel(token)), /once issuing/));
  }));
  f.journal.down = false;
  await use(f, store => Effect.gen(function* () {
    assert.equal((yield* store.registry.journal("o1")).acknowledged, true);
    assert.equal((yield* store.inspectionOrder("o1")).journaled_status, "issuing");
    f.journal.down = true;
    assert.equal((yield* store.registry.journal("o1")).acknowledged, false);
    assert.equal((yield* store.inspectionOrder("o1")).journaled_status, "issuing");
    f.journal.down = false; assert.equal((yield* store.registry.journal("o1")).acknowledged, true);
    yield* Effect.promise(() => assert.rejects(run(store.cancel(token)), /once issuing/));
  }));
});
test("O7: buyer cancellation and multi-member entry serialize without partially locking the other order", async (t) => {
  for (const cancelFirst of [true, false]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* setup(store); const one = yield* invoice(store); const two = yield* second(store);
      f.node.outputs = [payment(1), payment(2)]; yield* store.observe();
      const work = [store.registry.markIssuing(["o1", "o2"]).pipe(Effect.asVoid), store.cancel(one.token).pipe(Effect.asVoid)]; if (cancelFirst) work.reverse();
      const results = yield* Effect.promise(() => Promise.allSettled(work.map(e => run(e))));
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      assert.equal((yield* store.order(one.token)).status, cancelFirst ? "cancelled" : "issuing");
      assert.equal((yield* store.order(two.token)).status, cancelFirst ? "converted" : "issuing");
    }));
  }
});
test("O8: the frozen pending set is durable, exact-space, acknowledged and never an implicit catalog", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); yield* invoice(store); yield* second(store);
    f.node.outputs = [payment(1), payment(2)]; yield* store.observe();
    assert.equal((yield* store.registry.setPending(["o1"])).acknowledged, true);
    assert.deepEqual((yield* store.registry.pendingFor("@space")).handles.map(h => h.handle), ["n0@space"]);
    assert.deepEqual((yield* store.registry.pendingFor("@other")).handles, []);
    for (const bad of [["o1", "o1"], ["o999"]])
      yield* Effect.promise(() => assert.rejects(run(store.registry.setPending(bad))));
    assert.equal((yield* store.registry.pendingFor("@space")).handles.length, 1);
    f.journal.down = true; assert.equal((yield* store.registry.setPending(["o2"])).acknowledged, false);
    assert.deepEqual((yield* store.registry.pendingFor("@space")).handles, []);
  }));
  f.journal.down = false;
  await use(f, store => Effect.gen(function* () {
    assert.deepEqual((yield* store.registry.pendingFor("@space")).handles.map(h => h.handle), ["n1@space"]);
    f.journal.down = true; assert.deepEqual((yield* store.registry.pendingFor("@space")).handles, []);
    f.journal.down = false; yield* store.registry.setPending([]);
    assert.deepEqual((yield* store.registry.pendingFor("@space")).handles, []);
  }));
});
test("V12: a frozen converted recipient conflict blocks both members, alerts once and clears on cancellation", async (t) => {
  const f = fixture(t); let other = "";
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); yield* invoice(store); other = (yield* invoice(store, 1)).token;
    f.node.outputs = [payment(1)]; yield* store.observe(); yield* store.registry.setPending(["o1"]);
    f.node.outputs.push(payment(2)); yield* store.observe();
    for (const id of ["o1", "o2"]) {
      assert.equal((yield* store.registry.entry(id)).batch_entry, false);
      yield* Effect.promise(() => assert.rejects(run(store.registry.markIssuing([id])), /not batchable/));
      yield* Effect.promise(() => assert.rejects(run(store.registry.setPending([id])), /not batchable/));
    }
    assert.deepEqual((yield* store.registry.pendingFor("@space")).handles, []);
    assert.equal((yield* store.operatorStatus()).alerts.filter(a => a.kind === "recipient_conflict").length, 2);
  }));
  await use(f, store => Effect.gen(function* () {
    yield* store.observe(); assert.equal((yield* store.operatorStatus()).alerts.filter(a => a.kind === "recipient_conflict").length, 2);
    yield* store.cancel(other); assert.equal((yield* store.registry.entry("o1")).batch_entry, true);
    assert.equal((yield* store.registry.pendingFor("@space")).handles[0]!.handle, "n0@space");
  }));
});
test("V13: an issuing recipient keeps priority when another already-quoted order converts", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store); yield* invoice(store, 1);
    f.node.outputs = [payment(1)]; yield* store.observe(); yield* store.registry.setPending(["o1"]);
    yield* store.registry.markIssuing(["o1"]); f.node.outputs.push(payment(2)); yield* store.observe();
    assert.equal((yield* store.registry.entry("o1")).issuing_recheck, true);
    const view = yield* store.order(one.token); assert.equal(view.recipient_rejected, false); assert.equal(view.address, one.quote.address);
    assert.equal((yield* store.registry.entry("o2")).batch_entry, false);
    yield* Effect.promise(() => assert.rejects(run(store.registry.markIssuing(["o2"])), /not batchable/));
    assert.deepEqual((yield* store.registry.pendingFor("@space")).handles.map(h => h.handle), ["n0@space"]);
    const alerts = (yield* store.operatorStatus()).alerts.filter(a => a.kind === "recipient_conflict");
    assert.deepEqual(alerts.map(a => a.order), ["o2"]);
  }));
});
