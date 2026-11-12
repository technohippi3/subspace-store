import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { DurableStore } from "../../src/storage/store.ts";
import { fixture, use } from "./application-fixture.ts";
import { entry, paidPair } from "./entry-fixture.ts";

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);
const delegate = "d".repeat(64) + ":0";
test("O20: closure releases its own orders atomically and retries never revive a cancelled order", async (t) => {
  const f = fixture(t); let token = "", address: string | null = null;
  await use(f, store => Effect.gen(function* () {
    token = (yield* paidPair(store, f))[0]!; address = (yield* store.order(token)).address;
    yield* store.registry.setPending(entry.oids); yield* store.registry.entries.enter(entry);
    assert.equal((yield* store.registry.entries.close(entry)).phase, "closed");
    assert.deepEqual((yield* store.registry.pendingFor("@space")).handles, []);
    for (const id of entry.oids) { const o = yield* store.inspectionOrder(id); assert.equal(o.status, "converted"); assert.equal(o.price_reserve, 1000); }
    assert.equal((yield* store.cancel(token)).cancellation, "final");
    assert.equal((yield* store.registry.entries.enter(entry)).phase, "closed");
  }));
  await use(f, store => Effect.gen(function* () {
    yield* store.registry.entries.close(entry);
    assert.equal((yield* store.registry.entries.enter(entry)).phase, "closed");
    assert.equal((yield* store.order(token)).status, "cancelled"); assert.equal((yield* store.order(token)).address, address);
    yield* store.registry.entries.enter({ ...entry, entry: "2".repeat(32), root: "b".repeat(64), oids: ["o2"] });
    yield* store.registry.entries.close(entry);
    assert.equal((yield* store.inspectionOrder("o2")).status, "issuing");
    assert.equal((yield* store.inspectionOrder("o1")).status, "cancelled");
  }));
});
test("O21: absent-entry closure prevents late creation and does not unlock another entry", async (t) => {
  const f = fixture(t), absent = { ...entry, entry: "2".repeat(32), root: "b".repeat(64) };
  await use(f, store => Effect.gen(function* () {
    yield* paidPair(store, f); yield* store.registry.entries.enter(entry);
    assert.equal((yield* store.registry.entries.close(absent)).phase, "closed");
    assert.equal((yield* store.registry.entries.enter(absent)).phase, "closed");
    assert.equal((yield* store.inspectionOrder("o1")).status, "issuing");
    yield* Effect.promise(() => assert.rejects(run(store.registry.entries.close({ ...absent, root: "c".repeat(64) })), /another root/));
  }));
  await use(f, store => Effect.gen(function* () {
    const closed = yield* store.registry.entries.find(absent); assert.equal(closed.found, true);
    if (closed.found) assert.equal(closed.phase, "closed");
    assert.equal((yield* store.inspectionOrder("o1")).status, "issuing");
  }));
});
test("O22: concurrent close and arm grant exactly one outcome and permission is never issued twice", async (t) => {
  for (const closeFirst of [true, false]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidPair(store, f); yield* store.registry.entries.enter(entry);
      const work: Effect.Effect<unknown, unknown>[] = [store.registry.entries.close(entry), store.registry.entries.arm({ ...entry, delegate })];
      if (!closeFirst) work.reverse();
      const result = yield* Effect.promise(() => Promise.allSettled(work.map(e => run(e))));
      assert.equal(result.filter(r => r.status === "fulfilled").length, 1);
      const final = yield* store.registry.entries.find(entry); assert(final.found);
      assert.equal(final.phase, closeFirst ? "closed" : "armed");
      if (!closeFirst) {
        assert.equal((yield* store.registry.entries.arm({ ...entry, delegate })).granted, false);
        yield* Effect.promise(() => assert.rejects(run(store.registry.entries.close(entry)), /armed/));
        yield* Effect.promise(() => assert.rejects(run(store.registry.entries.arm({ ...entry, delegate: "e".repeat(64) + ":0" })), /another delegate/));
      }
    }));
  }
});
test("O23: unacknowledged closure and permission survive restart without manufacturing another grant", async (t) => {
  for (const permission of [false, true]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidPair(store, f); yield* store.registry.entries.enter(entry);
      const append = f.journal.append.bind(f.journal);
      f.journal.append = value => {
        if (value.changes.some(c => c.kind === (permission ? "entry_arm" : "entry_closure"))) f.journal.down = true;
        return append(value);
      };
      const result = permission ? yield* store.registry.entries.arm({ ...entry, delegate }) : yield* store.registry.entries.close(entry);
      assert.equal(result.acknowledged, false);
      if ("granted" in result) assert.equal(result.granted, false);
      f.journal.append = append;
    }));
    f.journal.down = false;
    await use(f, store => Effect.gen(function* () {
      const found = yield* store.registry.entries.find(entry); assert(found.found); assert.equal(found.acknowledged, true);
      assert.equal(found.phase, permission ? "armed" : "closed");
      if (permission) {
        assert.equal((yield* store.registry.entries.arm({ ...entry, delegate })).granted, false);
        yield* Effect.promise(() => assert.rejects(run(store.registry.entries.close(entry)), /armed/));
      } else assert.equal((yield* store.registry.entries.enter(entry)).phase, "closed");
    }));
  }
});
test("O27: corrupt closure or permission relationships refuse startup without erasing evidence", async (t) => {
  for (const kind of ["version", "mismatch", "both", "delegate"]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () { yield* paidPair(store, f); yield* store.registry.entries.enter(entry); yield* store.registry.entries.arm({ ...entry, delegate }); }));
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const raw = yield* DurableStore.open(f.config);
      const value = { version: kind === "version" ? 2 : 1, id: entry.entry, root: kind === "mismatch" ? "b".repeat(64) : entry.root,
        oids: entry.oids, ...(kind === "both" ? {} : { delegate: kind === "delegate" ? "not-an-outpoint" : delegate }) };
      yield* raw.commit([{ kind: kind === "both" ? "entry_closure" : "entry_arm", key: entry.entry, value }]);
    })));
    await assert.rejects(use(f, () => Effect.void), /entry|delegate/);
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const raw = yield* DurableStore.open(f.config); assert(yield* raw.get(kind === "both" ? "entry_closure" : "entry_arm", entry.entry));
    })));
  }
});
