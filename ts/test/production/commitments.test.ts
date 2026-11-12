import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { DurableStore } from "../../src/storage/store.ts";
import { serveOperator } from "../../src/application/operator-http.ts";
import { use } from "./application-fixture.ts";
import { armed, commitmentFixture } from "./commitment-fixture.ts";
import { credential } from "./entry-http-fixture.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
test("O28: reports require the exact armed binding, immutable transaction and current store tip", async (t) => {
  const f = commitmentFixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* f.prepare(store);
    const report = { ...armed, expectedRevision: 0, observation: f.facts() };
    assert.equal((yield* store.registry.commitments.current(armed)).revision, 0);
    for (const changed of [{ delegate: "e".repeat(64) + ":0" }, { root: "c".repeat(64) }, { oids: ["o1"] },
      { observation: { ...f.facts(), tipHash: "e".repeat(64) } }, { observation: { ...f.facts(), tipHeight: 11 } }])
      yield* Effect.promise(() => assert.rejects(run(store.registry.commitments.observe({ ...report, ...changed })), /binding|tip differs/));
    yield* store.registry.commitments.observe(report);
    yield* Effect.promise(() => assert.rejects(run(store.registry.commitments.observe({ ...report, expectedRevision: 1,
      observation: { ...f.facts(), txid: "f".repeat(64) } })), /transaction identity/));
    yield* Effect.promise(() => assert.rejects(run(store.registry.commitments.current({ ...armed, entry: "9".repeat(32) })), /not armed/));
  }));
});
test("O29: finality uses depth 150, exact root height and a separate 144-block anchor gate", async (t) => {
  const f = commitmentFixture(t); f.node.tip = 200;
  await use(f, store => Effect.gen(function* () {
    yield* f.prepare(store); let expectedRevision = 0;
    for (const [mined, root, anchor, phase, covered] of [[51, 51, 200, "mined", false], [50, 50, 193, "final", false],
      [50, 50, 194, "final", true], [50, null, 200, "mined", false], [null, null, 200, "broadcast", false]] as const) {
      const result = yield* store.registry.commitments.observe({ ...armed, expectedRevision: expectedRevision++, observation: f.facts(mined, root, anchor) });
      assert.equal(result.observation!.phase, phase); assert.equal(result.observation!.covered, covered);
      for (const id of armed.oids) {
        const order = yield* store.inspectionOrder(id); assert.equal(order.status, "issuing"); assert.equal(order.price_reserve, 1000);
      }
    }
  }));
});
test("O30: exact retries are idempotent but stale or concurrent reports cannot overwrite newer reorg facts", async (t) => {
  const f = commitmentFixture(t); f.node.tip = 200;
  await use(f, store => Effect.gen(function* () {
    yield* f.prepare(store);
    const final = { ...armed, expectedRevision: 0, observation: f.facts(50, 50, 200) };
    const saved = yield* store.registry.commitments.observe(final);
    assert.deepEqual(yield* store.registry.commitments.observe({ ...final, oids: [...armed.oids].reverse(),
      observation: Object.fromEntries(Object.entries(final.observation).reverse()) }), saved);
    const candidates = [f.facts(null, null, 200), f.facts(51, 51, 200)];
    const results = yield* Effect.promise(() => Promise.allSettled(candidates.map(observation =>
      run(store.registry.commitments.observe({ ...armed, expectedRevision: 1, observation })))));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    yield* Effect.promise(() => assert.rejects(run(store.registry.commitments.observe(final)), /revision changed/));
    const latest = yield* store.registry.commitments.current(armed); assert.equal(latest.revision, 2);
    assert.notEqual(latest.observation!.phase, "final");
  }));
});
test("O31: unconfirmed observations retain their revision through restart and payment loss never unlocks them", async (t) => {
  const f = commitmentFixture(t); f.node.tip = 200;
  await use(f, store => Effect.gen(function* () {
    yield* f.prepare(store); f.node.outputs = [];
    const append = f.journal.append.bind(f.journal);
    f.journal.append = value => { if (value.changes.some(c => c.kind === "commitment")) f.journal.down = true; return append(value); };
    const receipt = yield* store.registry.commitments.observe({ ...armed, expectedRevision: 0, observation: f.facts(50, 50, 200) });
    assert.equal(receipt.acknowledged, false); assert.equal(receipt.revision, 1); f.journal.append = append;
  }));
  await assert.rejects(use(f, () => Effect.void), /journal outage/);
  f.journal.down = false;
  await use(f, store => Effect.gen(function* () {
    assert.equal((yield* store.inspectionOrder("o1")).status, "issuing");
    const receipt = yield* store.registry.commitments.current(armed); assert.equal(receipt.revision, 1); assert.equal(receipt.acknowledged, true);
    assert.deepEqual((yield* store.inspectionOrder("o1")).reasons, ["post_issuance_deficit"]);
    f.journal.down = true; assert.equal((yield* store.registry.commitments.current(armed)).acknowledged, false);
  }));
});
test("O32: commitment HTTP has exact authenticated shapes and rejects duplicate, escaped and unknown fields", async (t) => {
  const f = commitmentFixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* f.prepare(store); const listener = yield* serveOperator(store, Effect.succeed(credential));
    yield* Effect.promise(async () => {
      const report = { ...armed, expectedRevision: 0, observation: f.facts() }, raw = JSON.stringify(report);
      const send = (body: string, auth = credential) => fetch(listener.url + "/operator/commitments", {
        method: "POST", headers: { Authorization: `Bearer ${auth}` }, body });
      assert.equal((await send(raw, "wrong-token")).status, 401);
      for (const bad of [raw.replace('"expectedRevision":0', '"expectedRevision":0,"expectedRevision":0'),
        raw.replace('"expectedRevision":0', '"expectedRevision":0,"expected\\u0052evision":0'),
        raw.replace('"txid":', '"unknown":'), raw.replace('"tipHeight":10', '"tipHeight":10,"tipHeight":10'),
        raw.replace('"expectedRevision":0', '"expectedRevision":-1')]) assert.equal((await send(bad)).status, 400);
      assert.equal((await send(raw)).status, 200);
      const lookup = await fetch(listener.url + "/operator/commitments/lookup", { method: "POST",
        headers: { Authorization: `Bearer ${credential}` }, body: JSON.stringify(armed) });
      assert.equal((await lookup.json() as { revision: number }).revision, 1);
    });
  }));
});
test("O33: corrupt commitment records refuse startup and preserve evidence", async (t) => {
  for (const kind of ["unarmed", "revision", "height", "version"]) {
    const f = commitmentFixture(t);
    await use(f, store => Effect.gen(function* () { yield* f.prepare(store); }));
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const raw = yield* DurableStore.open(f.config);
      const entry = kind === "unarmed" ? "9".repeat(32) : armed.entry;
      yield* raw.commit([{ kind: "commitment", key: entry, value: { version: kind === "version" ? 2 : 1,
        entry, revision: kind === "revision" ? 0 : 1, observation: f.facts(kind === "height" ? 11 : null) } }]);
    })));
    await assert.rejects(use(f, () => Effect.void), /commitment|integer/);
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const raw = yield* DurableStore.open(f.config); assert((yield* raw.records()).some(r => r.kind === "commitment"));
    })));
  }
});
