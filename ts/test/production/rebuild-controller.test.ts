import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { serveOperator } from "../../src/application/operator-http.ts";
import { fixture, use } from "./application-fixture.ts";
import { paidPair } from "./entry-fixture.ts";
import { controller, credential, faultProxy } from "./entry-http-fixture.ts";

test("O24: closure outage withholds rollback and never undoes cancellation while the release resumes", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    const tokens = yield* paidPair(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
    const proxy = yield* Effect.promise(() => faultProxy(t, listener.url)), command = controller(f, proxy.url);
    assert.equal((yield* Effect.promise(() => command("stop-after-entry"))).code, 9);
    f.node.outputs[1]!.confirmations = 2;
    proxy.control.beforeClose = () => { f.journal.down = true; };
    const pending = yield* Effect.promise(() => command("continue"));
    assert.equal(pending.state, "releasing"); assert.equal(pending.rollbacks, 0); assert.equal(pending.sends, 0);
    assert.match(pending.error!, /closure not acknowledged/);
    assert.equal((yield* store.cancel(tokens[0]!)).cancellation, "unconfirmed");
    proxy.control.beforeClose = null; f.journal.down = false;
    const recovered = yield* Effect.promise(() => command("continue"));
    assert.equal(recovered.state, "rebuilt"); assert.equal(recovered.error, null); assert.equal(recovered.rollbacks, 1);
    assert.deepEqual(recovered.children, []); assert.equal((yield* store.order(tokens[0]!)).status, "cancelled");
    assert.equal((yield* Effect.promise(() => command("continue"))).rollbacks, 1);
  }));
});
test("O25: lost close/rollback replies and process exits finish one rollback and one successor", async (t) => {
  for (const mode of ["close-before", "close-after", "lose-rollback-answer", "stop-after-rollback", "stop-after-park", "stop-after-completion"]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidPair(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
      const proxy = yield* Effect.promise(() => faultProxy(t, listener.url)), command = controller(f, proxy.url);
      yield* Effect.promise(() => command("stop-after-entry")); f.node.outputs[1]!.confirmations = 2;
      if (mode === "close-before") proxy.control.beforePath = "/operator/issuance-entries/close";
      if (mode === "close-after") proxy.control.afterPath = "/operator/issuance-entries/close";
      yield* Effect.promise(() => command(mode.startsWith("close-") ? "continue" : mode));
      const recovered = yield* Effect.promise(() => command("continue"));
      assert.equal(recovered.error, null, mode); assert.equal(recovered.state, "rebuilt", mode);
      assert.equal(recovered.rollbacks, 1, mode); assert.equal(recovered.sends, 0, mode); assert.deepEqual(recovered.children, ["b2"], mode);
      const repeated = yield* Effect.promise(() => command("continue"));
      assert.deepEqual(repeated.children, ["b2"]); assert.equal(repeated.rollbacks, 1);
    }));
  }
});
test("O26: a stale controller cannot release an armed entry or obtain another broadcast permission", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidPair(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
    const proxy = yield* Effect.promise(() => faultProxy(t, listener.url)), command = controller(f, proxy.url);
    yield* Effect.promise(() => command("stop-after-intent"));
    const db = join(f.root, "controller.db"), journal = join(f.root, "controller-journal", "runner.jsonl");
    const olderDb = join(f.root, "older-controller.db"), olderJournal = join(f.root, "older-controller.jsonl");
    copyFileSync(db, olderDb); copyFileSync(journal, olderJournal);
    const sent = yield* Effect.promise(() => command("continue")); assert.equal(sent.sends, 1);
    copyFileSync(olderDb, db); copyFileSync(olderJournal, journal);
    const refused = yield* Effect.promise(() => command("rollback"));
    assert.match(refused.error!, /armed/); assert.equal(refused.state, "broadcast_uncertain");
    assert.equal(refused.sends, 1); assert.equal(refused.rollbacks, 0);
    for (const id of ["o1", "o2"]) assert.equal((yield* store.inspectionOrder(id)).status, "issuing");
    assert.equal((yield* Effect.promise(() => command("continue"))).sends, 1);
  }));
});

test("Python bound release refuses a foreign armed entry after both controller copies lose its identity", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidPair(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
    const command = controller(f, listener.url);
    yield* Effect.promise(() => command("prepare"));
    const db = join(f.root, "controller.db"), journal = join(f.root, "controller-journal", "runner.jsonl");
    const olderDb = join(f.root, "pre-entry-controller.db"), olderJournal = join(f.root, "pre-entry-controller.jsonl");
    copyFileSync(db, olderDb); copyFileSync(journal, olderJournal);
    assert.equal((yield* Effect.promise(() => command("continue"))).sends, 1);
    copyFileSync(olderDb, db); copyFileSync(olderJournal, journal);
    const refused = yield* Effect.promise(() => command("rollback"));
    assert.match(refused.error!, /foreign issuance/); assert.equal(refused.sends, 1); assert.equal(refused.rollbacks, 0);
    assert.deepEqual(refused.children, []); assert.notEqual(refused.state, "rebuilt");
    assert.equal((yield* store.inspectionOrder("o1")).status, "issuing");
    assert.equal((yield* store.inspectionOrder("o2")).status, "issuing");
  }));
});
