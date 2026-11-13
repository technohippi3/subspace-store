import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { serveOperator } from "../../src/application/operator-http.ts";
import { BatchDatabase } from "../../src/controller/database.ts";
import { fixture, use } from "./application-fixture.ts";
import { paidPair } from "./entry-fixture.ts";
import { credential } from "./entry-http-fixture.ts";
import { checkpoint, delegate, kernel, local, put, sends, txid, using } from "./controller-port-fixture.ts";

test("O16: TypeScript controller process exits preserve safe entry/intent retries and never repeat an attempted send", async (t) => {
  for (const boundary of ["identity", "entry", "intent", "before-arm", "arm", "send"]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidPair(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
      yield* Effect.promise(async () => {
        const k = kernel(f.root), mode = boundary === "before-arm" ? "stop-before-arm" : `stop-after-${boundary}`;
        const child = (mode: string) => promisify(execFile)(process.execPath,
          ["test/production/controller-port-process.ts", f.root, listener.url, mode], { timeout: 30_000 });
        await assert.rejects(child(mode), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === 9);
        const afterStop = local(k.database), result = JSON.parse((await child("resume")).stdout) as { state: string; attempted: number; entry: string; alerts: { kind: string }[] };
        assert.equal(result.entry, afterStop.entry_key); assert(result.entry);
        const attempted = ["before-arm", "arm", "send"].includes(boundary);
        assert.equal(result.state, attempted ? "broadcast_uncertain" : "broadcast"); assert.equal(result.attempted, 1);
        assert.equal(sends(f.root), !attempted || boundary === "send" ? 1 : 0);
        await child("resume"); assert.equal(sends(f.root), !attempted || boundary === "send" ? 1 : 0);
        if (attempted) assert.equal(result.alerts.filter(alert => alert.kind === "broadcast_uncertain").length, 1);
      });
    }));
  }
});

test("A21: TypeScript controller records interrupted uncertainty and its alert atomically while the journal is down", async (t) => {
  const f = fixture(t), k = kernel(f.root), row = checkpoint({ state: "issuing", entry_key: "1".repeat(32),
    intent: 1, attempted: 0, delegate_in: delegate, fee_rate: 1 });
  put(k.database, { ...row, attempted: 1 }); k.journal.append(row); k.journal.down = true;
  await using(k, controller => Effect.gen(function* () {
    assert.equal((yield* controller.batch("b1")).state, "broadcast_uncertain");
    assert.equal((yield* controller.alerts()).length, 1);
  }));
  k.journal.down = false;
  await using(k, controller => Effect.gen(function* () {
    assert.equal((yield* controller.alerts()).length, 1); assert.equal((yield* controller.batch("b1")).attempted, 1);
  }));
  assert.equal(k.journal.entries().at(-1)!.kind, "batch"); assert.equal(k.calls.broadcasts, 0);
  // Force the alert write itself to fail: SQLite must roll back the state change too.
  const other = fixture(t), failing = kernel(other.root); put(failing.database, { ...row, attempted: 1 }); failing.journal.append(row);
  const admitted = new BatchDatabase(failing.database), db = new DatabaseSync(failing.database);
  db.exec("create trigger refuse_alert before insert on alerts begin select raise(abort, 'simulated alert write failure'); end"); db.close();
  assert.throws(() => admitted.uncertain("b1", "interrupted", "test transaction"), /simulated alert write failure/);
  admitted.close();
  assert.equal(local(failing.database).state, "issuing");
  const inspect = new DatabaseSync(failing.database);
  assert.equal(inspect.prepare("select count(*) as n from alerts").get()!.n, 0);
  inspect.exec("drop trigger refuse_alert"); inspect.close();
  await using(failing, controller => controller.batch("b1"));
});

test("A22: TypeScript controller atomically adopts later acknowledged sent states once without sending", async (t) => {
  const f = fixture(t), k = kernel(f.root);
  const rows = [checkpoint({ state: "issuing", attempted: 1, intent: 1, entry_key: "1".repeat(32), delegate_in: delegate, fee_rate: 1 }),
    checkpoint({ bid: "b2", state: "broadcast_uncertain", attempted: 1, intent: 1, entry_key: "2".repeat(32), delegate_in: delegate, fee_rate: 1 })];
  for (const row of rows) { put(k.database, row); k.journal.append({ ...row, state: "broadcast", txid, raw: "010203", ancestors: "[]" }); }
  for (let i = 0; i < 2; i++) await using(k, controller => Effect.gen(function* () {
    for (const row of rows) { const b = yield* controller.batch(row.bid); assert.equal(b.state, "broadcast"); assert.equal(b.txid, txid); assert.equal(b.raw, "010203"); }
    assert.equal((yield* controller.alerts()).filter(alert => alert.kind === "database_behind_journal").length, 2);
  }));
  assert.equal(k.calls.broadcasts, 0);
});

test("O19: TypeScript controller distinguishes intact unsent intents from older databases adopting newer issuing history", async (t) => {
  for (const state of ["checkpointed", "issuing", "broadcast"] as const) {
    const f = fixture(t), k = kernel(f.root), newer = checkpoint({ state, entry_key: "1".repeat(32),
      ...(state !== "checkpointed" ? { intent: 1, delegate_in: delegate, fee_rate: 1 } : {}),
      ...(state === "broadcast" ? { attempted: 1, txid, raw: "010203" } : {}) });
    k.journal.append(newer);
    await using(k, controller => Effect.gen(function* () {
      const current = yield* controller.batch("b1"); assert.equal(current.entry_key, newer.entry_key);
      assert.equal(current.state, state === "issuing" ? "broadcast_uncertain" : state);
      assert.equal(current.attempted, state === "checkpointed" ? 0 : 1);
      if (state === "issuing") assert.equal((yield* controller.alerts()).filter(alert => alert.kind === "broadcast_uncertain").length, 1);
    }));
    assert.equal(k.calls.broadcasts, 0);
  }
  const f = fixture(t), k = kernel(f.root), row = checkpoint({ state: "issuing", entry_key: "1".repeat(32), intent: 1,
    delegate_in: delegate, fee_rate: 1 });
  put(k.database, row); k.journal.append(row);
  await using(k, controller => Effect.gen(function* () {
    assert.equal((yield* controller.batch("b1")).state, "issuing"); assert.equal((yield* controller.alerts()).length, 0);
  }));
  k.journal.append({ ...row, attempted: 1 });
  await using(k, controller => Effect.gen(function* () { assert.equal((yield* controller.batch("b1")).state, "broadcast_uncertain"); }));
});

test("TypeScript controller refuses conflicting identity, missing batches and unfinished host restore without native calls", async (t) => {
  for (const conflict of ["root", "members", "entry", "intent", "missing", "restore"] as const) {
    const f = fixture(t), k = kernel(f.root), row = checkpoint({ state: "issuing", entry_key: "1".repeat(32), intent: 1,
      delegate_in: delegate, fee_rate: 1 }); put(k.database, row);
    let newer = { ...row };
    if (conflict === "root") newer.root = "b".repeat(64);
    if (conflict === "members") newer.members = ["o1"];
    if (conflict === "entry") newer.entry_key = "2".repeat(32);
    if (conflict === "intent") newer.fee_rate = 2;
    if (conflict === "missing") newer = { ...row, bid: "b2" };
    k.journal.append(newer);
    if (conflict === "restore") {
      const db = new DatabaseSync(k.database); db.exec("insert into recoveries(restored_at) values(1)"); db.close();
    }
    await assert.rejects(using(k, controller => controller.batch("b1")), /differs|restore required/);
    assert.equal(local(k.database).state, "issuing"); assert.equal(k.calls.broadcasts, 0);
  }
});
