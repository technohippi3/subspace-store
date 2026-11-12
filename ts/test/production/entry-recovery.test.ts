import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { DurableStore } from "../../src/storage/store.ts";
import { serveOperator } from "../../src/application/operator-http.ts";
import { fixture, use } from "./application-fixture.ts";
import { entry, paidPair } from "./entry-fixture.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
test("O12: exact bound-entry retries acknowledge one atomic binding across restart", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidPair(store, f); assert.deepEqual(yield* store.registry.entries.find(entry), { found: false });
    const entered = yield* store.registry.entries.enter({ ...entry, oids: ["o2", "o1"] });
    assert.equal(entered.acknowledged, true); assert.deepEqual(entered.oids, entry.oids);
  }));
  await use(f, store => Effect.gen(function* () {
    const found = yield* store.registry.entries.find(entry); assert.equal(found.found, true);
    assert.deepEqual(yield* store.registry.entries.enter(entry), found);
    const db = new DatabaseSync(f.config.database, { readOnly: true });
    try { assert.equal(db.prepare("select count(*) as n from records where kind='issuance_entry'").get()!.n, 1); }
    finally { db.close(); }
    assert.equal((yield* store.inspectionOrder("o1")).status, "issuing");
  }));
});
test("O13: a bound identity rejects different roots, subsets, extra members and foreign anonymous locks", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidPair(store, f);
    const token = "mock-bound-request-credential".padEnd(48, "x"), listener = yield* serveOperator(store, Effect.succeed(token));
    yield* Effect.promise(async () => {
      for (const payload of [JSON.stringify({ ...entry, extra: true }),
        `{"entry":"${entry.entry}","entry":"${entry.entry}","oids":["o1","o2"]}`,
        JSON.stringify({ ...entry, oids: ["o1", "o1"] }), JSON.stringify({ ...entry, root: "short" })]) {
        const response = await fetch(listener.url + "/operator/issuance-entries", {
          method: "POST", headers: { Authorization: `Bearer ${token}` }, body: payload });
        assert.equal(response.status, 400);
      }
      const response = await fetch(listener.url + "/operator/issuance-entries", { method: "POST",
        headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ root: entry.root, oids: entry.oids, entry: entry.entry }) });
      assert.equal(response.status, 200);
    });
    for (const bad of [{ ...entry, root: "b".repeat(64) }, { ...entry, oids: ["o1"] }, { ...entry, oids: ["o1", "o2", "o3"] }]) {
      yield* Effect.promise(() => assert.rejects(run(store.registry.entries.enter(bad)), /another root or member/));
      yield* Effect.promise(() => assert.rejects(run(store.registry.entries.find(bad)), /another root or member/));
    }
    yield* Effect.promise(() => assert.rejects(run(store.registry.entries.enter({ ...entry, entry: "2".repeat(32) })), /not batchable/));
    assert.equal((yield* store.registry.entries.find(entry)).found, true);
  }));
  const other = fixture(t);
  await use(other, store => Effect.gen(function* () {
    yield* paidPair(store, other); yield* store.registry.markIssuing(["o1", "o2"]);
    yield* Effect.promise(() => assert.rejects(run(store.registry.entries.enter(entry)), /not batchable/));
    assert.deepEqual(yield* store.registry.entries.find(entry), { found: false });
  }));
});
test("O14: journal loss and restart never turn an unacknowledged bound entry into missing or free orders", async (t) => {
  const f = fixture(t); let token = "";
  await use(f, store => Effect.gen(function* () {
    token = (yield* paidPair(store, f))[0]!; f.journal.down = true;
    assert.equal((yield* store.registry.entries.enter(entry)).acknowledged, false);
    const found = yield* store.registry.entries.find(entry); assert.equal(found.found, true);
    if (found.found) assert.equal(found.acknowledged, false);
    yield* Effect.promise(() => assert.rejects(run(store.cancel(token)), /once issuing/));
  }));
  f.journal.down = false;
  await use(f, store => Effect.gen(function* () {
    assert.equal((yield* store.registry.entries.enter(entry)).acknowledged, true);
    f.journal.down = true; const found = yield* store.registry.entries.find(entry);
    assert.equal(found.found, true); if (found.found) assert.equal(found.acknowledged, false);
    f.journal.down = false;
    yield* Effect.promise(() => assert.rejects(run(store.cancel(token)), /once issuing/));
  }));
});
test("O18: invalid stored entry versions or immutable member bindings refuse startup and retain evidence", async (t) => {
  for (const change of ["version", "root", "binding", "missing"]) {
    const f = fixture(t); await use(f, store => Effect.gen(function* () { yield* paidPair(store, f); yield* store.registry.entries.enter(entry); }));
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const raw = yield* DurableStore.open(f.config), record = yield* raw.get("issuance_entry", entry.entry);
      const value = structuredClone(record!.value) as { version: number; root: string; bindings: { id: string; handle: string; recipient: string }[] };
      if (change === "version") value.version = 2;
      if (change === "root") value.root = "not-a-root";
      if (change === "binding") value.bindings[0]!.recipient = "5120" + "4".padStart(64, "0");
      if (change === "missing") value.bindings[0]!.id = "o999";
      yield* raw.commit([{ kind: "issuance_entry", key: entry.entry, value }]);
    })));
    await assert.rejects(use(f, () => Effect.void), /issuance entry|invalid batch members/);
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const raw = yield* DurableStore.open(f.config); assert(yield* raw.get("issuance_entry", entry.entry));
    })));
  }
});
