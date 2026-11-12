import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { serveOperator } from "../../src/application/operator-http.ts";
import { fixture, use } from "./application-fixture.ts";
import { paidPair } from "./entry-fixture.ts";
import { controller, credential, faultProxy } from "./entry-http-fixture.ts";

test("O15: dropped entry replies before or after store commit recover one binding and one controller send", async (t) => {
  for (const loss of ["before", "after"] as const) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidPair(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
      const proxy = yield* Effect.promise(() => faultProxy(t, listener.url)); proxy.control[loss] = true;
      const command = controller(f, proxy.url), first = yield* Effect.promise(() => command("issue"));
      assert.equal(first.state, "checkpointed"); assert.equal(first.sends, 0); assert.match(first.key, /^[a-f0-9]{32}$/);
      assert.equal((yield* store.inspectionOrder("o1")).status, loss === "after" ? "issuing" : "converted");
      const recovered = yield* Effect.promise(() => command("continue"));
      assert.equal(recovered.state, "broadcast"); assert.equal(recovered.sends, 1); assert.equal(recovered.key, first.key);
      assert.equal(proxy.control.upstreamCreates, 1);
      const repeated = yield* Effect.promise(() => command("continue")); assert.equal(repeated.sends, 1);
    }));
  }
});
test("O16: process death at entry, intent or attempted-send boundaries preserves the correct uncertainty", async (t) => {
  for (const mode of ["stop-after-entry", "stop-after-intent", "stop-after-attempt", "stop-after-send"]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidPair(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
      const proxy = yield* Effect.promise(() => faultProxy(t, listener.url)), command = controller(f, proxy.url);
      assert.equal((yield* Effect.promise(() => command(mode))).code, 9);
      const recovered = yield* Effect.promise(() => command("continue"));
      const safeToSend = ["stop-after-entry", "stop-after-intent"].includes(mode);
      assert.equal(recovered.state, safeToSend ? "broadcast" : "broadcast_uncertain");
      assert.equal(recovered.sends, safeToSend || mode === "stop-after-send" ? 1 : 0);
      assert.equal(proxy.control.upstreamCreates, 1);
      assert.equal((yield* store.inspectionOrder("o1")).status, "issuing");
      assert.equal((yield* Effect.promise(() => command("continue"))).sends, recovered.sends);
    }));
  }
});
test("O17: a recovered entry waits through payment loss and refuses unsupported rollback or host restore", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    const tokens = yield* paidPair(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
    const proxy = yield* Effect.promise(() => faultProxy(t, listener.url)); proxy.control.after = true;
    const command = controller(f, proxy.url); yield* Effect.promise(() => command("issue"));
    f.node.outputs[1]!.confirmations = 2;
    const blocked = yield* Effect.promise(() => command("continue")); assert.equal(blocked.sends, 0);
    assert.match(blocked.error!, /not currently confirmed and batchable/);
    assert.match((yield* Effect.promise(() => command("rollback"))).error!, /reconcile the issuance entry/);
    const rebuild = yield* Effect.promise(() => command("rebuild"));
    assert.match(rebuild.error!, /entry release is not implemented/); assert.equal(rebuild.state, "checkpointed");
    assert.match((yield* Effect.promise(() => command("host-restore"))).error!, /whole-host reconciliation is not implemented/);
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.cancel(tokens[0]!)), /once issuing/));
    f.node.outputs[1]!.confirmations = 3;
    const recovered = yield* Effect.promise(() => command("continue")); assert.equal(recovered.sends, 1); assert.equal(recovered.state, "broadcast");
  }));
});
test("O19: an older controller database adopts its journaled entry identity and never assumes an intent was unsent", async (t) => {
  for (const mode of ["stop-after-entry", "stop-after-intent", "issue"]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidPair(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
      const proxy = yield* Effect.promise(() => faultProxy(t, listener.url)), command = controller(f, proxy.url);
      yield* Effect.promise(() => command("prepare"));
      const database = join(f.root, "controller.db"), older = join(f.root, "older-controller.db"); copyFileSync(database, older);
      yield* Effect.promise(() => command(mode)); copyFileSync(older, database);
      if (mode === "stop-after-entry") {
        const bad = new DatabaseSync(database); bad.prepare("update batches set root=? where bid='b1'").run("b".repeat(64)); bad.close();
        yield* Effect.promise(() => assert.rejects(command("continue"), /controller entry binding differs/));
        const retained = new DatabaseSync(database, { readOnly: true });
        try { assert.equal(retained.prepare("select root from batches where bid='b1'").get()!.root, "b".repeat(64)); }
        finally { retained.close(); }
        copyFileSync(older, database);
      }
      const recovered = yield* Effect.promise(() => command("continue"));
      assert.match(recovered.key, /^[0-9a-f]{32}$/); assert.equal(proxy.control.upstreamCreates, 1);
      assert.equal(recovered.sends, mode === "stop-after-intent" ? 0 : 1);
      assert.equal(recovered.state, mode === "stop-after-intent" ? "broadcast_uncertain" : "broadcast");
      assert.equal((yield* Effect.promise(() => command("continue"))).sends, recovered.sends);
    }));
  }
});
